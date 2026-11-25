import { createDiscordReadService, readDiscordReadConfig } from './mcp-discord-read.js';
import {
  TASK_SWEEP_ARCHIVE_PAGE_SIZE,
  TASK_SWEEP_MAX_ARCHIVE_PAGES,
  TASK_SWEEP_MAX_WRITES,
  TASK_SWEEP_RETRY_DEFAULT_MS,
  TASK_SWEEP_RETRY_MAX_MS,
  createDiscordWriteService,
  readDiscordWriteConfig,
} from './mcp-discord-write.js';
import { DiscordRequest } from './utils.js';
import { audit } from './audit-log.js';

export const TASK_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

function writeServiceFor(env, request) {
  const readConfig = readDiscordReadConfig(env);
  const config = readDiscordWriteConfig(env, readConfig);
  if (!config.valid) return null;
  return {
    config,
    service: createDiscordWriteService({ config, request,
      readService: createDiscordReadService({ config: readConfig, request }),
      logger: { info() {} },
    }),
  };
}

function scopedToTaskForum(config, guildId, parentId) {
  return config.guildIds.has(guildId) && config.parentChannelIds.has(parentId);
}

// Reconciliação do fórum de tarefas: uma passada a cada READY (inclusive nas
// reconexões) e um timer de 6 h criado uma única vez por processo.
// Uma varredura por chamada, o timer nunca duplica; nenhum erro da varredura
// sobe para o dispatcher do Gateway.
let taskSweepTimer = null;

export function runTaskSweep(runner) {
  void Promise.resolve().then(runner).catch(() => {});
}

