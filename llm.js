import Anthropic from "@anthropic-ai/sdk";

// Bring-your-own-key provider layer. Anthropic uses its SDK; everything else speaks the
// OpenAI-compatible /chat/completions protocol. Default models are suggestions — users can
// type any model id their account has access to.
export const PROVIDERS = {
  anthropic: { label: "Anthropic (Claude)", model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5" },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", tokenParam: "max_completion_tokens" },
  gemini: { label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash" },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  qwen: { label: "Alibaba Qwen (DashScope Intl)", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  groq: { label: "Groq", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  openrouter: { label: "OpenRouter (any model)", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
  custom: { label: "Custom (OpenAI-compatible URL)", baseUrl: "", model: "", custom: true },
};

export function publicProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    model: p.model,
    custom: !!p.custom,
  }));
}

// A key in .env is a convenience for running locally only. When the app listens on a public address
// (HOST=0.0.0.0, i.e. hosted for other people) it is ignored, so nobody can spend the owner's key.
// Set ALLOW_SERVER_KEY=1 to override on purpose.
const SERVER_KEY_OK = process.env.ALLOW_SERVER_KEY === "1" || (process.env.HOST || "127.0.0.1") === "127.0.0.1";

// Reject obviously unsafe custom base URLs (server-side request forgery guard).
// Set ALLOW_LOCAL_LLM=1 to allow http://localhost (e.g. Ollama) when running locally.
function checkBaseUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("Invalid base URL");
  }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  const privateIp = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(u.hostname);
  if (local && process.env.ALLOW_LOCAL_LLM === "1") return u.href.replace(/\/$/, "");
  if (u.protocol !== "https:" || local || privateIp)
    throw new Error("Custom base URL must be a public https:// address");
  return u.href.replace(/\/$/, "");
}

// Read settings from request headers (never body/query, so keys don't land in logs).
export function llmConfig(req) {
  const provider = String(req.get("x-provider") || "anthropic");
  const p = PROVIDERS[provider];
  if (!p) throw Object.assign(new Error("Unknown provider"), { status: 400 });
  const apiKey = String(
    req.get("x-api-key") || (provider === "anthropic" && SERVER_KEY_OK ? process.env.ANTHROPIC_API_KEY : "") || ""
  ).trim();
  if (!apiKey && !(p.custom && process.env.ALLOW_LOCAL_LLM === "1"))
    throw Object.assign(new Error(`Please enter your ${p.label} API key first.`), { status: 401 });
  const model = String(req.get("x-model") || p.model).trim();
  if (!model) throw Object.assign(new Error("Please enter a model name."), { status: 400 });
  const baseUrl = p.custom ? checkBaseUrl(String(req.get("x-base-url") || "")) : p.baseUrl;
  return { provider, label: p.label, apiKey, model, baseUrl, tokenParam: p.tokenParam || "max_tokens" };
}

// Async generator yielding text chunks.
// `info` (optional) is filled in: info.truncated = true when the model hit its output limit.
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
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey && { Authorization: `Bearer ${cfg.apiKey}` }),
    },
    body: JSON.stringify({ model: cfg.model, messages, stream: true, [cfg.tokenParam]: maxTokens }),
  });
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

export function friendlyError(e, label) {
  if (e?.status === 401 || e?.status === 403) return `Your ${label} API key was rejected. Please check it.`;
  if (e?.status === 429) return `Rate limit or no credit on your ${label} account.`;
  return e?.message || "Unknown error";
}
