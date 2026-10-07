import Anthropic from "@anthropic-ai/sdk";

// Provider layer. Anthropic uses its SDK; everything else speaks the OpenAI-compatible
// /chat/completions protocol. Default models are suggestions — users can pick any model their
// account can use (the connection test and the model list tell them which ones work).
// This file never touches the database or request objects, so API keys only live in memory here.
export const PROVIDERS = {
  anthropic: { label: "Anthropic (Claude)", short: "Claude", model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5" },
  openai: { label: "OpenAI", short: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", tokenParam: "max_completion_tokens" },
  gemini: { label: "Google Gemini", short: "Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash" },
  deepseek: { label: "DeepSeek", short: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  qwen: { label: "Alibaba Qwen (DashScope Intl)", short: "Qwen", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  groq: { label: "Groq", short: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  openrouter: { label: "OpenRouter (any model)", short: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
  custom: { label: "Custom (OpenAI-compatible URL)", short: "Custom", baseUrl: "", model: "", custom: true },
};

export function publicProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, short: p.short, model: p.model, custom: !!p.custom }));
}

// A key in .env is a convenience for running locally only. When the app listens on a public address
// (HOST=0.0.0.0, i.e. hosted for other people) it is ignored, so nobody can spend the owner's key.
// Set ALLOW_SERVER_KEY=1 to override on purpose.
export const SERVER_KEY_OK = process.env.ALLOW_SERVER_KEY === "1" || (process.env.HOST || "127.0.0.1") === "127.0.0.1";

// Reject obviously unsafe custom base URLs (server-side request forgery guard).
// Set ALLOW_LOCAL_LLM=1 to allow http://localhost (e.g. Ollama) when running locally.
export function checkBaseUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw Object.assign(new Error("Invalid base URL"), { status: 400 });
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  const privateIp = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(u.hostname);
  if (local && process.env.ALLOW_LOCAL_LLM === "1") return u.href.replace(/\/$/, "");
  if (u.protocol !== "https:" || local || privateIp)
    throw Object.assign(new Error("Custom base URL must be a public https:// address"), { status: 400 });
  return u.href.replace(/\/$/, "");
}

// Build a validated config. apiKey is only ever held in memory for the duration of a request.
export function makeCfg({ provider, model, apiKey, baseUrl }) {
  const p = PROVIDERS[provider];
  if (!p) throw Object.assign(new Error("Unknown provider"), { status: 400 });
  const key = String(apiKey || "").trim();
  if (!key && !(p.custom && process.env.ALLOW_LOCAL_LLM === "1"))
    throw Object.assign(new Error(`Please enter your ${p.label} API key.`), { status: 400 });
  const m = String(model || p.model).trim();
  if (!m) throw Object.assign(new Error("Please enter a model name."), { status: 400 });
  return {
    provider, label: p.label, short: p.short, apiKey: key, model: m,
    baseUrl: p.custom ? checkBaseUrl(String(baseUrl || "")) : p.baseUrl,
    tokenParam: p.tokenParam || "max_tokens",
  };
}

// Remove anything that looks like an API key from text before it is shown or logged.
export function redact(text, ...secrets) {
  let s = String(text ?? "");
  for (const k of secrets) if (k && String(k).length >= 8) s = s.split(String(k)).join("[redacted]");
  return s
    .replace(/\b(sk-[A-Za-z0-9_\-*]{8,}|AIza[0-9A-Za-z_\-*]{16,}|gsk_[A-Za-z0-9*]{12,}|xai-[A-Za-z0-9*]{12,})/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._\-*]{12,}/gi, "Bearer [redacted]");
}