export function scheduleTaskSweep(runner, { setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  if (!taskSweepTimer) {
    taskSweepTimer = setIntervalImpl(() => runTaskSweep(runner), TASK_SWEEP_INTERVAL_MS);
    taskSweepTimer.unref?.();
  }
  runTaskSweep(runner);
  return taskSweepTimer;
}

export function stopTaskSweep({ clearIntervalImpl = clearInterval } = {}) {
  if (!taskSweepTimer) return false;
  clearIntervalImpl(taskSweepTimer);
  taskSweepTimer = null;
  return true;
}

// THREAD_CREATE can also mean newly visible. Only newly_created represents creation.
export async function handleTaskThreadCreate(thread, { env = process.env, request = DiscordRequest, logger = audit } = {}) {
  try {
    if (thread?.newly_created !== true || thread?.type !== 11) return;
    const readConfig = readDiscordReadConfig(env);
    const config = readDiscordWriteConfig(env, readConfig);
    if (!config.valid || !config.guildIds.has(thread.guild_id) || !config.parentChannelIds.has(thread.parent_id)) return;
    const service = createDiscordWriteService({ config, request,
      readService: createDiscordReadService({ config: readConfig, request }),
      // The Gateway emits one metadata-only audit entry below.
      logger: { info() {} },
    });
    const result = await service.ensureInitialIssueThreadState(thread.id);
    logger.info({ subsystem: 'gateway', event: 'task_thread_initial_state',
      guild_id: thread.guild_id, channel_id: thread.parent_id, thread_id: thread.id,
      outcome: result.status === 'ok' ? 'ok' : 'error',
      error_code: result.status === 'ok' ? undefined : 'task_tag_failed',
    });
  } catch {
    // Never propagate Discord errors, raw payloads or error messages to the dispatcher.
    try { logger.error({ subsystem: 'gateway', event: 'task_thread_initial_state',
      outcome: 'error', error_code: 'task_tag_failed' }); } catch { /* audit is best effort */ }
  }
}

// Re-read Discord under the same per-thread lock as the authenticated tag route.
// Idempotent: the terminal state (Concluído + archived + locked, including the
// events emitted by Botélia's own writes) never writes again, so own events
// cannot loop. A verified human reopen changes the state to Em andamento.
// Manual archive without Concluído concludes+locks; auto-archive
// reopens keeping tags; missing audit permission falls back to closing Concluído.
export async function handleTaskThreadUpdate(thread, { env = process.env, request = DiscordRequest, logger = audit, now = Date.now() } = {}) {
  try {
    if (thread?.type !== 11 || (thread.thread_metadata?.archived === true && thread.thread_metadata?.locked === true)) return;
    // An explicitly empty tag list cannot contain Concluído. Omitted tags may be a partial event.
    if (Array.isArray(thread.applied_tags) && thread.applied_tags.length === 0) return;
    const found = writeServiceFor(env, request);
    if (!found || !scopedToTaskForum(found.config, thread.guild_id, thread.parent_id)) return;
    const result = await found.service.reconcileTaskThread(thread.id, { mode: 'live', now });
    if (result.reopen_audit_unavailable) {
      logger.info({ subsystem: 'gateway', event: 'task_thread_reopen_check',
        guild_id: thread.guild_id, channel_id: thread.parent_id, thread_id: thread.id,
        outcome: 'skipped', error_code: 'audit_log_unavailable' });
    }
    // Um no-op bem-sucedido não é recibo — exceto o arquivamento antigo sem
    // evidência, que precisa ficar registrado para não parecer esquecimento.
    if (result.status === 'ok' && result.changed !== true) {
      if (result.skipped === 'no_manual_evidence') {
        logger.info({ subsystem: 'gateway', event: 'task_thread_auto_reopen',
          guild_id: thread.guild_id, channel_id: thread.parent_id, thread_id: thread.id,
          outcome: 'skipped', error_code: 'no_manual_evidence' });
      }
      return;
    }
    const event = result.action === 'manual_reopen' ? 'task_thread_manual_reopen'
      : result.action === 'manual_close' ? 'task_thread_manual_close'
      : result.action === 'auto_reopen' ? 'task_thread_auto_reopen'
        : 'task_thread_completed_close';
    logger.info({ subsystem: 'gateway', event,
      guild_id: thread.guild_id, channel_id: thread.parent_id, thread_id: thread.id,
      outcome: result.status === 'ok' ? 'ok' : 'error',
      error_code: result.status === 'ok' ? undefined
        : result.error === 'audit_log_unavailable' ? 'audit_log_unavailable' : 'task_close_failed' });
  } catch {
    try { logger.error({ subsystem: 'gateway', event: 'task_thread_completed_close', outcome: 'error', error_code: 'task_close_failed' }); } catch { /* best effort */ }
  }
}

function sweepRetryDelayMs(error) {
  const candidates = [
    error?.retry_after,
    error?.retryAfter,
    error?.body?.retry_after,
    error?.data?.retry_after,
  ];
  for (const candidate of candidates) {
    const seconds = Number(candidate);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.floor(seconds * 1000), TASK_SWEEP_RETRY_MAX_MS);
    }
  }
  return TASK_SWEEP_RETRY_DEFAULT_MS;
}

async function sweepSleep(ms, sleep) {
  if (typeof sleep === 'function') await sleep(ms);
  else await new Promise((resolve) => setTimeout(resolve, ms));
}

