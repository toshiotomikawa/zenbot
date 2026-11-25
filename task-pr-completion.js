import { createDiscordReadService, readDiscordReadConfig } from './mcp-discord-read.js';
import { createDiscordWriteService, readDiscordWriteConfig } from './mcp-discord-write.js';
import { DiscordRequest } from './utils.js';
import { audit } from './audit-log.js';

const SNOWFLAKE = /^\d{17,20}$/;
export const TASK_REPORT_CHANNEL = String(process.env.TASK_REPORT_CHANNEL_ID ?? '').trim();
const WEEK = 7 * 24 * 60 * 60 * 1000;

export function completionLinks(body) {
  return [...new Set((typeof body === 'string' ? body : '').split(/\r?\n/)
    .filter(line => line.startsWith('Conclui:')).map(line => line.slice(8).trim()))]
    .map(value => /^https:\/\/discord\.com\/channels\/(\d{17,20})\/(\d{17,20})$/.exec(value))
    .map(match => match ? { guild: match[1], thread: match[2] } : null);
}

export function createTaskPrCompletion({ env = process.env, request = DiscordRequest, fetchImpl = fetch, logger = audit } = {}) {
  const readConfig = readDiscordReadConfig(env);
  const config = readDiscordWriteConfig(env, readConfig);
  if (!config.valid) return null;
  const repo = String(env.TASK_PR_REPO ?? [...config.repos][0] ?? '').trim();
  const reportChannel = String(env.TASK_REPORT_CHANNEL_ID ?? '').trim();
  if (!repo || !config.repos.has(repo.toLowerCase())) return null;
  const guild = [...config.guildIds][0];
  const forum = [...config.parentChannelIds][0];
  const service = createDiscordWriteService({ config, request,
    readService: createDiscordReadService({ config: readConfig, request }), logger: { info() {} } });
  const get = async endpoint => (await request(endpoint, { method: 'GET', sensitiveErrors: true })).json();
  const log = (outcome, error_code, thread_id) => logger.info({ subsystem: 'github',
    event: 'task_pr_completion', outcome, error_code, thread_id });
  async function handleMerge(body) {
    const pr = body?.pull_request;
    if (String(body?.repository?.full_name ?? '').toLowerCase() !== repo.toLowerCase() || body.action !== 'closed' || pr?.merged !== true) return;
    let failed = false;
    for (const link of completionLinks(pr.body)) {
      if (!link || link.guild !== guild) { log('ignored', 'invalid_completion_link'); continue; }
      const result = await service.completeTaskFromPr({ thread_id: link.thread, number: pr.number, repo });
      const outside = result.reason === 'outside_write_allowlist';
      log(outside ? 'ignored' : result.status === 'ok' ? 'ok' : 'error', result.error ?? result.reason, link.thread);
      if (result.status !== 'ok' && !outside) failed = true;
    }
    if (failed) throw new Error('task_completion_failed');
  }
  async function mergedPrs() {
    const prs = [];
    for (let page = 1; page <= 100; page++) {
      const response = await fetchImpl(`https://api.github.com/repos/${repo}/pulls?state=closed&per_page=100&page=${page}`, {
        headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) throw new Error('github_scan_failed');
      const batch = await response.json();
      if (!Array.isArray(batch)) throw new Error('invalid_github_response');
      prs.push(...batch.filter(pr => pr.merged_at));
      if (batch.length < 100) return prs;
    }
    throw new Error('github_scan_limit');
  }
  async function report(now = Date.now()) {
    if (!SNOWFLAKE.test(reportChannel)) throw new Error('invalid_report_channel');
    const parent = await get(`channels/${forum}`);
    if (parent.id !== forum || parent.guild_id !== guild || parent.type !== 15) throw new Error('invalid_task_forum');
    const done = parent.available_tags?.filter(tag => tag.name === 'Concluído');
    if (done?.length !== 1) throw new Error('invalid_done_tag');
    const destination = await get(`channels/${reportChannel}`);
    if (destination.id !== reportChannel || destination.guild_id !== guild || destination.type !== 0) throw new Error('invalid_report_channel');
    const active = await get(`guilds/${guild}/threads/active`);
    if (!Array.isArray(active.threads)) throw new Error('invalid_thread_list');
    const threads = [...active.threads];
    let before = '';
    for (let page = 0; page < 100; page++) {
      const archive = await get(`channels/${forum}/threads/archived/public?limit=100${before ? `&before=${encodeURIComponent(before)}` : ''}`);
      if (!Array.isArray(archive.threads)) throw new Error('invalid_thread_list');
      threads.push(...archive.threads);
      if (!archive.has_more) break;
      const next = archive.threads.at(-1)?.thread_metadata?.archive_timestamp;
      if (!next || next === before || page === 99) throw new Error('archive_scan_limit');
      before = next;
    }
    const referenced = new Set((await mergedPrs()).flatMap(pr => completionLinks(pr.body))
      .filter(link => link?.guild === guild).map(link => link.thread));
    const items = [];
    for (const thread of new Map(threads.map(t => [t.id, t])).values()) {
      if (thread.guild_id !== guild || thread.parent_id !== forum || thread.type !== 11
        || !Array.isArray(thread.applied_tags) || thread.applied_tags.includes(done[0].id)) continue;
      const messages = await get(`channels/${thread.id}/messages?limit=1`);
      if (!Array.isArray(messages)) throw new Error('invalid_message_list');
      const last = messages[0]?.timestamp;
      const created = Number((BigInt(thread.id) >> 22n) + 1420070400000n);
      const stale = now - (last ? Date.parse(last) : created) > WEEK;
      const reasons = [referenced.has(thread.id) ? 'PR mergeada pendente de conclusão' : '', stale ? 'sem mensagem há mais de 7 dias' : ''].filter(Boolean);
      if (reasons.length) items.push(`• https://discord.com/channels/${guild}/${thread.id} — ${reasons.join('; ')}`);
    }
    if (!items.length) return { posted: 0, items: 0 };
    const chunks = [];
    let content = 'Tópicos de tarefas pendentes:\n';
    for (const item of items) {
      if (content.length + item.length + 1 > 2000) { chunks.push(content); content = 'Tópicos de tarefas pendentes (continuação):\n'; }
      content += `${item}\n`;
    }
    chunks.push(content);
    for (const content of chunks) await request(`channels/${reportChannel}/messages`, {
      method: 'POST', sensitiveErrors: true, body: { content, allowed_mentions: { parse: [] } },
    });
    return { posted: chunks.length, items: items.length };
  }
  return { handleMerge, report };
}

export function scheduleTaskReport(service, { env = process.env, now = () => new Date(), setIntervalImpl = setInterval, logger = audit } = {}) {
  const time = env.TASK_REPORT_TIME ?? '09:00';
  if (!service || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const formatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  let lastDay;
  let running = false;
  const tick = async () => {
    const stamp = formatter.format(now());
    const day = stamp.slice(0, 10);
    if (running || stamp.slice(11, 16) !== time || lastDay === day) return;
    running = true; lastDay = day;
    try { await service.report(); } catch { logger.info({ subsystem: 'github', event: 'task_daily_report', outcome: 'error', error_code: 'task_report_failed' }); }
    finally { running = false; }
  };
  const timer = setIntervalImpl(tick, 30000);
  timer.unref?.();
  void tick();
  return timer;
}