// Async generator yielding text chunks.
// `info` (optional) is filled in: info.truncated = true when the model hit its output limit.
// "none" turns thinking off (Flash models); Pro models can't be switched off, so they get the lowest setting.
function geminiEffort(cfg) {
  if (cfg.provider !== "gemini") return null;
  const m = String(cfg.model).toLowerCase();
  if (!/gemini-(2\.5|3)/.test(m)) return null;
  return /pro/.test(m) ? "low" : "none";
}
export async function* streamChat(cfg, { system, user, maxTokens, info = {} }) {
  if (cfg.provider === "anthropic") {
    const client = new Anthropic({ apiKey: cfg.apiKey });
    const stream = client.messages.stream({
      model: cfg.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    });
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield ev.delta.text;
    }
    info.truncated = (await stream.finalMessage()).stop_reason === "max_tokens";
    return;
  }

  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });
  const post = (extra) =>
    fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey && { Authorization: `Bearer ${cfg.apiKey}` }),
      },
      body: JSON.stringify({ model: cfg.model, messages, stream: true, [cfg.tokenParam]: maxTokens, ...extra }),
    });
  // Gemini 2.5+ "thinks" before answering, and those hidden thinking tokens are counted against the output limit —
  // so a 3000-token limit can be used up before the explanation has really started. Keep the thinking minimal.
  const effort = geminiEffort(cfg);
  let res = await post(effort ? { reasoning_effort: effort } : {});
  if (!res.ok && effort && res.status === 400) res = await post({}); // this model rejects the setting: send it without
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).slice(0, 300);
    throw Object.assign(new Error(`${cfg.label} error ${res.status}: ${body}`), { status: res.status });
  }
  const dec = new TextDecoder();
  let buf = "";
  let finished = false; // saw [DONE] or a finish_reason
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        continue; // keep-alive / partial JSON
      }
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error).slice(0, 200));
      const choice = j.choices?.[0];
      if (choice?.delta?.content) yield choice.delta.content;
      if (choice?.finish_reason) {
        finished = true;
        if (choice.finish_reason === "length") info.truncated = true;
      }
    }
  }
  // The connection ended without a clean finish: don't silently present half an answer as complete.
  if (!finished) throw new Error("The AI connection was cut off before the answer finished.");
}

export async function chat(cfg, opts) {
  let out = "";
  for await (const t of streamChat(cfg, opts)) out += t;
  return out;
}

export function friendlyError(e, cfg) {
  const label = cfg?.label || "AI";
  if (e?.status === 401 || e?.status === 403) return `Your ${label} API key was rejected. Check it in AI settings.`;
  if (e?.status === 429) return `Rate limit or no credit on your ${label} account.`;
  return redact(e?.message || "Unknown error", cfg?.apiKey);
}

/* ---------- connection test & model discovery ---------- */

const TEST_TIMEOUT_MS = 20_000;

function testErrorMessage(e, cfg) {
  const s = e?.status;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return `Timed out after ${TEST_TIMEOUT_MS / 1000}s — the provider did not answer.`;
  if (s === 401 || s === 403) return `${cfg.short || cfg.label} rejected the API key.`;
  if (s === 404) return `Model "${cfg.model}" was not found for this account.`;
  if (s === 429) return `${cfg.short || cfg.label} accepted the key but is rate-limiting it, or the account is out of credit.`;
  if (!s && /fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ECONNRESET/i.test(String(e?.message + " " + e?.cause?.code))) return "Could not reach the provider. Check the base URL and your network.";
  return redact(String(e?.message || "Connection failed").slice(0, 220), cfg.apiKey);
}

// Sends one tiny request with the exact provider + model + key. Returns { ok, ms, error? }.
export async function testConnection(cfg) {
  const t0 = Date.now();
  const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
  try {
    if (cfg.provider === "anthropic") {
      const client = new Anthropic({ apiKey: cfg.apiKey, maxRetries: 0 });
      await client.messages.create({ model: cfg.model, max_tokens: 8, messages: [{ role: "user", content: "Reply with: ok" }] }, { signal });
    } else {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(cfg.apiKey && { Authorization: `Bearer ${cfg.apiKey}` }) },
        body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: "Reply with: ok" }], [cfg.tokenParam]: 16 }),
        signal,
      });
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        throw Object.assign(new Error(`HTTP ${res.status}: ${body}`), { status: res.status });
      }
      await res.json();
    }
    return { ok: true, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: testErrorMessage(e, cfg), status: e?.status };
  }
}

// Best effort: the models this key can actually use, so the user can pick from a real list.
export async function discoverModels(cfg) {
  try {
    const signal = AbortSignal.timeout(8000);
    let ids = [];
    if (cfg.provider === "anthropic") {
      const client = new Anthropic({ apiKey: cfg.apiKey, maxRetries: 0 });
      const page = await client.models.list({ limit: 100 }, { signal });
      ids = (page.data || []).map((m) => m.id);
    } else {
      const res = await fetch(`${cfg.baseUrl}/models`, { headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}, signal });
      if (!res.ok) return [];
      ids = ((await res.json()).data || []).map((m) => String(m.id || "").replace(/^models\//, ""));
    }
    return [...new Set(ids.filter((id) => id && !/embed|whisper|tts|dall-e|moderation|transcribe|realtime|audio|image|vision-preview/i.test(id)))].sort().slice(0, 200);
  } catch {
    return [];
  }
}
