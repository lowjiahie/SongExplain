import express from "express";
import * as db from "./db.js";
import * as secrets from "./secrets.js";
import * as auth from "./auth.js";
import { PROVIDERS, SERVER_KEY_OK, makeCfg, testConnection, discoverModels, redact } from "./llm.js";

// API keys live ONLY here, on the server, encrypted at rest (secrets.js). They are:
//   - never sent to the browser (the UI gets a hint like ••••abcd and nothing else),
//   - never accepted from request headers or query strings,
//   - never written to logs, and scrubbed from error messages before they are returned.
// Each user can only use their own saved connections.

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// Which AI to use for a request: the user's chosen connected model (header x-model-id).
export function llmConfig(req) {
  // "Don't save" mode: the key arrives with this one request, is used, and is forgotten. It is never
  // stored or logged; it only exists in memory for the duration of the request.
  const sessionKey = req.get("x-ai-key");
  if (sessionKey) {
    return makeCfg({
      provider: String(req.get("x-ai-provider") || ""),
      model: req.get("x-ai-model"),
      apiKey: cleanKey(sessionKey),
      baseUrl: req.get("x-ai-base") || "",
    });
  }
  const id = Number(req.get("x-model-id"));
  if (id && req.user) {
    const m = db.getAiModel(req.user.id, id);
    if (!m) throw Object.assign(new Error("That AI model is no longer connected. Choose another one."), { status: 404, code: "NO_AI" });
    if (m.status !== "ok") throw Object.assign(new Error("That model has not passed the connection test. Open AI settings and test it."), { status: 409, code: "NO_AI" });
    const row = db.getAiKeyRow(req.user.id, m.provider);
    if (!row) throw Object.assign(new Error("The API key for that model was removed. Add it again in AI settings."), { status: 404, code: "NO_AI" });
    return makeCfg({ provider: m.provider, model: m.model, apiKey: secrets.decrypt(req.user.id, m.provider, row.key_enc), baseUrl: row.base_url });
  }
  // Local convenience only: a key in .env (ignored automatically on public hosts, see llm.js).
  if (SERVER_KEY_OK && process.env.ANTHROPIC_API_KEY)
    return makeCfg({ provider: "anthropic", model: PROVIDERS.anthropic.model, apiKey: process.env.ANTHROPIC_API_KEY });
  throw Object.assign(new Error("Connect an AI model first — open AI settings."), { status: 400, code: "NO_AI" });
}

// The YouTube key for this request: a one-request "don't save" key from the header, else the saved one.
export function youtubeKey(req) {
  const fromHeader = req.get("x-yt-key");
  if (fromHeader) return cleanKey(fromHeader);
  const row = db.getAiKeyRow(req.user.id, "youtube");
  return row ? secrets.decrypt(req.user.id, "youtube", row.key_enc) : null;
}

const cleanKey = (k) => {
  const key = String(k ?? "").trim();
  if (!key) return "";
  if (key.length < 8 || key.length > 400 || /[\s\u0000-\u001f]/.test(key)) throw Object.assign(new Error("That does not look like an API key (no spaces, 8–400 characters)."), { status: 400 });
  return key;
};

const modelPublic = (m) => ({
  id: m.id, provider: m.provider, label: PROVIDERS[m.provider]?.short || m.provider, model: m.model,
  status: m.status, error: m.error, testedAt: m.tested_at,
});

// Resolve provider + model + key (new key from the request, or the saved one) into a config.
function resolve(req) {
  const provider = String(req.body?.provider || "");
  if (!PROVIDERS[provider]) throw Object.assign(new Error("Unknown provider"), { status: 400 });
  const row = db.getAiKeyRow(req.user.id, provider);
  const newKey = cleanKey(req.body?.apiKey);
  const apiKey = newKey || (row ? secrets.decrypt(req.user.id, provider, row.key_enc) : "");
  const customBase = PROVIDERS[provider].custom ? String(req.body?.baseUrl || row?.base_url || "") : "";
  const cfg = makeCfg({ provider, model: req.body?.model, apiKey, baseUrl: customBase });
  return { cfg, newKey, customBase };
}

export const aiRouter = express.Router();
const testLimit = auth.rateLimit({ windowMs: 10 * 60_000, max: 25, by: "user", message: "Too many connection tests. Wait a few minutes." });