// Varredura de reconciliação: ativos + arquivados paginados do fórum.
// Concluído destrancado/aberto → aceita reabertura humana comprovada ou fecha;
// fechado sem Concluído só
// conclui com evidência manual (sem evidência, só registra — nunca reabre
// tópico antigo). Limite de escritas por varredura; 429 pausa e repete uma vez.
export async function reconcileTaskForum({ env = process.env, request = DiscordRequest, logger = audit,
  sleep, now = Date.now(), maxWrites = TASK_SWEEP_MAX_WRITES } = {}) {
  const found = writeServiceFor(env, request);
  if (!found) return { status: 'skipped', reason: 'not_configured' };
  const { config, service } = found;
  // Escopo único por configuração: `readDiscordWriteConfig` recusa mais de um
  // guild e mais de um fórum (`single_target_required`) e o serviço de escrita é
  // construído para esse par. Multi-alvo exigiria um serviço por par.
  const guildId = [...config.guildIds][0];
  const parentId = [...config.parentChannelIds][0];

  const getJson = async (endpoint) => (await request(endpoint, { method: 'GET', sensitiveErrors: true })).json();
  const withRetryOnce = async (fn) => {
    try {
      return await fn();
    } catch (error) {
      if (Number(error?.status) !== 429) throw error;
      await sweepSleep(sweepRetryDelayMs(error), sleep);
      return await fn();
    }
  };

  let threads;
  try {
    const active = await withRetryOnce(() => getJson(`guilds/${guildId}/threads/active`));
    threads = Array.isArray(active?.threads) ? [...active.threads] : [];
    let before;
    for (let page = 0; page < TASK_SWEEP_MAX_ARCHIVE_PAGES; page += 1) {
      const query = new URLSearchParams({ limit: String(TASK_SWEEP_ARCHIVE_PAGE_SIZE) });
      if (before) query.set('before', before);
      const body = await withRetryOnce(() => getJson(`channels/${parentId}/threads/archived/public?${query}`));
      const batch = Array.isArray(body?.threads) ? body.threads : [];
      threads.push(...batch);
      if (!body?.has_more || batch.length === 0) break;
      before = batch.at(-1)?.thread_metadata?.archive_timestamp;
      if (!before) throw new Error('invalid_discord_response');
    }
  } catch {
    try { logger.error({ subsystem: 'gateway', event: 'task_thread_sweep', guild_id: guildId, channel_id: parentId, outcome: 'error', error_code: 'sweep_list_failed' }); } catch { /* best effort */ }
    return { status: 'error', error: 'sweep_list_failed' };
  }

  const seen = new Set();
  let fixed = 0;
  let capped = false;
  for (const thread of threads) {
    const threadId = thread?.id;
    if (typeof threadId !== 'string' || seen.has(threadId)) continue;
    seen.add(threadId);
    if (thread?.parent_id !== parentId || thread?.type !== 11) continue;
    if (fixed >= maxWrites) { capped = true; break; }
    let result;
    try {
      result = await service.reconcileTaskThread(threadId, { mode: 'sweep', now });
    } catch {
      continue;
    }
    // 429 pausa e repete uma vez (o request simulado e o real sinalizam status).
    if (result.status === 'error' && result.error === 'discord_http_429') {
      await sweepSleep(TASK_SWEEP_RETRY_DEFAULT_MS, sleep);
      try {
        result = await service.reconcileTaskThread(threadId, { mode: 'sweep', now });
      } catch {
        continue;
      }
    }
    try {
      if (result.reopen_audit_unavailable) {
        logger.info({ subsystem: 'gateway', event: 'task_thread_reopen_check',
          guild_id: guildId, channel_id: parentId, thread_id: threadId,
          outcome: 'skipped', error_code: 'audit_log_unavailable' });
      }
      if (result.status === 'ok' && result.changed === true) {
        fixed += 1;
        logger.info({ subsystem: 'gateway', event: 'task_thread_sweep',
          guild_id: guildId, channel_id: parentId, thread_id: threadId, outcome: 'ok' });
      } else if (result.status === 'ok' && result.skipped === 'no_manual_evidence') {
        logger.info({ subsystem: 'gateway', event: 'task_thread_sweep',
          guild_id: guildId, channel_id: parentId, thread_id: threadId, outcome: 'skipped' });
      } else if (result.status !== 'ok') {
        logger.error({ subsystem: 'gateway', event: 'task_thread_sweep',
          guild_id: guildId, channel_id: parentId, thread_id: threadId, outcome: 'error',
          error_code: result.error === 'audit_log_unavailable' ? 'audit_log_unavailable' : 'sweep_fix_failed' });
      }
    } catch { /* audit is best effort */ }
  }

  try {
    logger.info({ subsystem: 'gateway', event: 'task_thread_sweep',
      guild_id: guildId, channel_id: parentId,
      outcome: capped ? 'capped' : 'ok',
      error_code: capped ? 'sweep_write_limit' : undefined });
  } catch { /* best effort */ }
  return { status: 'ok', checked: seen.size, fixed, capped };
}
