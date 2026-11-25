import { audit } from './audit-log.js';

const CONVERSATION_MODEL = 'openrouter/free';

export async function askConversation(prompt, systemInstruction) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { ok: false, reason: 'no-key' };
  const started = Date.now();
  const signal = AbortSignal.timeout(15_000);
  let result;
  let status;
  try {
    const messages = [];
    if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
    messages.push({ role: 'user', content: prompt });
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: CONVERSATION_MODEL, messages, max_tokens: 512, stream: false,
        reasoning: { enabled: false, exclude: true },
        provider: { data_collection: 'deny' },
      }),
      signal,
    });
    if (Number.isInteger(res.status) && res.status >= 100 && res.status <= 599) status = res.status;
    if (!res.ok) {
      // Never read/log a provider's error body; it may contain credentials or prompts.
      await res.body?.cancel().catch(() => {});
      const reason = status === 401 || status === 403 ? 'invalid-key'
        : status === 402 ? 'quota' : status === 429 ? 'rate-limited' : 'unavailable';
      return (result = { ok: false, reason });
    }
    const json = await res.json();
    if (!json || typeof json !== 'object' || Array.isArray(json) || json.error != null
      || !Array.isArray(json.choices) || !json.choices.length) {
      return (result = { ok: false, reason: 'invalid-response' });
    }
    const message = json.choices[0]?.message;
    if ((message?.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0))
      || typeof message?.content !== 'string') {
      return (result = { ok: false, reason: 'invalid-response' });
    }
    const text = message.content.trim();
    if (!text) return (result = { ok: false, reason: 'empty' });
    return (result = { ok: true, text });
  } catch (err) {
    return (result = { ok: false, reason: signal.aborted ? 'timeout'
      : err instanceof SyntaxError ? 'invalid-response' : 'network' });
  } finally {
    const meta = {
      subsystem: 'llm', provider: 'openrouter', action: 'conversation',
      requested_model: CONVERSATION_MODEL, status, elapsed_ms: Date.now() - started,
      outcome: result?.ok ? 'ok' : 'error', error_code: result?.ok ? undefined : result?.reason,
    };
    if (result?.ok) audit.info(meta);
    else audit.error(meta);
  }
}

async function auditedLlmFetch(provider, action, url, init) {
  const started = Date.now();
  try {
    const res = await fetch(url, init);
    const meta = {
      subsystem: 'llm',
      provider,
      action,
      status: res.status,
      elapsed_ms: Date.now() - started,
      outcome: res.ok ? 'ok' : 'error',
      error_code: res.ok ? undefined : 'http_error',
    };
    if (res.ok) audit.info(meta);
    else audit.error(meta);
    return res;
  } catch (err) {
    audit.error({
      subsystem: 'llm',
      provider,
      action,
      elapsed_ms: Date.now() - started,
      outcome: 'error',
      error_code: err?.name === 'AbortError' ? 'timeout' : 'network',
    });
    throw err;
  }
}

// OpenRouter status checks authentication/quota without inference.
export function formatLLMStatus(results) {
  const reasons = {
    'no-key': 'chave não configurada', quota: 'quota esgotada',
    'rate-limited': 'rate limit ativo', 'invalid-key': 'chave inválida', error: 'erro de conexão',
  };
  const fmt = (name, result) => {
    if (result?.ok) return `**${name}**: ✔`;
    const reason = reasons[result?.reason] ?? 'indisponível';
    return `**${name}**: ✘ (${reason})`;
  };
  const lines = [
    fmt('OpenRouter Free · conversa', results.openrouter),
  ];
  if (results.openrouter?.ok) {
    const remaining = results.openrouter.freeDailyRemaining;
    lines.push(`Autenticação válida; inferência não testada.${Number.isSafeInteger(remaining) && remaining >= 0 ? ` Quota gratuita restante: ${remaining}.` : ''}`);
  }
  return lines.join('\n');
}

export async function checkLLMStatus() {
  const results = {};

  // OpenRouter
  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) {
    results.openrouter = { ok: false, reason: 'no-key' };
  } else {
    try {
      const res = await auditedLlmFetch('openrouter', 'status', 'https://openrouter.ai/api/v1/key', {
        method: 'GET',
        headers: { Authorization: `Bearer ${orKey}` },
      });
      if (res.ok) {
        const json = await res.json();
        const data = json?.data;
        if (!json || typeof json !== 'object' || Array.isArray(json) || json.error != null
          || !data || typeof data !== 'object' || Array.isArray(data)
          || typeof data.is_free_tier !== 'boolean' || typeof data.usage !== 'number'
          || !Number.isFinite(data.usage) || data.usage < 0) {
          results.openrouter = { ok: false, reason: 'invalid-response' };
        } else {
          const quota = data.free_model_daily_requests;
          const freeDailyRemaining = Number.isSafeInteger(quota?.remaining) && quota.remaining >= 0
            ? quota.remaining : undefined;
          results.openrouter = { ok: true, model: CONVERSATION_MODEL, freeDailyRemaining, inferenceVerified: false };
        }
      } else {
        results.openrouter = { ok: false, reason: res.status === 401 || res.status === 403 ? 'invalid-key'
          : res.status === 402 ? 'quota' : res.status === 429 ? 'rate-limited' : 'unavailable' };
      }
    } catch {
      results.openrouter = { ok: false, reason: 'error' };
    }
  }

  return results;
}