aiRouter.use((_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

// Everything the settings screen and the model picker need. Never contains a key.
aiRouter.get("/", (req, res) => {
  const uid = req.user.id;
  res.json({
    keys: db.listAiKeys(uid).filter((k) => k.provider !== "youtube").map((k) => ({ provider: k.provider, hint: k.hint, baseUrl: k.base_url })),
    models: db.listAiModels(uid).map(modelPublic),
    youtube: db.getAiKeyRow(uid, "youtube") ? { hint: db.getAiKeyRow(uid, "youtube").hint } : null,
    serverKey: SERVER_KEY_OK && !!process.env.ANTHROPIC_API_KEY, // local convenience key available
  });
});

// Test without saving anything. If it works, also list the models this key can use.
aiRouter.post("/test", testLimit, async (req, res) => {
  try {
    const { cfg } = resolve(req);
    const r = await testConnection(cfg);
    res.json({ ...r, models: r.ok || r.status === 404 ? await discoverModels(cfg) : [] });
  } catch (e) {
    bad(res, redact(e.message), e.status || 400);
  }
});

// Test, and only if it works save the key (encrypted) and mark the model as connected.
aiRouter.post("/connect", testLimit, async (req, res) => {
  try {
    const { cfg, newKey, customBase } = resolve(req);
    const r = await testConnection(cfg);
    if (!r.ok) return res.json({ ok: false, error: r.error, ms: r.ms, models: r.status === 404 ? await discoverModels(cfg) : [] });
    const uid = req.user.id;
    if (newKey) db.setAiKey(uid, cfg.provider, secrets.encrypt(uid, cfg.provider, newKey), secrets.keyHint(newKey), customBase);
    else if (customBase && PROVIDERS[cfg.provider].custom) {
      const row = db.getAiKeyRow(uid, cfg.provider);
      if (row) db.setAiKey(uid, cfg.provider, row.key_enc, row.hint, customBase);
    }
    const m = db.upsertAiModel(uid, cfg.provider, cfg.model, "ok", null);
    res.json({ ok: true, ms: r.ms, model: modelPublic(m) });
  } catch (e) {
    bad(res, redact(e.message), e.status || 400);
  }
});

aiRouter.post("/models/:id/test", testLimit, async (req, res) => {
  try {
    const uid = req.user.id, m = db.getAiModel(uid, Number(req.params.id));
    if (!m) return bad(res, "Model not found", 404);
    const row = db.getAiKeyRow(uid, m.provider);
    if (!row) return bad(res, "The key for this model was removed.", 404);
    const cfg = makeCfg({ provider: m.provider, model: m.model, apiKey: secrets.decrypt(uid, m.provider, row.key_enc), baseUrl: row.base_url });
    const r = await testConnection(cfg);
    db.setAiModelStatus(uid, m.id, r.ok ? "ok" : "failed", r.ok ? null : r.error);
    res.json({ ok: r.ok, ms: r.ms, error: r.error, model: modelPublic(db.getAiModel(uid, m.id)) });
  } catch (e) {
    bad(res, redact(e.message), e.status || 400);
  }
});

aiRouter.delete("/models/:id", (req, res) => {
  db.deleteAiModel(req.user.id, Number(req.params.id));
  res.json({ ok: true });
});

// Remove a saved key and every model that used it.
aiRouter.delete("/keys/:provider", (req, res) => {
  if (!PROVIDERS[req.params.provider]) return bad(res, "Unknown provider", 404);
  db.deleteAiKey(req.user.id, req.params.provider);
  res.json({ ok: true });
});

/* ---------- YouTube Data API key (for YouTube comments) ---------- */
aiRouter.put("/youtube", testLimit, async (req, res) => {
  try {
    const key = cleanKey(req.body?.apiKey);
    if (!key) return bad(res, "Enter your YouTube Data API key.");
    const r = await fetch(`https://www.googleapis.com/youtube/v3/i18nLanguages?part=snippet&hl=en&${new URLSearchParams({ key })}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      return res.json({ ok: false, error: redact(j.error?.message || `YouTube answered HTTP ${r.status}`, key).slice(0, 200) });
    }
    // save:false = just verify it (the page then keeps the key in memory for this session only)
    if (req.body?.save !== false) db.setAiKey(req.user.id, "youtube", secrets.encrypt(req.user.id, "youtube", key), secrets.keyHint(key), null);
    res.json({ ok: true, hint: secrets.keyHint(key), saved: req.body?.save !== false });
  } catch (e) {
    bad(res, redact(e.message), e.status || 400);
  }
});
aiRouter.delete("/youtube", (req, res) => {
  db.deleteAiKey(req.user.id, "youtube");
  res.json({ ok: true });
});
