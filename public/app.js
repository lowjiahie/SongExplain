const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const md = (t) => DOMPurify.sanitize(marked.parse(t));
const MOODS = ["nostalgic", "heartbreak", "hopeful", "angry", "grateful", "healing", "lonely", "joyful"];
const LANGS = ["English", "简体中文", "繁體中文"];
let me = null;          // signed-in user { id, email } or null
let regFull = false;    // the beta has reached MAX_USERS
let guideUrl = null, contactEmail = null;
let regMode = "open";   // open | invite | closed
// Only harmless preferences live in the browser (theme, language, which model you picked).
// API keys are not kept here in plain text: they are saved encrypted on the server, or — only if you choose "This device" — encrypted in this browser's IndexedDB (see AI settings).
const PER_USER = /^(activeModel|keyMode)$/;
const nk = (k) => (PER_USER.test(k) && me ? `u${me.id}:${k}` : k);
const store = {
  get(k) { try { return localStorage.getItem(nk(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(nk(k), v); } catch {} },
};
const hueOf = (s) => Math.abs([...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)) % 360;
const fmtDate = (s) => { try { return new Date(s.replace(" ", "T") + "Z").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch { return s; } };

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind; el.textContent = msg;
  const box = $("toasts");
  box.append(el);
  // re-open the popover so it is the newest thing in the top layer — above any dialog that is open right now
  try { box.hidePopover(); box.showPopover(); } catch {}
  setTimeout(() => el.remove(), kind === "err" ? 6000 : 3200);
}
function coverHTML(item) {
  const h = hueOf(item.title + item.artist);
  const initial = esc([...String(item.title)][0] || "♪");
  if (!item.cover) return `<div class="cov ph" style="--h:${h}"><span>${initial}</span></div>`;
  return `<div class="cov" style="--h:${h}"><img src="${esc(item.cover)}" alt="" loading="lazy" data-initial="${initial}"></div>`;
}

/* ---------- theme ---------- */
const ICON_MOON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z"/></svg>`;
const ICON_SUN = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>`;
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  // show the icon of the mode you will switch TO
  $("theme").innerHTML = t === "dark" ? ICON_SUN : ICON_MOON;
  $("theme").setAttribute("aria-label", t === "dark" ? "Switch to light mode" : "Switch to dark mode");
}
applyTheme(store.get("theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
$("theme").onclick = () => { const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; store.set("theme", t); applyTheme(t); };

/* ---------- AI connections ---------- */
// Two ways to use a key:
//  • Remember on the server — encrypted at rest; this page only ever sees a hint like ••••abcd.
//  • Don't save (default) — the key stays in THIS TAB'S MEMORY only. It is sent with each request, used, and forgotten
//    by the server. It is never written to the database or to localStorage, and it is gone when you close or refresh the page.
// A model can be used only after it has passed a connection test; the model switcher lists only those.
let providers = [];
let AI = { keys: [], models: [], youtube: null, serverKey: false };
let SESS = [];            // "don't save" connections — memory only: { sid, provider, short, model, baseUrl, key, hint, status, error, ms }
let sessActive = null;    // sid of the session connection picked in the model switcher
let sessSeq = 0;
let SESS_YT = "";         // "don't save" YouTube key — memory only
/* ---------- "This device": keys kept in THIS browser, encrypted ---------- */
// A third way to keep a key (besides "this visit only" and "saved on the server"): it never leaves the browser except as
// the per-request header, and it is not stored in plain text. It is encrypted with AES-GCM using a key that the browser
// keeps in IndexedDB and will not let scripts read out (non-extractable). This hides it from someone looking through
// the browser's stored data, but NOT from a script running on this page — which is why the page is locked down by a strict CSP.
const keyMode = () => store.get("keyMode") || (store.get("rememberKeys") === "1" ? "server" : "visit"); // visit | server | device
const vaultIO = (mode, fn) =>
  new Promise((resolve, reject) => {
    const open = indexedDB.open("songexplain-vault", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const t = open.result.transaction("kv", mode);
      const rq = fn(t.objectStore("kv"));
      t.oncomplete = () => { open.result.close(); resolve(rq?.result); };
      t.onerror = t.onabort = () => reject(t.error);
    };
  });
const vaultKey = async () => {
  let k = await vaultIO("readonly", (s) => s.get("aes"));
  if (!k) { k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); await vaultIO("readwrite", (s) => s.put(k, "aes")); }
  return k;
};
let vaultReady = false; // true once the saved keys have been read back, so an early save can't wipe them
async function vaultSave() {
  if (!me || !vaultReady) return;
  try {
    if (keyMode() !== "device") return vaultIO("readwrite", (s) => s.delete("u" + me.id));
    const data = SESS.filter((s) => s.status === "ok").map(({ sid, provider, short, model, baseUrl, key, hint, status }) => ({ sid, provider, short, model, baseUrl, key, hint, status }));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await vaultKey(), new TextEncoder().encode(JSON.stringify(data)));
    await vaultIO("readwrite", (s) => s.put({ iv, ct }, "u" + me.id));
  } catch {}
}
async function vaultLoad() {
  vaultReady = true;
  if (!me || keyMode() !== "device") return;
  try {
    const rec = await vaultIO("readonly", (s) => s.get("u" + me.id));
    if (!rec) return;
    const data = JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.iv }, await vaultKey(), rec.ct)));
    if (Array.isArray(data)) { SESS = data; sessSeq = Math.max(0, ...data.map((s) => s.sid)); }
  } catch {}
}
const vaultForget = (userId) => { try { vaultIO("readwrite", (s) => s.delete("u" + userId)).catch(() => {}); } catch {} }; // sign out / delete account

const wipeSession = () => { SESS = []; sessActive = null; SESS_YT = ""; };

const hintOf = (k) => (k.length >= 12 ? `••••${k.slice(-4)}` : "••••");
const okModels = () => AI.models.filter((m) => m.status === "ok");
// Every model that can be used right now: saved ones that passed their test, plus tested session ones.
function usable() {
  return [
    ...okModels().map((m) => ({ ...m, ref: String(m.id), session: false })),
    ...SESS.filter((s) => s.status === "ok").map((s) => ({ ...s, ref: "s" + s.sid, session: true, label: s.short })),
  ];
}
function activeModel() {
  const all = usable();
  if (sessActive) { const s = all.find((m) => m.session && m.sid === sessActive); if (s) return s; }
  const id = Number(store.get("activeModel"));
  return all.find((m) => !m.session && m.id === id) || all.find((m) => !m.session) || all[0] || null;
}
const hasAI = () => !!activeModel() || AI.serverKey;

async function loadAI() {
  try { AI = { ...AI, ...(await json("GET", "/api/ai")) }; } catch {}
  refreshAIChrome(); renderModelPicker();
}
function refreshAIChrome() {
  const pill = $("aipill"), m = activeModel();
  pill.classList.toggle("warn", !hasAI());
  pill.textContent = m ? `AI: ${m.label}` : AI.serverKey ? "AI: local key" : "Connect AI";
}

// The model switcher shown next to "Explain this song": only models that passed their connection test.
function renderModelPicker() {
  const slot = $("modelslot");
  if (!slot) return;
  const list = usable();
  if (!list.length) {
    slot.innerHTML = AI.serverKey
      ? `<span class="note" style="margin:0">Using the local Claude key</span>`
      : `<button class="btn ghost sm" data-act="settings">Connect an AI</button>`;
    return;
  }
  const cur = activeModel();
  slot.innerHTML = `<label class="note" style="margin:0" for="modelsel">Model</label> <select id="modelsel" class="msel" aria-label="AI model">${list
    .map((m) => `<option value="${esc(m.ref)}"${m.ref === cur.ref ? " selected" : ""}>${esc(m.label)} · ${esc(m.model)}${m.session ? " (this session)" : ""}</option>`)
    .join("")}</select>`;
  $("modelsel").onchange = () => {
    const ref = $("modelsel").value;
    if (ref.startsWith("s")) sessActive = Number(ref.slice(1));
    else { sessActive = null; store.set("activeModel", ref); }
    refreshAIChrome();
  };
}

const KEY_LINKS = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  gemini: "https://aistudio.google.com/apikey",
  deepseek: "https://platform.deepseek.com/api_keys",
  groq: "https://console.groq.com/keys",
  openrouter: "https://openrouter.ai/keys",
};
// Plain-language steps for getting a key, shown under "New to this?" in the AI settings.
const KEY_GUIDE = {
  gemini: ["Press “Get a key ↗” and sign in with a Google account.", "Press “Create API key”, then copy it.", "Paste it below."],
  openai: ["Press “Get a key ↗” and sign in.", "Add a little credit under Billing, create a secret key and copy it.", "Paste it below."],
  anthropic: ["Press “Get a key ↗” and sign in.", "Add a little credit under Billing, create a key and copy it.", "Paste it below."],
  deepseek: ["Press “Get a key ↗” and sign in.", "Top up a small balance, create a key and copy it.", "Paste it below."],
};
const KEY_GUIDE_OTHER = ["Create an API key on your provider's website.", "Type their OpenAI-compatible Base URL above.", "Paste the key below."];
const POPULAR = ["anthropic", "openai", "gemini", "deepseek"];
let aiAdding = false;      // the add form is open although something is already connected
let aiOther = false;       // "Other…" was chosen, so show the full provider list
let aiModelOpen = false;   // the model name field is open

let aiFirst = false;
async function openSettings(first) {
  $("acctdlg").close(); // opened from Account on a phone: show only one dialog
  aiFirst = !!first;
  $("airemember").checked = keyMode() === "server";
  aiAdding = false; aiOther = false; aiModelOpen = false;
  $("settings").showModal();
  await loadAI();
  renderAISettings();
}

// Keep the guided form in step with the current choices.
function syncProviderFields() {
  const pid = $("aiprov").value, p = providers.find((x) => x.id === pid), k = AI.keys.find((x) => x.provider === pid);
  const remember = $("airemember").checked;
  document.querySelectorAll("#provchips [data-p]").forEach((b) => {
    const on = b.dataset.p === "other" ? !POPULAR.includes(pid) || aiOther : b.dataset.p === pid && !aiOther;
    b.setAttribute("aria-pressed", String(on));
  });
  $("aiprovwrap").hidden = !(aiOther || !POPULAR.includes(pid));
  $("aibasewrap").hidden = !p?.custom;
  if (p?.custom && k?.baseUrl && !$("aibase").value) $("aibase").value = k.baseUrl;
  $("aiguidesteps").innerHTML = (KEY_GUIDE[pid] || KEY_GUIDE_OTHER).map((t) => `<li>${esc(t)}</li>`).join("");
  const link = KEY_LINKS[pid];
  $("aikeylink").hidden = !link; if (link) $("aikeylink").href = link;
  $("aikey").placeholder = k && remember ? "Leave empty to use your saved key" : "Paste your API key";
  $("aikeyhint").textContent = k && remember ? `A ${p?.short || ""} key is already saved (${k.hint}).` : "";
  const mode = keyMode();
  document.querySelectorAll("#remseg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === (mode === "server" ? "1" : mode === "device" ? "d" : "0"))));
  // the model: shown as a one-line summary; open the field only when needed (no default, or you ask to change it)
  const needsModel = !p?.model;
  const model = $("aimodelin").value.trim() || p?.model || "";
  $("aimodeltext").textContent = model ? `Model: ${model}` : "Model: type the model name";
  $("aimodelbtn").hidden = needsModel;
  $("aimodelwrap").hidden = !(aiModelOpen || needsModel);
  $("aimodelin").placeholder = p?.model ? `default: ${p.model}` : "model name (required)";
}

function renderAISettings() {
  if (!$("aiprov").options.length) $("aiprov").innerHTML = providers.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join("");
  const hasAny = AI.models.length > 0 || SESS.length > 0;
  const showForm = !hasAny || aiAdding;
  $("aiform").hidden = !showForm;
  $("aiaddbtn").hidden = showForm;
  $("aititle").textContent = hasAny ? "Your AI" : "Connect an AI";
  $("aisub").textContent = hasAny ? "Choose which one to use from the Model menu next to “Explain this song”." : aiFirst ? "One quick step before your first Explain: pick a provider and paste your key. You only do this once." : "Pick a provider, paste your key, and you're done.";
  $("ailocal").hidden = !(AI.serverKey && !hasAny);
  if (showForm) syncProviderFields();

  const byProv = {};
  AI.models.forEach((m) => (byProv[m.provider] ||= []).push(m));
  const provs = [...new Set([...AI.keys.map((k) => k.provider), ...Object.keys(byProv)])];
  const statusText = { ok: "connected", failed: "failed", untested: "not tested" };
  const row = (dot, name, status, actions, err) =>
    `<div class="aimodel"><span class="dot ${esc(dot)}"></span><span class="grow">${esc(name)}</span><span class="note" style="margin:0">${esc(status)}</span>${actions}</div>${err ? `<p class="note err" style="margin:0 0 6px 21px">${esc(err)}</p>` : ""}`;
  const saved = provs.map((pid) => {
    const k = AI.keys.find((x) => x.provider === pid), p = providers.find((x) => x.id === pid);
    return `<div class="aiprov"><div class="row"><b>${esc(p?.short || pid)}</b><span class="note" style="margin:0">saved · ${esc(k?.hint || "")}</span><button class="link danger push" data-act="rmkey" data-p="${esc(pid)}">Remove key</button></div>
      ${(byProv[pid] || []).map((m) => row(m.status, m.model, statusText[m.status] || "", `<button class="link" data-act="retest" data-id="${m.id}">Test</button><button class="link danger" data-act="rmmodel" data-id="${m.id}">Remove</button>`, m.status === "failed" ? m.error : "")).join("")}${amUI("p:" + pid)}</div>`;
  }).join("");
  // keys that aren't on the server: one block per key, named after its provider
  const where = keyMode() === "device" ? "saved in this browser" : "this visit only";
  const sess = [...new Map(SESS.map((x) => [x.provider + " " + x.key, x])).values()].map((g) => {
    const items = SESS.filter((x) => x.provider === g.provider && x.key === g.key);
    return `<div class="aiprov"><div class="row"><b>${esc(g.short)}</b><span class="note" style="margin:0">${where} · ${esc(g.hint)}</span><button class="link danger push" data-act="srmkey" data-sid="${g.sid}">Remove key</button></div>
      ${items.map((s) => row(s.status, s.model, s.status === "ok" ? "connected" : "failed", `<button class="link" data-act="stest" data-sid="${s.sid}">Test</button><button class="link danger" data-act="srm" data-sid="${s.sid}">Remove</button>`, s.status === "failed" ? s.error : "")).join("")}${amUI("s:" + g.sid)}</div>`;
  }).join("");
  $("aimodels").innerHTML = saved + sess;
  vaultSave();

  if (AI.youtube) {
    $("ytbox").innerHTML = `<div class="row"><span class="note" style="margin:0">YouTube key saved ${esc(AI.youtube.hint)}</span><button class="link danger" data-act="ytremove">Remove</button></div>`;
  } else if (SESS_YT) {
    $("ytbox").innerHTML = `<div class="row"><span class="note" style="margin:0">Using a YouTube key for this visit only ${esc(hintOf(SESS_YT))}</span><button class="link danger" data-act="ytremove">Remove</button></div>`;
  } else {
    $("ytbox").innerHTML = `<p class="note">Lets the Listeners tab load YouTube comments too. Free: enable “YouTube Data API v3” in Google Cloud and create a key.</p>
       <div class="field"><input id="ytkey" type="password" autocomplete="off" spellcheck="false" placeholder="YouTube Data API key"></div>
       <label class="check"><input type="checkbox" id="ytremember"${store.get("rememberKeys") === "1" ? " checked" : ""}><span>Save it (encrypted). Off = this visit only.</span></label>
       <div class="row" style="margin-top:12px"><button class="btn ghost sm" data-act="ytsave" type="button">Test &amp; add</button><span id="ytresult" class="note" style="margin:0"></span></div>`;
  }
}

/* ---------- one key, many models ---------- */
// A key belongs to a provider, and a provider has many models. "+ Add models" looks up what the key can use,
// lets you tick several, tests each one, and connects the ones that pass — without pasting the key again.
let AMP = null; // the open "add models" panel: { id: "p:gemini" | "s:3", loading, models, picked, custom, filter, status }
const AM_MAX = 8; // each model is tested once, and tests are rate-limited

const amTarget = (id) => {
  if (id.startsWith("p:")) return { saved: true, provider: id.slice(2) };
  const c = SESS.find((x) => x.sid === Number(id.slice(2)));
  return c ? { saved: false, provider: c.provider, c } : null;
};
const amHave = (t) => new Set(t.saved ? AI.models.filter((m) => m.provider === t.provider).map((m) => m.model) : SESS.filter((s) => s.provider === t.provider && s.key === t.c.key).map((s) => s.model));

function amListHTML() {
  const f = AMP.filter.trim().toLowerCase();
  const shown = AMP.models.filter((m) => !f || m.toLowerCase().includes(f));
  if (!AMP.models.length) return `<p class="note" style="margin:6px 0">This provider didn’t list its models — type the model name below.</p>`;
  if (!shown.length) return `<p class="note" style="margin:6px 0">No model matches “${esc(AMP.filter)}”.</p>`;
  return shown.map((m) => `<label class="check amrow"><input type="checkbox" data-am="${esc(m)}"${AMP.picked.has(m) ? " checked" : ""}><span>${esc(m)}</span></label>`).join("");
}
function amPanelHTML() {
  if (AMP.loading) return `<div class="addpanel"><p class="note" style="margin:0">Looking up the models on your ${esc(amName(AMP.id))} account…</p></div>`;
  return `<div class="addpanel">
    <p class="amhead">Add models to <b>${esc(amName(AMP.id))}</b></p>
    <p class="note" style="margin:0 0 8px">Tick the models you want to use with this ${esc(amName(AMP.id))} key. Each one is tested before it is added.</p>
    ${AMP.models.length > 8 ? `<input id="amfilter" type="text" placeholder="Filter models" autocomplete="off" value="${esc(AMP.filter)}">` : ""}
    <div class="amlist" id="amlist">${amListHTML()}</div>
    <div class="field"><input id="amcustom" type="text" placeholder="Or type a model name" autocomplete="off" spellcheck="false" value="${esc(AMP.custom)}"></div>
    <div class="row" style="margin-top:12px"><button class="btn sm" data-act="amgo" type="button"${AMP.busy ? " disabled" : ""}>${AMP.busy ? "Testing…" : "Test &amp; add"}</button><button class="link" data-act="amcancel" type="button">Cancel</button><span class="note ${AMP.err ? "err" : ""}" id="amstat" style="margin:0">${esc(AMP.status || "")}</span></div>
  </div>`;
}
const amName = (id) => { const t = amTarget(id); return t ? (t.c?.short || providers.find((p) => p.id === t.provider)?.short || t.provider) : ""; };
const amUI = (id) => (AMP?.id === id ? amPanelHTML() : `<div class="row" style="margin-top:6px"><button class="link" data-act="amopen" data-id="${esc(id)}" type="button">+ Add ${esc(amName(id))} models</button></div>`);

async function amOpen(id) {
  const t = amTarget(id);
  if (!t) return;
  AMP = { id, loading: true, models: [], picked: new Set(), custom: "", filter: "", status: "", err: false, busy: false };
  renderAISettings();
  try {
    const body = t.saved ? { provider: t.provider } : { provider: t.provider, apiKey: t.c.key, baseUrl: t.c.baseUrl };
    const have = amHave(t);
    AMP.models = (await json("POST", "/api/ai/discover", body)).models.filter((m) => !have.has(m));
  } catch (e) { if (AMP) { AMP.status = e.message; AMP.err = true; } }
  if (AMP) { AMP.loading = false; renderAISettings(); }
}

async function amGo() {
  const t = AMP && amTarget(AMP.id);
  if (!t) return;
  const custom = ($("amcustom")?.value || "").trim();
  const names = [...new Set([...AMP.picked, ...(custom ? [custom] : [])])];
  if (!names.length) { AMP.status = "Tick at least one model."; AMP.err = true; $("amstat").className = "note err"; $("amstat").textContent = AMP.status; return; }
  if (names.length > AM_MAX) { AMP.status = `Add up to ${AM_MAX} at a time.`; AMP.err = true; $("amstat").className = "note err"; $("amstat").textContent = AMP.status; return; }
  AMP.custom = custom; AMP.busy = true; AMP.err = false; renderAISettings();
  const failed = [];
  let ok = 0, lastId = null;
  for (const model of names) {
    $("amstat") && ($("amstat").textContent = `Testing ${model}…`);
    try {
      if (t.saved) {
        const r = await json("POST", "/api/ai/connect", { provider: t.provider, model });
        if (r.ok) { ok++; lastId = r.model.id; } else failed.push(`${model}: ${r.error || "failed"}`);
      } else {
        const r = await json("POST", "/api/ai/test", { provider: t.provider, apiKey: t.c.key, model, baseUrl: t.c.baseUrl });
        if (r.ok) { SESS.push({ sid: ++sessSeq, provider: t.provider, short: t.c.short, model, baseUrl: t.c.baseUrl, key: t.c.key, hint: t.c.hint, status: "ok", ms: r.ms }); ok++; }
        else failed.push(`${model}: ${r.error || "failed"}`);
      }
    } catch (e) { failed.push(`${model}: ${e.message}`); }
  }
  if (t.saved) await loadAI();
  if (!failed.length) { AMP = null; renderAISettings(); refreshAIChrome(); renderModelPicker(); toast(ok === 1 ? "Model added" : `${ok} models added`); return; }
  // keep the panel open so the failures can be read (and retried); the models that worked are already added
  const have = amHave(t);
  AMP.models = AMP.models.filter((m) => !have.has(m)); AMP.picked = new Set([...AMP.picked].filter((m) => !have.has(m)));
  if (have.has(AMP.custom)) AMP.custom = "";
  AMP.busy = false; AMP.err = true; AMP.status = (ok ? `${ok} added. ` : "") + failed.join("  ·  ");
  renderAISettings(); refreshAIChrome(); renderModelPicker();
}

// The add-models panel is redrawn with the rest of the settings, so its fields are read through these listeners.
$("aimodels").addEventListener("change", (e) => {
  const cb = e.target.closest("[data-am]");
  if (cb && AMP) cb.checked ? AMP.picked.add(cb.dataset.am) : AMP.picked.delete(cb.dataset.am);
});
$("aimodels").addEventListener("input", (e) => {
  if (!AMP) return;
  if (e.target.id === "amfilter") { AMP.filter = e.target.value; $("amlist").innerHTML = amListHTML(); }
  if (e.target.id === "amcustom") AMP.custom = e.target.value;
});
function showAIResult(r) {
  const el = $("airesult");
  el.className = "note " + (r.ok ? "okmsg" : "err");
  el.style.margin = "0";
  el.textContent = r.ok ? `Connected${r.ms ? ` in ${(r.ms / 1000).toFixed(1)}s` : ""}.` : r.error || "Connection failed.";
}

// If the model you asked for isn't available, offer the ones your account really has.
function offerModels(models) {
  if (!models?.length) return;
  $("aimodelpick").innerHTML = models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("") + `<option value="">Type another name…</option>`;
  $("aipickwrap").hidden = false; $("aimodelwrap").hidden = false; aiModelOpen = true;
  $("aimodelinwrap").hidden = true;
  $("aimodelin").value = models[0];
  $("aimodeltext").textContent = `Model: ${models[0]}`;
}
$("aimodelpick").onchange = () => {
  const v = $("aimodelpick").value;
  $("aimodelinwrap").hidden = v !== "";
  $("aimodelin").value = v;
  if (v === "") $("aimodelin").focus();
  syncModelText();
};
const syncModelText = () => { const p = providers.find((x) => x.id === $("aiprov").value); $("aimodeltext").textContent = `Model: ${$("aimodelin").value.trim() || p?.model || "type the model name"}`; };
$("aimodelin").addEventListener("input", syncModelText);

async function aiCall(path) {
  const body = { provider: $("aiprov").value, apiKey: $("aikey").value.trim(), model: $("aimodelin").value.trim(), baseUrl: $("aibase").value.trim() };
  $("airesult").className = "note"; $("airesult").textContent = "Testing…";
  $("aisave").disabled = true;
  try { return await json("POST", path, body); } finally { $("aisave").disabled = false; }
}
$("aiprov").onchange = () => { aiOther = true; $("aimodelin").value = ""; $("aipickwrap").hidden = true; $("aimodelinwrap").hidden = false; $("airesult").textContent = ""; syncProviderFields(); };

// One button: test, then connect (and, if you asked to keep it, save it encrypted).
$("aisave").onclick = async () => {
  const remember = $("airemember").checked;
  const pid = $("aiprov").value, p = providers.find((x) => x.id === pid);
  const key = $("aikey").value.trim();
  const haveSaved = AI.keys.some((k) => k.provider === pid);
  try {
    if (!key && !(remember && haveSaved)) { showAIResult({ ok: false, error: "Paste your API key first." }); $("aikey").focus(); return; }
    if (!remember) {
      // Just this visit: test it, then keep the key in memory only.
      const model = $("aimodelin").value.trim() || p?.model || "";
      const baseUrl = $("aibase").value.trim();
      const r = await aiCall("/api/ai/test");
      showAIResult(r);
      if (!r.ok) { offerModels(r.models); return; }
      SESS = SESS.filter((s) => !(s.provider === pid && s.model === model));
      const s = { sid: ++sessSeq, provider: pid, short: p?.short || pid, model, baseUrl, key, hint: hintOf(key), status: "ok", ms: r.ms };
      SESS.push(s); sessActive = s.sid;
    } else {
      const r = await aiCall("/api/ai/connect");
      showAIResult(r);
      if (!r.ok) { offerModels(r.models); return; }
      sessActive = null; store.set("activeModel", r.model.id); // use what you just connected
      await loadAI();
    }
    $("aikey").value = ""; $("aimodelin").value = ""; aiAdding = false; aiModelOpen = false; $("aipickwrap").hidden = true; $("aimodelinwrap").hidden = false;
    renderAISettings(); refreshAIChrome(); renderModelPicker();
    toast(remember ? "Connected — saved (encrypted)" : "Connected for this visit — the key is not saved");
  } catch (e) { showAIResult({ ok: false, error: e.message }); }
};

// One-time: an older version saved keys unencrypted in this browser. Ask what to do with them, then remove them from here.
async function migrateLegacyKeys() {
  try {
    const get = (k) => localStorage.getItem(`u${me.id}:${k}`) ?? localStorage.getItem(k);
    const drop = (k) => { localStorage.removeItem(`u${me.id}:${k}`); localStorage.removeItem(k); };
    for (const p of providers) {
      const key = get(`key:${p.id}`);
      if (!key) continue;
      const move = confirm(`Your ${p.short} API key was saved unencrypted in this browser by an older version.\n\nOK = move it to the server (encrypted at rest).\nCancel = delete it from this browser; you can paste it again whenever you use it, without saving it.`);
      if (move) {
        try {
          const r = await rawApi("POST", "/api/ai/connect", { provider: p.id, apiKey: key, model: get(`model:${p.id}`) || "", baseUrl: get(`baseUrl:${p.id}`) || "" });
          const d = await r.json();
          if (r.ok && d.ok) toast(`Moved your ${p.short} key to the server (encrypted) and removed it from this browser.`);
          else toast(`Your saved ${p.short} key could not be verified (${d.error || "error"}). Paste it again in AI settings.`, "err");
        } catch {}
      }
      ["key:", "model:", "baseUrl:"].forEach((x) => drop(x + p.id)); // never leave a key behind in the browser
    }
    const yt = get("ytkey");
    if (yt) {
      if (confirm("Your YouTube API key was saved unencrypted in this browser by an older version.\n\nOK = move it to the server (encrypted at rest).\nCancel = delete it from this browser.")) {
        try { await rawApi("PUT", "/api/ai/youtube", { apiKey: yt }); } catch {}
      }
      drop("ytkey");
    }
    drop("provider");
  } catch {}
}
async function initAI() {
  try { providers = await (await fetch("/api/providers")).json(); } catch { providers = []; }
  await migrateLegacyKeys();
  await vaultLoad();
  await loadAI();
}

/* ---------- API helper ---------- */
/* ---------- waiting for the server: block clicks at once, show the pixel loader if it takes a moment ---------- */
// While anything that saves or changes data is in flight the whole screen is covered, so a second click can't reach a button.
// The cover is invisible for the first 0.28 s (quick answers never flash), then the pixel loader fades in.
let busyN = 0, busyShowT = 0;
function busy(label = "Working") {
  const box = $("busy");
  if (!box) return () => {};
  busyN++;
  $("busytext").textContent = label;
  document.activeElement?.blur?.(); // an Enter key press must not trigger the same button again
  try { box.showPopover(); } catch {}
  clearTimeout(busyShowT); busyShowT = setTimeout(() => box.classList.add("show"), 280);
  let done = false;
  const end = () => {
    if (done) return;
    done = true; clearTimeout(kill);
    if (--busyN <= 0) { busyN = 0; clearTimeout(busyShowT); box.classList.remove("show"); try { box.hidePopover(); } catch {} }
  };
  const kill = setTimeout(end, 45000); // never leave the screen covered for good
  return end;
}
const NO_SHIELD = /\/explain$|\/views\/summary$|^\/api\/ai\/|\/api\/identify$|\/api\/auth\/me$|\/api\/cover/; // these show their own progress
function busyLabel(method, url) {
  if (method === "DELETE") return "Deleting";
  if (/\/lyrics\/find$/.test(url)) return "Looking for lyrics";
  if (/\/lyrics$/.test(url)) return "Saving lyrics";
  if (/\/perspectives/.test(url)) return method === "POST" ? "Saving your feeling" : "Updating your feeling";
  if (/\/api\/songs\/check$/.test(url)) return "Checking your library";
  if (/\/api\/songs$/.test(url)) return "Saving the song";
  if (/\/report$/.test(url)) return "Sending report";
  if (/feedback/.test(url)) return "Sending";
  return "Saving";
}
async function api(method, url, body, signal) {
  const end = method !== "GET" && !NO_SHIELD.test(url) ? busy(busyLabel(method, url)) : null;
  try {
    const r = await rawApi(method, url, body, signal);
    if (r.status === 401) {
      try { if ((await r.clone().json()).code === "AUTH") sessionExpired(); } catch {}
    }
    return r;
  } finally { end?.(); }
}
function rawApi(method, url, body, signal) {
  const m = activeModel();
  const headers = { "Content-Type": "application/json" };
  if (m?.session) {
    // "Don't save" key: sent with this request only; the server uses it and forgets it.
    headers["x-ai-key"] = m.key; headers["x-ai-provider"] = m.provider; headers["x-ai-model"] = m.model;
    if (m.baseUrl) headers["x-ai-base"] = m.baseUrl;
  } else if (m) headers["x-model-id"] = String(m.id); // saved connection: the server looks up the encrypted key itself
  return fetch(url, { method, signal, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function json(method, url, body) {
  const r = await api(method, url, body);
  const d = await r.json();
  if (!r.ok) throw Object.assign(new Error(d.error || "Request failed"), { code: d.code, status: r.status });
  return d;
}

/* ---------- click actions (no inline handlers: the page's CSP forbids them) ---------- */
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act],[data-close]");
  if (!el) return;
  if (el.dataset.close) { $(el.dataset.close).close(); return; }
  const act = el.dataset.act;
  try {
    if (act === "home") location.hash = "#/";
    else if (act === "settings") openSettings();
    else if (act === "account") openAccount();
    else if (act === "add") openAdd();
    else if (act === "pastelyrics") showTab("lyrics");
    else if (act === "addprefill") openAdd(CAND.q);
    else if (act === "candpage") { CAND.page = Number(el.dataset.p); renderCandidates(); $("status").scrollIntoView({ behavior: "smooth", block: "start" }); }
    else if (act === "guide") startTour();
    else if (act === "feedback") openFeedback();
    else if (act === "fbkind") setFbKind(el.dataset.v);
    else if (act === "fbadmin") { $("acctdlg").close(); openFeedbackAdmin(); }
    else if (act === "fbfilter") { fbFilter = el.dataset.v; loadFeedbackAdmin(); }
    else if (act === "fbstatus") {
      await json("POST", `/api/admin/feedback/${el.dataset.id}/status`, { status: el.dataset.s });
      loadFeedbackAdmin();
    } else if (act === "fbdel") {
      if (!confirm("Delete this feedback for good?")) return;
      await json("DELETE", `/api/admin/feedback/${el.dataset.id}`);
      loadFeedbackAdmin();
    }

    else if (act === "provpick") {
      const pv = el.dataset.p;
      if (pv === "other") aiOther = true; else { aiOther = false; $("aiprov").value = pv; }
      $("aimodelin").value = ""; $("aipickwrap").hidden = true; $("aimodelinwrap").hidden = false; $("airesult").textContent = "";
      syncProviderFields(); $("aikey").focus();
    } else if (act === "remember") {
      { const v = el.dataset.v, mode = v === "1" ? "server" : v === "d" ? "device" : "visit"; $("airemember").checked = mode === "server"; store.set("keyMode", mode); vaultSave(); }
      syncProviderFields();
    } else if (act === "aiadd") { aiAdding = true; renderAISettings(); $("aikey").focus(); }
    else if (act === "fimg") await saveFeelingImage(Number(el.dataset.fid));
    else if (act === "lyrsize") { store.set("lyrSize", el.dataset.v); applyLyrSize(); }
    else if (act === "lyrcopy") { await navigator.clipboard.writeText(LYR.text); toast("Lyrics copied"); }
    else if (act === "prev") {
      if (PREVIEW) { stopPreview(); return; }
      const a = new Audio(curSong.preview_url); PREVIEW = a;
      a.onended = stopPreview; a.onerror = () => { stopPreview(); toast("The preview could not be played.", "err"); };
      el.textContent = "■ Stop"; el.setAttribute("aria-pressed", "true");
      a.play().catch(() => { stopPreview(); toast("The preview could not be played.", "err"); });
    }
    else if (act === "lyredit") showLyrEdit(true);
    else if (act === "exretry") explain(curSong);
    else if (act === "exkeep" && INTERRUPTED) {
      await json("POST", `/api/songs/${INTERRUPTED.song.id}/explanations`, { body: INTERRUPTED.partial, language: INTERRUPTED.language });
      toast("Kept — marked as cut off"); INTERRUPTED = null; LIVE.html = ""; renderSong(curSong.id);
    }
    else if (act === "lyrother") await openLyricChoices();
    else if (act === "lyrpick") await pickLyricChoice(Number(el.dataset.i));
    else if (act === "lyrclosepick") $("lyrcands").hidden = true;
    else if (act === "lyrsync") {
      if (!curSong.lyrics_auto && !confirm("Sync looks the lyrics up online again and REPLACES the ones saved here — including anything you pasted or edited yourself.\n\nContinue?")) return;
      el.disabled = true; el.textContent = "Syncing…";
      try {
        const d = await json("POST", `/api/songs/${curSong.id}/lyrics/find`, { refresh: true });
        const same = String(d.lyrics).trim() === LYR.text.trim();
        toast(same ? "Already up to date — the online version is the same" : `Lyrics synced from ${d.source || "online"}`);
        if (!same) renderSong(curSong.id); else { el.disabled = false; el.textContent = "Sync lyrics"; }
      } catch (e) { toast(e.message + " Your saved lyrics were not changed.", "err"); el.disabled = false; el.textContent = "Sync lyrics"; }
    }
    else if (act === "lyrfind") {
      el.disabled = true; el.textContent = "Looking…";
      try { await json("POST", `/api/songs/${curSong.id}/lyrics/find`, {}); toast("Lyrics found"); renderSong(curSong.id); }
      catch (e) { toast(e.message, "err"); el.disabled = false; el.textContent = "Find lyrics online"; }
    }
    else if (act === "emore") { const card = el.closest(".entry"), open = card.classList.toggle("open"); el.textContent = open ? "Show less ↑" : "Read more ↓"; el.setAttribute("aria-expanded", String(open)); }
    else if (act === "amopen") amOpen(el.dataset.id);
    else if (act === "amcancel") { AMP = null; renderAISettings(); }
    else if (act === "amgo") await amGo();
    else if (act === "aimodel") { aiModelOpen = !aiModelOpen; syncProviderFields(); if (aiModelOpen) $("aimodelin").focus(); }
    else if (act === "invites") { $("acctdlg").close(); openInvites(); }
    else if (act === "invcreate") {
      el.disabled = true;
      try {
        const count = Math.min(50, Math.max(1, parseInt($("invcount").value, 10) || 1));
        const r = await json("POST", "/api/admin/invites", { label: $("invlabel").value, days: Number($("invdays").value), count });
        INV_LAST = r.codes;
        const n = r.codes.length;
        $("invnew").innerHTML = `<div class="newcode"><div class="note" style="margin:0 0 10px">${n === 1 ? "Send this to one person" : `${n} codes — send one to each person`}. Each works once and expires in ${r.days} day${r.days === 1 ? "" : "s"}. They will not be shown again, so copy them now.</div>
          ${r.codes.map((c) => `<div class="codeline"><code>${esc(c.code)}</code>${c.label ? ` <span class="note" style="margin:0">${esc(c.label)}</span>` : ""}</div>`).join("")}
          <div class="row" style="margin-top:12px"><button class="btn ghost sm" data-act="invcopyall" type="button">${n === 1 ? "Copy code" : "Copy all"}</button></div></div>`;
        $("invlabel").value = "";
        await loadInvites();
      } finally { el.disabled = false; }
    } else if (act === "invcopyall") {
      const text = INV_LAST.length === 1 ? INV_LAST[0].code : INV_LAST.map((c) => (c.label ? `${c.label}: ${c.code}` : c.code)).join("\n");
      try { await navigator.clipboard.writeText(text); toast(INV_LAST.length === 1 ? "Code copied" : "All codes copied"); } catch { toast("Select the codes and copy them by hand.", "err"); }
    } else if (act === "invrevoke") {
      await json("DELETE", `/api/admin/invites/${el.dataset.id}`);
      await loadInvites();
    }
    else if (act === "report") { reportId = Number(el.dataset.id); $("reportdlg").showModal(); }
    else if (act === "backacct") { $(el.dataset.from).close(); openAccount(); }
    else if (act === "mod") { $("acctdlg").close(); openModeration(); }
    else if (act === "mact") {
      await json("POST", `/api/admin/perspectives/${el.dataset.id}/${el.dataset.do}`, {});
      COMM.loaded = false; openModeration();
    } else if (act === "mhide-post") {
      if (!confirm("Hide this post from the community feed?")) return;
      await json("POST", `/api/admin/perspectives/${el.dataset.id}/hide`, {});
      COMM.items = COMM.items.filter((p) => p.id !== Number(el.dataset.id)); if (curSong && $("community")) renderCommunity(curSong); if ($("jlist")) journalDrop?.(Number(el.dataset.id)); toast("Hidden");
    }
    else if (act === "retest") {
      el.disabled = true; el.textContent = "Testing…";
      const r = await json("POST", `/api/ai/models/${el.dataset.id}/test`, {});
      await loadAI(); renderAISettings();
      if (r.ok) toast("Connected"); else toast(r.error || "Connection failed", "err");
    } else if (act === "rmmodel") {
      await json("DELETE", `/api/ai/models/${el.dataset.id}`);
      await loadAI(); renderAISettings();
    } else if (act === "rmkey") {
      if (!confirm("Remove this API key and every model that uses it?")) return;
      await json("DELETE", `/api/ai/keys/${el.dataset.p}`);
      await loadAI(); renderAISettings();
    } else if (act === "stest") {
      const c = SESS.find((x) => x.sid === Number(el.dataset.sid));
      if (!c) return;
      el.disabled = true; el.textContent = "Testing…";
      const r = await json("POST", "/api/ai/test", { provider: c.provider, apiKey: c.key, model: c.model, baseUrl: c.baseUrl });
      c.status = r.ok ? "ok" : "failed"; c.error = r.ok ? "" : r.error; c.ms = r.ms;
      if (!r.ok && sessActive === c.sid) sessActive = null;
      renderAISettings(); refreshAIChrome(); renderModelPicker();
      if (r.ok) toast("Connected"); else toast(r.error || "Connection failed", "err");
    } else if (act === "srmkey") {
      const g = SESS.find((x) => x.sid === Number(el.dataset.sid));
      if (!g) return;
      if (sessActive && SESS.some((x) => x.sid === sessActive && x.provider === g.provider && x.key === g.key)) sessActive = null;
      SESS = SESS.filter((x) => !(x.provider === g.provider && x.key === g.key));
      AMP = null; renderAISettings(); refreshAIChrome(); renderModelPicker();
    } else if (act === "srm") {
      const sid = Number(el.dataset.sid);
      SESS = SESS.filter((x) => x.sid !== sid);
      if (sessActive === sid) sessActive = null;
      renderAISettings(); refreshAIChrome(); renderModelPicker();
    } else if (act === "ytsave") {
      const key = $("ytkey").value.trim();
      if (!key) { $("ytresult").textContent = "Paste a key first."; return; }
      const save = $("ytremember").checked;
      store.set("rememberKeys", save ? "1" : "");
      $("ytresult").className = "note"; $("ytresult").textContent = "Testing…";
      const r = await json("PUT", "/api/ai/youtube", { apiKey: key, save });
      if (!r.ok) { $("ytresult").className = "note err"; $("ytresult").textContent = r.error || "Key rejected."; return; }
      if (!save) SESS_YT = key;
      await loadAI(); renderAISettings(); toast(save ? "YouTube key saved (encrypted)" : "YouTube key connected for this session — not saved");
      if (curSong && location.hash.startsWith("#/song/")) renderViews(curSong);
    } else if (act === "ytremove") {
      if (SESS_YT) SESS_YT = ""; else await json("DELETE", "/api/ai/youtube");
      await loadAI(); renderAISettings();
      if (curSong && location.hash.startsWith("#/song/")) renderViews(curSong);
    }
  } catch (err) { toast(err.message, "err"); }
});

// Cover images that fail to load fall back to the lettered block (CSP forbids inline onerror).
document.addEventListener("error", (e) => {
  const i = e.target;
  if (i.tagName === "IMG" && i.dataset.initial !== undefined) {
    const p = i.parentElement;
    p.classList.add("ph");
    p.insertAdjacentHTML("beforeend", `<span>${esc(i.dataset.initial)}</span>`);
    i.remove();
  }
}, true);

/* ---------- Add a song (dialog) ---------- */
function openAdd(title = "") { $("mt").value = title; $("adddlg").showModal(); $("mt").focus(); }
$("madd").onclick = async () => {
  try {
    const s = await saveSong({ title: $("mt").value, artist: $("ma").value, lyrics: $("ml").value, source: "manual" });
    if (!s) return; // cancelled, or the person chose a song they already have
    $("adddlg").close(); $("mt").value = $("ma").value = $("ml").value = "";
    location.hash = "#/song/" + s.id;
  } catch (e) { toast(e.message, "err"); }
};

// Every way of putting a song in the library goes through here. If the library already holds the same song (or one that
// looks like it), the person decides — open the one they have, or confirm it is a different song. Resolves to the saved
// song, or null when nothing new was saved (the existing one was opened, or they cancelled).
let dupResolve = null;
async function saveSong(payload) {
  const { matches } = await json("POST", "/api/songs/check", payload);
  const exact = matches.find((m) => m.match === "exact");
  if (exact) { toast("Already in your library"); location.hash = "#/song/" + exact.id; $("adddlg").close(); return null; }
  if (!matches.length) return json("POST", "/api/songs", payload);
  const why = { same: "Looks like the same song", likely: "Same title and cover art", similar: "Same title, different artist" };
  $("dupnote").textContent = `You already have ${matches.length > 1 ? "songs" : "a song"} called “${payload.title}”. Is it the same one? Saving it again would split your notes and feelings across two copies.`;
  $("duplist").innerHTML = matches.map((m) => `<div class="simrow">${m.cover ? `<img src="${esc(m.cover)}" alt="" loading="lazy">` : ""}<span><b>${esc(m.title)}</b> · ${esc(m.artist)} <span class="mono">${why[m.match]}</span></span><button class="btn ghost" data-dup-open="${m.id}">It’s this one — open it</button></div>`).join("");
  $("dupdlg").showModal();
  const choice = await new Promise((resolve) => { dupResolve = resolve; });
  $("dupdlg").close();
  if (choice === "new") return json("POST", "/api/songs", payload);
  if (choice?.open) { $("adddlg").close(); location.hash = "#/song/" + choice.open; }
  return null;
}
$("dupdlg").addEventListener("click", (e) => { const b = e.target.closest("[data-dup-open]"); if (b) dupResolve?.({ open: b.dataset.dupOpen }); });
$("dupnew").onclick = () => dupResolve?.("new");
$("dupcancel").onclick = () => dupResolve?.(null);
$("dupdlg").addEventListener("cancel", () => dupResolve?.(null));

/* ---------- Lyrics tab: a reading view first; "Edit" is for pasting or fixing ---------- */
const LYR_SIZES = ["1.02rem", "1.2rem", "1.45rem"];
let LYR = { text: "" };
const lyrSize = () => Math.min(2, Math.max(0, Number(store.get("lyrSize") ?? 1) || 0));
// Verses are separated by blank lines; a lone "[Chorus]" style line becomes a small section label.
function lyricsViewHTML(text) {
  const marker = (l) => /^[\[\(（【].{1,30}[\]\)）】]$/.test(l.trim());
  return String(text).replace(/\r\n/g, "\n").trim().split(/\n\s*\n/).map((st) => {
    let lines = st.split("\n").map((l) => l.trimEnd()), out = "";
    if (marker(lines[0])) { out = `<p class="lyr-tag">${esc(lines[0].trim().slice(1, -1))}</p>`; lines = lines.slice(1); }
    return out + (lines.length ? `<p class="stz">${lines.map(esc).join("<br>")}</p>` : "");
  }).join("");
}
function applyLyrSize() {
  const v = lyrSize(), view = $("lyrview");
  if (view) view.style.setProperty("--lyr", LYR_SIZES[v]);
  document.querySelectorAll("#lyrtools [data-act=lyrsize]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.v) === v)));
}
// Choosing between versions: each card shows where it came from, whose song it is credited to, and the first two lines.
let LYR_CHOICES = [];
async function openLyricChoices() {
  const box = $("lyrcands");
  box.hidden = false;
  box.innerHTML = `<p class="note" style="margin:0">Looking in several places for other versions…</p>`;
  try {
    const d = await json("POST", `/api/songs/${curSong.id}/lyrics/candidates`, {});
    LYR_CHOICES = d.candidates;
    if (!LYR_CHOICES.length) { box.innerHTML = `<p class="note" style="margin:0">No other version was found online. You can paste the right lyrics yourself with “Edit”.</p><div class="row" style="margin-top:12px"><button class="link" data-act="lyrclosepick" type="button">Close</button></div>`; return; }
    box.innerHTML = `<div class="lyr-cands-head"><b>Choose the right lyrics</b><span class="mono">${LYR_CHOICES.length} version${LYR_CHOICES.length > 1 ? "s" : ""} found · check the first lines against the song</span><button class="link" data-act="lyrclosepick" type="button">Close</button></div>` +
      LYR_CHOICES.map((c) => `<article class="lyr-cand${c.current ? " current" : ""}"><div class="lyr-cand-top"><span class="lyr-cand-src">${esc(c.source)}</span><b>${esc(c.title || curSong.title)}</b><span class="mono">${esc(c.artist || "artist unknown")}${c.album ? " · " + esc(c.album) : ""}${c.artistMatch ? " · ✓ same artist" : ""}</span></div>
        <p class="lyr-cand-prev">${c.preview.map((l) => esc(l)).join("<br>")}…</p>
        <div class="lyr-cand-foot"><span class="mono">${c.lines} lines</span>${c.current ? `<span class="badge shared">Currently saved</span>` : `<button class="btn ghost sm" data-act="lyrpick" data-i="${c.id}" type="button">Use this one</button>`}</div></article>`).join("") +
      `<p class="note" style="margin:12px 0 0">None of these right? Close this and use “Edit” to paste the correct lyrics.</p>`;
  } catch (e) { box.innerHTML = `<p class="note err" style="margin:0">${esc(e.message)}</p><div class="row" style="margin-top:12px"><button class="link" data-act="lyrclosepick" type="button">Close</button></div>`; }
}
async function pickLyricChoice(i) {
  const c = LYR_CHOICES.find((x) => x.id === i);
  if (!c) return;
  if (LYR.text.trim() && !curSong.lyrics_auto && !confirm("This replaces the lyrics saved here — including anything you pasted or edited yourself.\n\nContinue?")) return;
  await json("PUT", `/api/songs/${curSong.id}/lyrics`, { lyrics: c.text, auto: true });
  toast(`Lyrics changed to the ${c.source} version`);
  renderSong(curSong.id);
}
function showLyrEdit(on) {
  $("lyrread").hidden = on; $("lyredit").hidden = !on;
  if (on) { $("lyr").value = LYR.text; $("lyr").focus(); }
}
function setLyricsText(song, text) {
  LYR.text = String(text || "");
  const has = !!LYR.text.trim();
  $("lyrview").innerHTML = has ? lyricsViewHTML(LYR.text) : "";
  $("lyrtools").hidden = !has; $("lyrview").hidden = !has; $("lyrempty").hidden = has;
  $("lyrsrc").textContent = has ? (song.lyrics_auto ? "Found online — check it is the right song" : "Added by you") : "";
  const n = LYR.text.split(/\r?\n/).filter((l) => l.trim()).length;
  $("lyrcount").textContent = has ? `${n} lines` : "";
  applyLyrSize();
}

/* ---------- Home: search results + library ---------- */
const TRY_SONGS = ["晴天 周杰伦", "七里香 周杰伦", "Yesterday Beatles", "光年之外 G.E.M."];
async function renderHome() {
  $("navlib").classList.add("on");
  $("view").innerHTML = `
  <div class="fade">
    <section class="intro">
      <h1>Every song<br>keeps a story.</h1>
      <p class="mono">Read what the words mean — and what they have meant to other people.</p>
      <form class="hsearch" id="hsearch" role="search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>
        <input id="q" type="text" placeholder="Search a song, or paste a YouTube link" autocomplete="off" aria-label="Search a song or paste a YouTube link">
        <button class="btn" type="submit" id="find">Find</button>
      </form>
      <div class="tryrow"><span>Try</span>${TRY_SONGS.map((t) => `<button type="button" data-try="${esc(t)}">${esc(t)}</button>`).join("")}<span>· or paste a YouTube link</span></div>
      <p class="hint">Can't find your song? <button class="link" data-act="add" type="button">Add it by hand</button></p>
    </section>
    <div class="libhead"><span class="lab">Library <span id="libcount"></span></span></div>
    <div class="libfilter" id="libfilter" hidden><input id="libq" type="text" placeholder="Filter your library by title or artist" autocomplete="off" aria-label="Filter your library"><button class="link" id="libclear" hidden>clear</button></div>
    <div id="lib" class="masonry"></div>
  </div>`;
  bindSearchForm();
  $("q").focus();
  $("view").querySelector(".tryrow").onclick = (e) => { const b = e.target.closest("[data-try]"); if (b) goSearch(b.dataset.try); };
  try {
    const songs = await json("GET", "/api/songs");
    if (!$("lib")) return;
    $("libcount").textContent = songs.length ? `(${songs.length})` : "";
    if (!songs.length) { $("lib").className = ""; $("lib").innerHTML = `<div class="empty"><p>Your library is empty — here is how it works.</p><ol class="steps"><li><b>1 · Search</b>Type a song and artist above, or tap one of the examples.</li><li><b>2 · Explain</b>Open the song and press “Explain this song”.</li><li><b>3 · Feel</b>Write how it makes you feel, in your own words.</li></ol></div>`; return; }
    // Filtering the library is separate from searching for new songs: it only looks at songs you already have.
    const draw = (list) => {
      $("lib").innerHTML = "";
      if (!list.length) { $("lib").className = ""; $("lib").innerHTML = `<div class="empty"><p>No song in your library matches.</p><p class="mono">Press Enter in the big search box to look for it as a new song.</p></div>`; return; }
      $("lib").className = "masonry";
      list.forEach((s) => {
        const b = document.createElement("button");
        b.className = "item";
        const label = s.explanations ? "Explained" : s.perspectives ? "Notes" : "Song";
        b.innerHTML = `${coverHTML(s)}<span class="lab">${label}${s.perspectives ? ` · ${s.perspectives} ${s.perspectives > 1 ? "notes" : "note"}` : ""}</span>
          <h3>${esc(s.title)}</h3><div class="by">${esc(s.artist)}</div>${s.excerpt ? `<p class="ex">${esc(s.excerpt)}</p>` : ""}<span class="more">Read More.</span>`;
        b.onclick = () => (location.hash = "#/song/" + s.id);
        $("lib").append(b);
      });
    };
    const fold = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const apply = () => {
      const q = fold($("libq").value.trim());
      $("libclear").hidden = !q;
      const list = q ? songs.filter((s) => fold(`${s.title} ${s.artist} ${s.album || ""}`).includes(q)) : songs;
      $("libcount").textContent = q ? `(${list.length} of ${songs.length})` : `(${songs.length})`;
      draw(list);
    };
    $("libfilter").hidden = false;
    $("libq").oninput = apply;
    $("libq").onkeydown = (e) => { if (e.key === "Escape") { $("libq").value = ""; apply(); } };
    $("libclear").onclick = () => { $("libq").value = ""; apply(); $("libq").focus(); };
    draw(songs);
  } catch (e) { toast(e.message, "err"); }
}

/* ---------- Journal: what I wrote, and what others shared about the songs in my library ---------- */
let journalTab = "mine";
let journalDrop = null; // lets a moderator "hide" action remove a post from the open journal
async function renderJournal() {
  $("navjournal").classList.add("on");
  $("view").innerHTML = `<div class="fade">
    <span class="lab">Journal <span id="jcount"></span></span>
    <h1 class="jtitle">Your songs, in your words.</h1>
    <p class="jintro">A diary of what songs have meant to you — and what other people here felt about the same songs.</p>
    <div class="seg jseg" role="group" aria-label="Journal view">
      <button data-jt="mine" aria-pressed="true">My feelings <span id="jn-mine"></span></button>
      <button data-jt="comm" aria-pressed="false">From the community <span id="jn-comm"></span></button>
    </div>
    <p class="note" id="jhelp"></p>
    <div class="jwrite" id="jwrite" hidden></div>
    <section class="jfind" aria-label="Find in your journal">
      <label class="jlabel" for="jq">Search</label>
      <div class="jsearch">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>
        <input id="jq" type="text" autocomplete="off" aria-describedby="jqhint">
        <select id="jsong" aria-label="Show one song only"></select>
      </div>
      <p class="jhint" id="jqhint"></p>
      <div class="fw-wrap" id="fwwrap" hidden>
        <span class="jlabel">Feeling words <small>tap one to see only those feelings</small></span>
        <div class="fwords" id="jtags"></div>
      </div>
      <button class="link" id="jclear" hidden>clear search and filters</button>
    </section>
    <div id="jlist" class="cardgrid"><p class="note">Loading…</p></div>
    <div id="jmore"></div>
  </div>`;
  let songs = [], rows = [], comm = [], hasMore = false;
  try {
    [songs, rows] = await Promise.all([json("GET", "/api/songs"), json("GET", "/api/journal")]);
    const c = await json("GET", "/api/journal/community").catch(() => ({ items: [], hasMore: false }));
    comm = c.items; hasMore = c.hasMore;
  } catch (e) { toast(e.message, "err"); return; }
  if (!$("jlist")) return;
  const fold = (x) => String(x || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  let tag = "", songId = "";
  journalDrop = (id) => { comm = comm.filter((p) => p.id !== id); if ($("jlist")) paint(); };

  const items = () => (journalTab === "mine" ? rows : comm);
  const matches = (r) =>
    (!tag || parseTags(r.mood).includes(tag)) && (!songId || String(r.song_id) === songId) &&
    (!$("jq").value.trim() || fold(`${r.body} ${r.title} ${r.artist} ${r.mood} ${r.anchor || ""} ${r.author || ""}`).includes(fold($("jq").value.trim())));

  // Start a new feeling: pick one of the songs in the library, jump straight to its "My feelings" tab.
  const writeBox = () => {
    const box = $("jwrite");
    box.hidden = journalTab !== "mine";
    if (box.hidden) return;
    box.innerHTML = songs.length
      ? `<label for="wsong">Write a new feeling about</label><select id="wsong">${songs.map((s) => `<option value="${s.id}">${esc(s.title)} — ${esc(s.artist)}</option>`).join("")}</select><button class="btn" id="wgo">Write</button>`
      : `<span>Your library is empty. Add a song first, then come back to write about it.</span><button class="btn" data-act="add">Add a song</button>`;
    if ($("wgo")) $("wgo").onclick = () => { curTab = "notes"; location.hash = "#/song/" + $("wsong").value; };
  };
  const filters = () => {
    const list = items();
    const counts = new Map();
    list.forEach((r) => parseTags(r.mood).forEach((t) => counts.set(t, (counts.get(t) || 0) + 1)));
    if (tag && !counts.has(tag)) tag = "";
    $("jtags").innerHTML = [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([t, n]) => `<button type="button" class="fw" data-w="${esc(t)}" aria-pressed="${t === tag}">${esc(t)}<b>${n}</b></button>`).join("");
    $("fwwrap").hidden = !counts.size;
    const seen = new Map();
    list.forEach((r) => seen.set(String(r.song_id), `${r.title} — ${r.artist}`));
    if (songId && !seen.has(songId)) songId = "";
    $("jsong").innerHTML = `<option value="">All songs (${seen.size})</option>` + [...seen.entries()].map(([id, t]) => `<option value="${id}"${id === songId ? " selected" : ""}>${esc(t)}</option>`).join("");
    $("jsong").hidden = seen.size < 2;
  };
  const entry = (r) => journalTab === "mine"
    ? entryHTML({
        song: { id: r.song_id, title: r.title, artist: r.artist, cover: r.cover }, showSong: true, imgAuthor: r.is_public ? me?.displayName || "" : "", design: r.design,
        body: r.body, mood: r.mood, anchor: r.anchor, date: fmtDate(r.created_at) + (r.updated_at ? " · edited" : ""),
        badge: r.is_public ? (r.hidden ? ["Hidden by a moderator", "warn"] : ["Shared with the community", "shared"]) : ["Only you can see this", ""],
        actions: `<a class="link" href="#/song/${r.song_id}">open song</a>`,
      })
    : entryHTML({
        song: { id: r.song_id, title: r.title, artist: r.artist, cover: r.cover }, showSong: true, author: r.author, design: r.design,
        body: r.body, mood: r.mood, anchor: r.anchor, date: fmtDate(r.published_at),
        actions: `<button class="link" data-act="report" data-id="${r.id}">report</button>${me?.isAdmin ? `<button class="link danger" data-act="mhide-post" data-id="${r.id}">hide</button>` : ""}`,
      });

  const empty = (filtered) => {
    if (filtered) return `<div class="empty"><p>Nothing matches those filters.</p><p class="mono">Try a different word, or clear the filters.</p></div>`;
    if (journalTab === "mine") return `<div class="empty"><p>Your journal is empty — and that’s a good place to start.</p><p class="mono">Choose a song above and write one line. Even a single word counts. Only you will see it unless you choose to share.</p></div>`;
    if (!songs.length) return `<div class="empty"><p>This page shows what other people felt about songs <i>you</i> have.</p><p class="mono">Your library is empty, so there is nothing to match yet. Add a song to begin.</p></div>`;
    return `<div class="empty"><p>No one has shared a feeling about your songs yet.</p><p class="mono">Posts appear here only for songs in your library. Add more songs to see more — or be the first: write a feeling and tick “Share”.</p></div>`;
  };
  const paint = () => {
    $("jn-mine").textContent = rows.length ? `(${rows.length})` : "";
    $("jn-comm").textContent = comm.length ? `(${comm.length}${hasMore ? "+" : ""})` : "";
    document.querySelectorAll("[data-jt]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.jt === journalTab)));
    $("jhelp").textContent = journalTab === "mine"
      ? "Everything you have written, newest first. Tap a word to filter by it. Only you can see the ones marked private."
      : "What other people chose to share — only for songs that are in your library. Be kind; you can report anything that isn’t.";
    $("jq").placeholder = journalTab === "mine" ? "e.g. rainy, Mum, a song name, an artist…" : "e.g. a song, an artist, a feeling or a name…";
    $("jqhint").textContent = journalTab === "mine"
      ? "Looks through the words you wrote, song titles, artists, feeling words and the “About” part. Narrow it down with a song or a feeling word."
      : "Looks through what others shared: their words, the song, the artist, feeling words, or the person’s name.";
    writeBox(); filters();
    const list = items().filter(matches);
    const filtered = !!(tag || songId || $("jq").value.trim());
    $("jclear").hidden = !filtered;
    $("jcount").textContent = filtered ? `(${list.length} of ${items().length})` : "";
    $("jlist").innerHTML = list.length ? list.map(entry).join("") : empty(filtered && items().length > 0);
    $("jmore").innerHTML = journalTab === "comm" && hasMore && !filtered ? `<div class="row" style="margin-top:22px"><button class="btn ghost" id="jmorebtn">Show more</button></div>` : "";
    if ($("jmorebtn")) $("jmorebtn").onclick = async () => {
      try { const c = await json("GET", `/api/journal/community?before=${comm[comm.length - 1].id}`); comm = comm.concat(c.items); hasMore = c.hasMore; paint(); } catch (e) { toast(e.message, "err"); }
    };
  };
  document.querySelectorAll("[data-jt]").forEach((b) => (b.onclick = () => { journalTab = b.dataset.jt; tag = ""; songId = ""; $("jq").value = ""; paint(); }));
  $("jtags").onclick = (e) => { const b = e.target.closest(".fw"); if (!b) return; tag = tag === b.dataset.w ? "" : b.dataset.w; paint(); };
  $("jsong").onchange = () => { songId = $("jsong").value; paint(); };
  $("jq").oninput = paint;
  $("jclear").onclick = () => { tag = ""; songId = ""; $("jq").value = ""; paint(); };
  paint();
}

// Searching has its own page (#/search/<query>), so results never get mixed up with your library.
// The server returns up to ~54 songs at once; the page shows them 9 at a time (a 3 × 3 grid) with page numbers.
const PAGE_SIZE = 9;
const SEARCH_CACHE = new Map(); // query -> server answer; back/forward and page changes cost nothing
let CAND = { items: [], page: 0, q: "" };

function goSearch(q) {
  q = String(q || "").trim();
  if (!q) return;
  const target = "#/search/" + encodeURIComponent(q);
  if (location.hash === target) renderSearch(q); else location.hash = target;
}
function bindSearchForm() {
  $("hsearch").onsubmit = (e) => {
    e.preventDefault();
    const q = $("q").value.trim();
    if (!q) { $("q").focus(); return; }
    goSearch(q);
  };
}

async function renderSearch(q) {
  $("navlib").classList.remove("on");
  CAND = { items: [], page: 0, q };
  $("view").innerHTML = `
  <div class="fade">
    <a class="back" href="#/">← Library</a>
    <section class="search-head">
      <span class="lab">Search results</span>
      <form class="hsearch" id="hsearch" role="search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>
        <input id="q" type="text" autocomplete="off" aria-label="Search a song or paste a YouTube link">
        <button class="btn" type="submit" id="find">Find</button>
      </form>
    </section>
    <p class="note status" id="status">Searching…</p>
    <div class="masonry" id="cands">${[1, 2, 3].map(() => `<div class="item"><div class="cov sk" style="background:none"></div><div class="sk" style="height:22px;width:70%;margin-top:14px"></div></div>`).join("")}</div>
    <nav class="pager" id="cpager" aria-label="Result pages" hidden></nav>
    <p class="note" id="notfound" hidden>Not the song you wanted? <button class="more" data-act="addprefill">Add it yourself.</button></p>
  </div>`;
  $("q").value = q;
  bindSearchForm();

  let d = SEARCH_CACHE.get(q);
  if (!d) {
    try {
      d = await json("POST", "/api/identify", { input: q });
      SEARCH_CACHE.set(q, d);
      if (SEARCH_CACHE.size > 30) SEARCH_CACHE.delete(SEARCH_CACHE.keys().next().value);
    } catch (e) {
      if ($("status") && CAND.q === q) { $("status").className = "note status err"; $("status").textContent = e.message; $("cands").innerHTML = ""; }
      return;
    }
  }
  if (!$("cands") || CAND.q !== q) return; // you moved on while we were searching
  const from = d.source ? `From YouTube: “${d.source.title}” — ${d.source.channel}. ` : "";
  $("notfound").hidden = false;
  if (!d.candidates.length) {
    $("cands").innerHTML = "";
    $("status").innerHTML = `${esc(from)}No matching songs found for “${esc(q.length > 60 ? q.slice(0, 60) + "…" : q)}”. Check the spelling, try the artist's name too, or <button class="more" data-act="addprefill">add it yourself.</button>`;
    $("notfound").hidden = true;
    return;
  }
  $("status").className = "note status";
  $("status").textContent = `${from}${d.candidates.length} song${d.candidates.length === 1 ? "" : "s"} found. Choose the right one:`;
  CAND.items = d.candidates;
  renderCandidates();
}

function renderCandidates() {
  const box = $("cands");
  if (!box) return;
  const { items, page } = CAND;
  const pages = Math.ceil(items.length / PAGE_SIZE);
  box.innerHTML = "";
  items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).forEach((c) => {
    const b = document.createElement("button");
    b.className = "item fade";
    b.innerHTML = `${coverHTML(c)}<span class="lab">Match</span><h3>${esc(c.title)}</h3><div class="by">${esc(c.artist)}${c.year ? " · " + esc(c.year) : ""}</div><span class="more">Open.</span>`;
    b.onclick = async () => { try { const s = await saveSong(c); if (s) location.hash = "#/song/" + s.id; } catch (e) { toast(e.message, "err"); } };
    box.append(b);
  });
  const pager = $("cpager");
  pager.hidden = pages <= 1;
  if (pages <= 1) { pager.innerHTML = ""; return; }
  const from = page * PAGE_SIZE + 1, to = Math.min(items.length, (page + 1) * PAGE_SIZE);
  pager.innerHTML =
    `<button type="button" data-act="candpage" data-p="${page - 1}"${page === 0 ? " disabled" : ""}>← Prev</button>` +
    Array.from({ length: pages }, (_, i) => `<button type="button" data-act="candpage" data-p="${i}"${i === page ? ' aria-current="page"' : ""}>${i + 1}</button>`).join("") +
    `<button type="button" data-act="candpage" data-p="${page + 1}"${page >= pages - 1 ? " disabled" : ""}>Next →</button>` +
    `<span class="pinfo">Showing ${from}–${to} of ${items.length}</span>`;
}

/* ---------- Listen: open the song on a music platform, or hear a 30-second preview ---------- */
let PREVIEW = null; // the <audio> playing right now
function stopPreview() { if (PREVIEW) { PREVIEW.pause(); PREVIEW = null; } document.querySelectorAll("[data-act=prev]").forEach((b) => { b.textContent = "▶ 30s"; b.setAttribute("aria-pressed", "false"); }); }
function listenLinks(song) {
  const q = encodeURIComponent(`${song.title} ${song.artist}`);
  const direct = (host) => { try { return new URL(song.listen_url).hostname.endsWith(host) ? song.listen_url : null; } catch { return null; } };
  return [
    ["Apple Music", direct("apple.com") || `https://music.apple.com/my/search?term=${q}`, !!direct("apple.com")],
    ["Spotify", `https://open.spotify.com/search/${q}`, false],
    ["YouTube Music", `https://music.youtube.com/search?q=${q}`, false],
    ["YouTube", `https://www.youtube.com/results?search_query=${q}`, false],
    ["Deezer", direct("deezer.com") || `https://www.deezer.com/search/${q}`, !!direct("deezer.com")],
    ["网易云", `https://music.163.com/#/search/m/?s=${q}`, false],
    ["QQ 音乐", `https://y.qq.com/n/ryqq/search?w=${q}`, false],
  ];
}
function renderListen(song) {
  const box = $("listen");
  if (!box) return;
  const links = listenLinks(song);
  // the main button: the platform you used last; before that, the exact song on Apple/Deezer if we have it, else Spotify
  const pref = store.get("listenPref");
  const main = links.find((l) => l[0] === pref) || links.find((l) => l[2]) || links.find((l) => l[0] === "Spotify");
  const item = ([n, u, d]) => `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer" data-listen="${esc(n)}">${d ? "<i></i>" : "<em></em>"}${esc(n)}<b>↗</b></a>`;
  box.innerHTML = `<span class="listen-split">
      <a class="listen-main" href="${esc(main[1])}" target="_blank" rel="noopener noreferrer" data-listen="${esc(main[0])}">↗ Listen on ${esc(main[0])}</a>
      <details class="listen-menu"><summary aria-label="More music platforms" title="More platforms">▾</summary>
        <div class="listen-pop">${links.map(item).join("")}<small>● opens this exact song · the others search for it. Opens in a new tab.</small></div></details>
    </span>${song.preview_url ? `<button class="listen-prev" type="button" data-act="prev" aria-pressed="false" title="Hear a 30-second preview here">▶ 30s</button>` : ""}`;
}
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-listen]");
  if (a) { store.set("listenPref", a.dataset.listen); const m = a.closest("details"); if (m) m.open = false; setTimeout(() => curSong && renderListen(curSong), 50); return; } // remember the choice
  document.querySelectorAll(".listen-menu[open]").forEach((d) => { if (!d.contains(e.target)) d.open = false; });      // a click elsewhere closes the menu
});
async function loadListen(song) {
  renderListen(song);
  if (song.listen_checked) return;
  try {
    const d = await json("POST", `/api/songs/${song.id}/listen-links`, {});
    if (curSong?.id !== song.id) return;
    song.listen_url = d.url; song.preview_url = d.preview; song.listen_checked = 1;
    renderListen(song);
  } catch {}
}

/* ---------- Song page ---------- */
let curSong = null;
let curTab = "explain";
// The language AI explanations are written in: the saved preference (Account → Profile, default 简体中文).
// The language buttons on a song only change it for that visit.
const prefLang = () => (LANGS.includes(me?.prefLang) ? me.prefLang : "简体中文");
let curLang = "简体中文";

function showTab(name) {
  curTab = name;
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== "p-" + name));
  if (name === "community" && curSong && !COMM.loaded) loadCommunity(curSong);
}
function setLang(l) {
  curLang = l;
  document.querySelectorAll("#langseg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === l)));
}
/* ---------- my feelings: free-form feeling words ---------- */
// A feeling can carry up to 5 words. The suggested ones are only a starting point: type anything, in any language.
const MAX_TAGS = 5, MAX_TAG_LEN = 24;
const PROMPTS = ["This song reminds me of…", "The first time I heard it, I was…", "The line that hits me most is… because…", "If I could tell the singer one thing…", "Right now this song feels like…"];
let TAG_POOL = []; // words I used on earlier feelings, offered again as chips
const parseTags = (m) => String(m || "").split(",").map((t) => t.trim()).filter(Boolean);
const getTags = () => parseTags($("pmood").value);
// A feeling is shown as a small card with a design. The six designs are built differently (not just recoloured):
//   Editorial (the site's own look) · Poster (big type on the song's colour) · Sticky note · Polaroid · Ticket · Letter.
// The same design is used on screen (CSS in index.html) and in the picture you can save (drawn below).
const DESIGNS = [
  { id: "paper", label: "Editorial" }, { id: "poster", label: "Poster" }, { id: "sticky", label: "Sticky note" },
  { id: "polaroid", label: "Polaroid" }, { id: "ticket", label: "Ticket" }, { id: "letter", label: "Letter" },
  { id: "film", label: "Film strip" }, { id: "vinyl", label: "Vinyl" }, { id: "cassette", label: "Cassette" }, { id: "notebook", label: "Notebook" },
  { id: "collage", label: "Collage" }, { id: "receipt", label: "Receipt" }, { id: "postcard", label: "Postcard" }, { id: "magazine", label: "Magazine" }, { id: "stamp", label: "Stamp" },
];
const designOf = (d) => (DESIGNS.some((x) => x.id === d) ? d : "paper"); // an unknown or retired design shows as Editorial
const HAND_STACK = '"Caveat","Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif';
const LETTER_STACK = 'Georgia,"Noto Serif SC","Songti SC","SimSun",serif';
const FEEL = new Map(); // id -> what is needed to draw this card as an image
let feelSeq = 0;
const feelHue = (song) => hueOf((song?.title || "") + (song?.artist || ""));
const feelNo = (body) => String(([...body].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7) >>> 0) % 9000 + 1000); // the number printed on a ticket
function thumbHTML(song) {
  const h = feelHue(song);
  if (!song.cover) return `<span class="e-thumb ph" style="--h:${h}">${esc([...String(song.title)][0] || "♪")}</span>`;
  return `<span class="e-thumb" style="--h:${h}"><img src="${esc(song.cover)}" alt="" loading="lazy" data-initial="${esc([...String(song.title)][0] || "♪")}"></span>`;
}
// song: { id, title, artist, cover, year } · showSong: the song's name is a link on the card · author: public display name · design: card look
// preview: draw the card for the form (no actions, nothing to save, never shortened)
function entryHTML({ song, showSong = false, author = "", you = false, imgAuthor = author, design, body, mood, anchor, date, badge, actions = "", preview = false, empty = false }) {
  const tags = parseTags(mood);
  const d = designOf(design), h = feelHue(song);
  let fid = 0;
  if (!preview) { fid = ++feelSeq; FEEL.set(fid, { song, body, tags, author: imgAuthor, date, design: d }); }
  const rot = (([...body].length % 5) - 2) * 0.6;
  // long writing is shortened on the card, with "Read more" (the whole text is always one tap away)
  const long = !preview && ([...body].length > 260 || body.split("\n").length > 6);
  const head = showSong || author
    ? `<div class="e-head">${showSong ? `<a class="e-song" href="#/song/${song.id}">${thumbHTML(song)}<span><b>${esc(song.title)}</b><small>${esc(song.artist)}</small></span></a>` : ""}${author ? `<span class="by">${showSong ? "shared by " : ""}<b>${esc(author)}</b>${you ? ` <span class="you">you</span>` : ""}</span>` : ""}</div>`
    : "";
  const cap = showSong ? `<a href="#/song/${song.id}">${esc(song.title)} · ${esc(song.artist)}</a>` : `${esc(song.title)} · ${esc(song.artist)}`;
  const photo = song.cover ? `<img src="${esc(song.cover)}" alt="" loading="lazy" data-initial="${esc([...String(song.title)][0] || "♪")}">` : `<span class="ph">${esc([...String(song.title)][0] || "♪")}</span>`;
  return `<article class="entry d-${d}${d === "sticky" ? " note" : ""}${preview ? " preview" : ""}${long ? " clamped" : ""}" style="--h:${h};--rot:${rot}deg"><span class="e-bar"></span>
    <div class="e-ticket"><span class="t1">ADMIT ONE</span><span class="t2">No. ${feelNo(body)}</span></div>
    <div class="e-deco"></div>
    <div class="e-photo">${photo}</div>
    ${head}
    <div class="e-cap">${cap}</div>
    <div class="e-dear">Dear ${esc(song.artist)},</div>
    <blockquote class="e-body${[...body].length < 90 ? " short" : ""}${empty ? " empty" : ""}">${esc(body)}</blockquote>
    ${long ? `<button class="e-more" data-act="emore" type="button" aria-expanded="false">Read more ↓</button>` : ""}
    ${tags.length ? `<div class="e-tags" aria-label="Feeling words">${tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
    <div class="e-sign">— ${esc(imgAuthor || "me")}</div>
    <div class="e-foot">${anchor ? `<span>About: ${esc(anchor)}</span>` : ""}<span>${esc(date)}</span>${badge ? `<span class="badge ${badge[1]}">${esc(badge[0])}</span>` : ""}${preview ? "" : `<span class="push"><button class="link" data-act="fimg" data-fid="${fid}" type="button">${SHARE_IMG ? "share as image" : "save as image"}</button>${actions}</span>`}</div></article>`;
}
const SHARE_IMG = (() => { try { return matchMedia("(pointer:coarse)").matches && !!navigator.canShare?.({ files: [new File([""], "x.png", { type: "image/png" })] }); } catch { return false; } })();

/* ---------- drawing a feeling as a picture (1080 × 1350, entirely in this browser) ---------- */
// Largest text size that fits the box; if even the smallest doesn't fit, the end is cut with "…".
function fitText(ctx, text, fontFn, maxW, maxH, start, min, lhk) {
  let size = start, lines, lh, ok = false;
  for (; size >= min; size -= 2) {
    ctx.font = fontFn(size); lines = wrapLines(ctx, text, maxW); lh = size * lhk;
    if (lines.length * lh <= maxH) { ok = true; break; }
  }
  if (!ok) { size = min; ctx.font = fontFn(size); lines = wrapLines(ctx, text, maxW); lh = size * lhk; }
  const fit = Math.max(1, Math.floor(maxH / lh));
  if (lines.length > fit) { lines = lines.slice(0, fit); lines[fit - 1] = lines[fit - 1].replace(/.{0,2}$/, "") + "…"; }
  return { lines, size, lh };
}
function drawCover(ctx, x, y, s, song, cover, hue, r = 6) {
  ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, s, s, r); ctx.clip();
  if (cover) ctx.drawImage(cover, x, y, s, s);
  else { ctx.fillStyle = `hsl(${hue} 22% 56%)`; ctx.fillRect(x, y, s, s); ctx.fillStyle = "rgba(255,250,240,.85)"; ctx.font = `700 ${s * 0.5}px ${SERIF_STACK}`; ctx.textAlign = "center"; ctx.fillText([...String(song.title || "♪")][0], x + s / 2, y + s * 0.67); ctx.textAlign = "left"; }
  ctx.restore();
}
function drawPills(ctx, tags, x0, y0, maxX, maxY, color, fill, font = `500 28px ${MONO_STACK}`) {
  ctx.font = font; let x = x0, y = y0;
  for (const t of tags) {
    const w = ctx.measureText(t).width + 44;
    if (x + w > maxX) { x = x0; y += 68; }
    if (y > maxY) break;
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.roundRect(x, y, w, 52, 26); ctx.stroke();
    ctx.fillStyle = fill || color; ctx.fillText(t, x + 22, y + 36);
    x += w + 14;
  }
}
function drawFooter(ctx, p, W, H, pad, ink, mute, text) {
  const fy = H - pad - 56;
  ctx.fillStyle = mute; ctx.globalAlpha = 0.4; ctx.fillRect(pad, fy - 44, W - pad * 2, 2); ctx.globalAlpha = 1;
  drawMark(ctx, pad, fy - 8, 56, ink);
  ctx.fillStyle = ink; ctx.font = `700 42px ${SERIF_STACK}`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = "-1px";
  ctx.fillText("Song Explain.", pad + 76, fy + 36);
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  ctx.fillStyle = mute; ctx.font = `400 26px ${MONO_STACK}`; ctx.textAlign = "right";
  ctx.fillText(text ?? (p.author ? `— ${p.author}` : p.date), W - pad, fy + 34); ctx.textAlign = "left";
}
const DRAW = {
  // the site's own look: near-white, black rules, big grotesk type
  paper(ctx, p, cover, W, H, hue) {
    const pad = 96, ink = "#111", mute = "#7b7b78", song = p.song;
    ctx.fillStyle = "#fafaf8"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = ink; ctx.font = `400 26px ${MONO_STACK}`; ctx.fillText("FEELING", pad, 112);
    ctx.textAlign = "right"; ctx.fillStyle = mute; ctx.fillText(p.date, W - pad, 112); ctx.textAlign = "left";
    ctx.fillStyle = ink; ctx.fillRect(pad, 140, 110, 4);
    drawCover(ctx, pad, 190, 130, song, cover, hue);
    const tx = pad + 130 + 32, tw = W - pad - tx;
    ctx.font = `700 40px ${SERIF_STACK}`; const tl = wrapLines(ctx, song.title || "", tw).slice(0, 2);
    tl.forEach((l, i) => ctx.fillText(l, tx, 238 + i * 48));
    ctx.fillStyle = mute; ctx.font = `400 26px ${MONO_STACK}`; ctx.fillText(wrapLines(ctx, song.artist || "", tw)[0] || "", tx, 238 + tl.length * 48 + 4);
    const t = fitText(ctx, p.body, (s) => `700 ${s}px ${SERIF_STACK}`, W - pad * 2, H - pad - 250 - 400, 78, 34, 1.24);
    ctx.fillStyle = ink; ctx.font = `700 ${t.size}px ${SERIF_STACK}`;
    if ("letterSpacing" in ctx) ctx.letterSpacing = `${(-t.size * 0.02).toFixed(1)}px`;
    t.lines.forEach((l, i) => ctx.fillText(l, pad, 400 + t.size + i * t.lh));
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    drawPills(ctx, p.tags, pad, 400 + t.lines.length * t.lh + 40, W - pad, H - pad - 190, ink);
    drawFooter(ctx, p, W, H, pad, ink, mute);
  },
  // the song's colour, huge type
  poster(ctx, p, cover, W, H, hue) {
    const pad = 90, song = p.song, ink = "#fff", mute = "rgba(255,255,255,.75)";
    ctx.fillStyle = `hsl(${hue} 42% 36%)`; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = ink; ctx.font = `500 28px ${MONO_STACK}`;
    if ("letterSpacing" in ctx) ctx.letterSpacing = "4px";
    const cap = `${song.title || ""} — ${song.artist || ""}`.toUpperCase();
    ctx.fillText(wrapLines(ctx, cap, W - pad * 2 - 170)[0] || "", pad, 120);
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    drawCover(ctx, W - pad - 130, 70, 130, song, cover, hue, 4);
    const t = fitText(ctx, p.body, (s) => `700 ${s}px ${SERIF_STACK}`, W - pad * 2, H - pad - 290 - 260, 124, 42, 1.12);
    ctx.fillStyle = ink; ctx.font = `700 ${t.size}px ${SERIF_STACK}`;
    if ("letterSpacing" in ctx) ctx.letterSpacing = `${(-t.size * 0.03).toFixed(1)}px`;
    t.lines.forEach((l, i) => ctx.fillText(l, pad, 290 + t.size + i * t.lh));
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    drawPills(ctx, p.tags, pad, 290 + t.lines.length * t.lh + 44, W - pad, H - pad - 190, ink);
    drawFooter(ctx, p, W, H, pad, ink, mute);
  },
  // a yellow sticky note, taped on
  sticky(ctx, p, cover, W, H, hue) {
    const pad = 96, ink = "#3b3300", mute = "#7a6c1b", ac = "#b08d00", song = p.song;
    ctx.fillStyle = "#fff2a0"; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.translate(W / 2, 20); ctx.rotate(-0.03); ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.fillRect(-120, -22, 240, 64); ctx.restore();
    drawCover(ctx, pad, 110, 130, song, cover, hue);
    const tx = pad + 130 + 32, tw = W - pad - tx;
    ctx.fillStyle = ink; ctx.font = `700 40px ${SERIF_STACK}`; const tl = wrapLines(ctx, song.title || "", tw).slice(0, 2);
    tl.forEach((l, i) => ctx.fillText(l, tx, 158 + i * 48));
    ctx.fillStyle = mute; ctx.font = `400 26px ${MONO_STACK}`; ctx.fillText(wrapLines(ctx, song.artist || "", tw)[0] || "", tx, 158 + tl.length * 48 + 4);
    const t = fitText(ctx, p.body, (s) => `600 ${s}px ${HAND_STACK}`, W - pad * 2, H - pad - 250 - 330, 96, 34, 1.3);
    ctx.fillStyle = ink; ctx.font = `600 ${t.size}px ${HAND_STACK}`;
    t.lines.forEach((l, i) => ctx.fillText(l, pad, 330 + t.size + i * t.lh));
    drawPills(ctx, p.tags, pad, 330 + t.lines.length * t.lh + 40, W - pad, H - pad - 190, ac, ink);
    drawFooter(ctx, p, W, H, pad, ink, mute);
  },
  // a polaroid photo of the album cover, with a handwritten caption
  polaroid(ctx, p, cover, W, H, hue) {
    const song = p.song, ink = "#2a2723", mute = "#8a847a";
    ctx.fillStyle = `hsl(${hue} 18% 80%)`; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate(-0.028);
    ctx.shadowColor = "rgba(0,0,0,.35)"; ctx.shadowBlur = 50; ctx.shadowOffsetY = 24;
    ctx.fillStyle = "#fffdf8"; ctx.fillRect(-440, -580, 880, 1160); ctx.shadowColor = "transparent";
    drawCover(ctx, -390, -530, 780, song, cover, hue, 2);
    ctx.fillStyle = mute; ctx.font = `400 26px ${MONO_STACK}`; ctx.fillText(wrapLines(ctx, `${song.title || ""} · ${song.artist || ""}`, 780)[0] || "", -390, 300);
    const t = fitText(ctx, p.body, (s) => `600 ${s}px ${HAND_STACK}`, 780, 215, 64, 30, 1.25);
    ctx.fillStyle = ink; ctx.font = `600 ${t.size}px ${HAND_STACK}`;
    t.lines.forEach((l, i) => ctx.fillText(l, -390, 335 + t.size + i * t.lh));
    drawPills(ctx, p.tags.slice(0, 5), -390, 335 + t.lines.length * t.lh + 24, 390, 520, mute, mute, `500 22px ${MONO_STACK}`);
    ctx.fillStyle = mute; ctx.font = `400 22px ${MONO_STACK}`; ctx.textAlign = "right"; ctx.fillText(p.author ? `— ${p.author}` : "Song Explain.", 390, 548); ctx.textAlign = "left";
    ctx.restore();
  },
  // a concert ticket stub
  ticket(ctx, p, cover, W, H, hue) {
    const song = p.song, ink = "#1b1a17", mute = "#7a7468", x0 = 64, x1 = W - 64, y0 = 100, y1 = H - 100, pad = 120;
    ctx.fillStyle = "#e6dfcf"; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.shadowColor = "rgba(0,0,0,.3)"; ctx.shadowBlur = 40; ctx.shadowOffsetY = 18;
    ctx.fillStyle = "#f6f1e6"; ctx.beginPath(); ctx.roundRect(x0, y0, x1 - x0, y1 - y0, 14); ctx.fill(); ctx.restore();
    const perf = 330;
    ctx.fillStyle = "#e6dfcf"; for (const x of [x0, x1]) { ctx.beginPath(); ctx.arc(x, y0 + perf, 26, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeStyle = ink; ctx.lineWidth = 3; ctx.setLineDash([14, 12]); ctx.beginPath(); ctx.moveTo(x0 + 40, y0 + perf); ctx.lineTo(x1 - 40, y0 + perf); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = ink; ctx.font = `700 28px ${MONO_STACK}`;
    if ("letterSpacing" in ctx) ctx.letterSpacing = "6px";
    ctx.fillText("ADMIT ONE", pad, y0 + 80); ctx.textAlign = "right"; ctx.fillText(`No. ${feelNo(p.body)}`, x1 - 56, y0 + 80); ctx.textAlign = "left";
    if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    ctx.font = `700 56px ${SERIF_STACK}`; const tl = wrapLines(ctx, song.title || "", x1 - pad - 56 - pad + 56).slice(0, 2);
    tl.forEach((l, i) => ctx.fillText(l, pad, y0 + 160 + i * 62));
    ctx.fillStyle = mute; ctx.font = `400 28px ${MONO_STACK}`; ctx.fillText(wrapLines(ctx, song.artist || "", x1 - pad * 2)[0] || "", pad, y0 + 160 + tl.length * 62 + 4);
    const bTop = y0 + perf + 70, bBottom = y1 - 330;
    const t = fitText(ctx, p.body, (s) => `500 ${s}px ${MONO_STACK}`, x1 - pad * 2 + 56, bBottom - bTop, 46, 26, 1.55);
    ctx.fillStyle = ink; ctx.font = `500 ${t.size}px ${MONO_STACK}`;
    t.lines.forEach((l, i) => ctx.fillText(l, pad, bTop + t.size + i * t.lh));
    drawPills(ctx, p.tags, pad, bTop + t.lines.length * t.lh + 30, x1 - pad, y1 - 250, ink, ink, `500 24px ${MONO_STACK}`);
    // barcode, always the same for the same words
    let seed = Number(feelNo(p.body)); const bars = [];
    for (let x = pad; x < x1 - pad;) { seed = (seed * 9301 + 49297) % 233280; const w = 3 + Math.floor((seed / 233280) * 9); bars.push([x, w]); x += w + 3 + (seed % 5); }
    ctx.fillStyle = ink; bars.forEach(([x, w]) => ctx.fillRect(x, y1 - 230, w, 100));
    ctx.fillStyle = mute; ctx.font = `400 24px ${MONO_STACK}`; ctx.fillText(p.author ? `— ${p.author}   ${p.date}` : p.date, pad, y1 - 76);
    ctx.textAlign = "right"; ctx.fillStyle = ink; ctx.font = `700 30px ${SERIF_STACK}`; ctx.fillText("Song Explain.", x1 - 56, y1 - 76); ctx.textAlign = "left";
  },
  // a handwritten letter to the artist, on ruled paper
  letter(ctx, p, cover, W, H, hue) {
    const song = p.song, ink = "#2b2418", mute = "#8b7f69", red = "rgba(190,70,70,.5)", lx = 190, lh = 66;
    ctx.fillStyle = "#f6efdf"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "rgba(60,90,140,.2)"; for (let y = 330; y < H - 150; y += lh) ctx.fillRect(0, y, W, 2);
    ctx.fillStyle = red; ctx.fillRect(150, 0, 3, H);
    ctx.fillStyle = ink;
    let ds = 62; const dear = `Dear ${song.artist || ""},`; ctx.font = `italic 400 ${ds}px ${LETTER_STACK}`;
    while (ds > 34 && ctx.measureText(dear).width > W - lx - 300) { ds -= 2; ctx.font = `italic 400 ${ds}px ${LETTER_STACK}`; }
    ctx.fillText(dear, lx, 262);
    // postmark
    ctx.save(); ctx.translate(W - 170, 190); ctx.rotate(-0.2); ctx.strokeStyle = red; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, 0, 84, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(0, 0, 68, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = red; ctx.font = `700 22px ${MONO_STACK}`; ctx.textAlign = "center"; ctx.fillText("SONG EXPLAIN", 0, -8); ctx.font = `400 20px ${MONO_STACK}`; ctx.fillText(p.date, 0, 24); ctx.restore();
    const maxLines = Math.floor((H - 330 - 250) / lh);
    ctx.font = `italic 400 50px ${LETTER_STACK}`;
    let lines = wrapLines(ctx, p.body, W - lx - 100);
    if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = lines[maxLines - 1].replace(/.{0,2}$/, "") + "…"; }
    ctx.fillStyle = ink; lines.forEach((l, i) => ctx.fillText(l, lx, 330 + lh * (i + 1) - 16));
    const sy = 330 + lh * (lines.length + 1) + 30;
    ctx.textAlign = "right"; ctx.fillText(`— ${p.author || "me"}`, W - 100, Math.min(sy, H - 190)); ctx.textAlign = "left";
    if (p.tags.length) { ctx.fillStyle = mute; ctx.font = `400 26px ${MONO_STACK}`; ctx.fillText(p.tags.map((t) => "#" + t).join("  "), lx, H - 120); }
    ctx.fillStyle = ink; ctx.font = `700 34px ${SERIF_STACK}`; ctx.textAlign = "right"; ctx.fillText("Song Explain.", W - 100, H - 116); ctx.textAlign = "left";
  },
};
// More designs, drawn the same way (see the CSS in index.html for how they look on screen).
const capLine = (ctx, song, maxW) => wrapLines(ctx, `${song.title || ""} · ${song.artist || ""}`, maxW)[0] || "";
Object.assign(DRAW, {
  // a strip of film: dark frame, sprocket holes, caption in the margin
  film(ctx, p, cover, W, H, hue) {
    const pad = 120, ink = "#f2efe6", mute = "#a8a396", song = p.song;
    ctx.fillStyle = "#161616"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = ink; for (let x = 34; x < W; x += 62) { ctx.beginPath(); ctx.roundRect(x, 24, 30, 44, 6); ctx.fill(); ctx.beginPath(); ctx.roundRect(x, H - 68, 30, 44, 6); ctx.fill(); }
    ctx.strokeStyle = "rgba(242,239,230,.3)"; ctx.lineWidth = 3; ctx.strokeRect(70, 120, W - 140, H - 240);
    ctx.fillStyle = mute; ctx.font = `500 26px ${MONO_STACK}`; ctx.fillText("▶ " + capLine(ctx, song, W - pad * 2 - 40).toUpperCase(), pad, 190);
    const t = fitText(ctx, p.body, (s) => `700 ${s}px ${SERIF_STACK}`, W - pad * 2, H - 250 - 480, 88, 34, 1.26);
    ctx.fillStyle = ink; ctx.font = `700 ${t.size}px ${SERIF_STACK}`;
    t.lines.forEach((l, i) => ctx.fillText(l, pad, 290 + t.size + i * t.lh));
    drawPills(ctx, p.tags, pad, 290 + t.lines.length * t.lh + 36, W - pad, H - 330, ink);
    ctx.fillStyle = mute; ctx.font = `400 26px ${MONO_STACK}`; ctx.fillText(p.author ? `— ${p.author} · ${p.date}` : p.date, pad, H - 175);
    ctx.fillStyle = ink; ctx.font = `700 34px ${SERIF_STACK}`; ctx.textAlign = "right"; ctx.fillText("Song Explain.", W - pad, H - 172); ctx.textAlign = "left";
  },
  // a record sleeve with the disc sliding out, the cover as its label
  vinyl(ctx, p, cover, W, H, hue) {
    const pad = 100, ink = "#221f1a", mute = "#7a7468", song = p.song, cx = W / 2, cy = 420, R = 290;
    ctx.fillStyle = "#f4f0e6"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#111"; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,.1)"; ctx.lineWidth = 2; for (let r = 150; r < R - 6; r += 17) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, 120, 0, Math.PI * 2); ctx.clip();
    if (cover) ctx.drawImage(cover, cx - 120, cy - 120, 240, 240); else { ctx.fillStyle = `hsl(${hue} 30% 60%)`; ctx.fillRect(cx - 120, cy - 120, 240, 240); }
    ctx.restore(); ctx.fillStyle = "#f4f0e6"; ctx.beginPath(); ctx.arc(cx, cy, 14, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = mute; ctx.font = `500 26px ${MONO_STACK}`; ctx.textAlign = "center"; ctx.fillText("SIDE A  ·  " + capLine(ctx, song, W - pad * 2 - 200).toUpperCase(), cx, 780); ctx.textAlign = "left";
    const t = fitText(ctx, p.body, (s) => `700 ${s}px ${SERIF_STACK}`, W - pad * 2, H - pad - 220 - 830, 70, 32, 1.3);
    ctx.fillStyle = ink; ctx.font = `700 ${t.size}px ${SERIF_STACK}`; t.lines.forEach((l, i) => ctx.fillText(l, pad, 830 + t.size + i * t.lh));
    drawPills(ctx, p.tags, pad, 830 + t.lines.length * t.lh + 30, W - pad, H - 260, ink);
    drawFooter(ctx, p, W, H, pad, ink, mute);
  },
  // a cassette label with two reels
  cassette(ctx, p, cover, W, H, hue) {
    const pad = 100, ink = "#3a2c14", mute = "#7a6a45", song = p.song;
    ctx.fillStyle = "#e7d9b8"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#f6edd3"; ctx.strokeStyle = ink; ctx.lineWidth = 5; ctx.beginPath(); ctx.roundRect(pad, 110, W - pad * 2, 240, 14); ctx.fill(); ctx.stroke();
    for (const x of [pad + 150, W - pad - 150]) { ctx.lineWidth = 8; ctx.beginPath(); ctx.arc(x, 230, 56, 0, Math.PI * 2); ctx.stroke(); ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(x, 230, 30, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = ink; ctx.font = `700 30px ${MONO_STACK}`; ctx.textAlign = "center"; ctx.fillText("C-60", W / 2, 215); ctx.font = `500 24px ${MONO_STACK}`; ctx.fillText("SIDE A", W / 2, 255); ctx.textAlign = "left";
    ctx.font = `700 34px ${MONO_STACK}`; ctx.fillText(capLine(ctx, song, W - pad * 2).toUpperCase(), pad, 440);
    const t = fitText(ctx, p.body, (s) => `500 ${s}px ${MONO_STACK}`, W - pad * 2, H - pad - 220 - 500, 52, 26, 1.55);
    ctx.font = `500 ${t.size}px ${MONO_STACK}`; t.lines.forEach((l, i) => ctx.fillText(l, pad, 500 + t.size + i * t.lh));
    drawPills(ctx, p.tags, pad, 500 + t.lines.length * t.lh + 30, W - pad, H - 260, ink, ink, `500 24px ${MONO_STACK}`);
    drawFooter(ctx, p, W, H, pad, ink, mute);
  },
  // graph paper with spiral-binding holes
  notebook(ctx, p, cover, W, H, hue) {
    const pad = 150, ink = "#1f3a5f", mute = "#6a7f98", song = p.song, g = 54;
    ctx.fillStyle = "#fbfbf6"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(120,160,200,.4)"; ctx.lineWidth = 2; for (let x = 0; x < W; x += g) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); } for (let y = 0; y < H; y += g) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    ctx.fillStyle = "#e9e9e2"; for (let y = 70; y < H - 40; y += 90) { ctx.beginPath(); ctx.arc(60, y, 17, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = "#b8b8ae"; ctx.lineWidth = 3; ctx.stroke(); }
    ctx.fillStyle = mute; ctx.font = `400 26px ${MONO_STACK}`; ctx.fillText(p.date, pad, 128); ctx.fillText(capLine(ctx, song, W - pad - 100), pad, 182);
    const fontFn = (s) => `500 ${s}px ${HAND_STACK}`;
    ctx.font = fontFn(54); const lines = wrapLines(ctx, p.body, W - pad - 100); const max = Math.floor((H - 520) / g);
    const shown = lines.slice(0, max); if (lines.length > max) shown[max - 1] = shown[max - 1].replace(/.{0,2}$/, "") + "…";
    ctx.fillStyle = ink; shown.forEach((l, i) => ctx.fillText(l, pad, 290 + i * g));
    drawPills(ctx, p.tags, pad, 290 + shown.length * g + 20, W - 100, H - 250, ink, ink, `500 26px ${MONO_STACK}`);
    drawFooter(ctx, p, W, H, 100, ink, mute);
  },
  // a torn scrap of paper taped onto kraft paper
  collage(ctx, p, cover, W, H, hue) {
    const pad = 110, ink = "#2a2a2a", mute = "#6f685a", song = p.song;
    ctx.fillStyle = "#ddd6c8"; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.translate(W / 2, 600); ctx.rotate(-0.03);
    const sw = W - 240, sh = 740, x0 = -sw / 2, y0 = -sh / 2;
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.moveTo(x0, y0 + 14);
    for (let x = 0; x <= sw; x += 40) ctx.lineTo(x0 + x, y0 + (x % 80 ? 0 : 16));
    ctx.lineTo(x0 + sw, y0 + sh); ctx.lineTo(x0, y0 + sh); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "rgba(255,226,110,.75)"; ctx.fillRect(-90, y0 - 26, 180, 56);
    const t = fitText(ctx, p.body, (s) => `600 ${s}px ${SERIF_STACK}`, sw - 100, sh - 220, 68, 30, 1.35);
    ctx.fillStyle = ink; ctx.font = `600 ${t.size}px ${SERIF_STACK}`; t.lines.forEach((l, i) => ctx.fillText(l, x0 + 50, y0 + 70 + t.size + i * t.lh));
    ctx.fillStyle = mute; ctx.font = `400 24px ${MONO_STACK}`; ctx.fillText(capLine(ctx, song, sw - 100), x0 + 50, y0 + sh - 40);
    ctx.restore();
    drawPills(ctx, p.tags, pad, 1030, W - pad, H - 330, ink, ink, `500 26px ${MONO_STACK}`);
    drawFooter(ctx, p, W, H, pad, ink, mute);
  },
  // a till receipt
  receipt(ctx, p, cover, W, H, hue) {
    const song = p.song, ink = "#161616", mute = "#6f6f6f", rx = 150, rw = W - 300, top = 90, bottom = H - 110;
    ctx.fillStyle = "#e6e6e0"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#fffefa"; ctx.beginPath(); ctx.moveTo(rx, top); ctx.lineTo(rx + rw, top); ctx.lineTo(rx + rw, bottom);
    for (let x = rx + rw; x > rx; x -= 40) { ctx.lineTo(x - 20, bottom + 24); ctx.lineTo(x - 40, bottom); } ctx.closePath(); ctx.fill();
    const px = rx + 60, pw = rw - 120; ctx.textAlign = "center"; ctx.fillStyle = ink; ctx.font = `700 40px ${MONO_STACK}`; ctx.fillText("SONG EXPLAIN", W / 2, top + 100);
    ctx.fillStyle = mute; ctx.font = `400 24px ${MONO_STACK}`; ctx.fillText(`${p.date}   No. ${feelNo(p.body)}`, W / 2, top + 148); ctx.textAlign = "left";
    const dash = (y) => { ctx.strokeStyle = ink; ctx.lineWidth = 3; ctx.setLineDash([12, 10]); ctx.beginPath(); ctx.moveTo(px, y); ctx.lineTo(px + pw, y); ctx.stroke(); ctx.setLineDash([]); };
    dash(top + 190); ctx.fillStyle = ink; ctx.font = `700 32px ${MONO_STACK}`; ctx.fillText("1 x " + capLine(ctx, song, pw - 60), px, top + 250);
    const t = fitText(ctx, p.body, (s) => `500 ${s}px ${MONO_STACK}`, pw, bottom - top - 560, 40, 24, 1.55);
    ctx.font = `500 ${t.size}px ${MONO_STACK}`; t.lines.forEach((l, i) => ctx.fillText(l, px, top + 320 + t.size + i * t.lh));
    const yy = top + 320 + t.lines.length * t.lh + 40; dash(yy);
    ctx.font = `700 30px ${MONO_STACK}`; ctx.fillText("FEELINGS: " + (p.tags.join(", ") || "-").slice(0, 34), px, yy + 56); ctx.fillText("TOTAL  1", px, yy + 106);
    ctx.textAlign = "center"; ctx.fillStyle = mute; ctx.font = `400 24px ${MONO_STACK}`; ctx.fillText(p.author ? `*** THANK YOU, ${p.author.toUpperCase()} ***` : "*** THANK YOU ***", W / 2, bottom - 30); ctx.textAlign = "left";
  },
  // a postcard: message on the left, stamp and address lines on the right
  postcard(ctx, p, cover, W, H, hue) {
    const song = p.song, ink = "#4a2b1a", mute = "#8a6a55", pad = 90;
    ctx.fillStyle = "#f3e3d0"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = ink; ctx.lineWidth = 4; ctx.strokeRect(50, 50, W - 100, H - 100);
    ctx.fillStyle = mute; ctx.font = `500 26px ${MONO_STACK}`; if ("letterSpacing" in ctx) ctx.letterSpacing = "6px"; ctx.fillText("POSTCARD", pad, 130); if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    ctx.setLineDash([10, 8]); ctx.strokeStyle = ink; ctx.lineWidth = 3; ctx.strokeRect(W - pad - 170, 90, 150, 190); ctx.setLineDash([]);
    ctx.fillStyle = `hsl(${hue} 30% 78%)`; ctx.fillRect(W - pad - 160, 100, 130, 170);
    const t = fitText(ctx, p.body, (s) => `600 ${s}px ${HAND_STACK}`, W - pad * 2, H - 700, 84, 34, 1.3);
    ctx.fillStyle = ink; ctx.font = `600 ${t.size}px ${HAND_STACK}`; t.lines.forEach((l, i) => ctx.fillText(l, pad, 400 + t.size + i * t.lh));
    drawPills(ctx, p.tags, pad, 400 + t.lines.length * t.lh + 30, W - pad, H - 330, ink, ink, `500 26px ${MONO_STACK}`);
    ctx.strokeStyle = "rgba(74,43,26,.4)"; ctx.lineWidth = 2; for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(pad, H - 250 + i * 50); ctx.lineTo(W - pad, H - 250 + i * 50); ctx.stroke(); }
    ctx.fillStyle = mute; ctx.font = `400 26px ${MONO_STACK}`; ctx.fillText("to: you, later  ·  re: " + capLine(ctx, song, W - pad * 2 - 260), pad, H - 262 + 0); ctx.fillText(p.author ? `from ${p.author}  ·  ${p.date}` : p.date, pad, H - 162);
  },
  // a magazine cover: the song as the masthead, the feeling as a cover line
  magazine(ctx, p, cover, W, H, hue) {
    const pad = 90, song = p.song, ink = "#fff";
    ctx.fillStyle = `hsl(${hue} 62% 46%)`; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = ink; ctx.font = `500 26px ${MONO_STACK}`; if ("letterSpacing" in ctx) ctx.letterSpacing = "6px"; ctx.fillText("SONG EXPLAIN", pad, 110); ctx.textAlign = "right"; ctx.fillText(`No. ${feelNo(p.body)}`, W - pad, 110); ctx.textAlign = "left"; if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    ctx.fillRect(pad, 140, W - pad * 2, 6);
    const m = fitText(ctx, String(song.title || "").toUpperCase(), (s) => `700 ${s}px ${SERIF_STACK}`, W - pad * 2, 520, 190, 70, 0.98);
    ctx.font = `700 ${m.size}px ${SERIF_STACK}`; if ("letterSpacing" in ctx) ctx.letterSpacing = `${(-m.size * 0.03).toFixed(1)}px`; m.lines.forEach((l, i) => ctx.fillText(l, pad, 190 + m.size * 0.9 + i * m.lh)); if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
    ctx.font = `500 30px ${MONO_STACK}`; ctx.fillText(String(song.artist || "").toUpperCase(), pad, 190 + m.lines.length * m.lh + 50);
    const t = fitText(ctx, p.body, (s) => `700 ${s}px ${SERIF_STACK}`, W - pad * 2 - 160, 380, 62, 30, 1.25);
    const ty = H - 190 - t.lines.length * t.lh; ctx.font = `700 ${t.size}px ${SERIF_STACK}`; t.lines.forEach((l, i) => ctx.fillText(l, pad, ty + t.size + i * t.lh));
    drawPills(ctx, p.tags, pad, H - 150, W - pad - 200, H - 100, ink, ink, `500 24px ${MONO_STACK}`);
    let seed = Number(feelNo(p.body)); for (let x = W - pad - 170, i = 0; i < 28; i++) { seed = (seed * 9301 + 49297) % 233280; ctx.fillRect(x + i * 6, H - 150, 2 + (seed % 3), 60); }
  },
  // a postage stamp: perforated edge, framed picture, postmark
  stamp(ctx, p, cover, W, H, hue) {
    const song = p.song, ink = "#3a2a1a", mute = "#8a7658", bg = `hsl(${hue} 18% 80%)`, x0 = 110, y0 = 110, sw = W - 220, sh = H - 220;
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#fff8ec"; ctx.fillRect(x0, y0, sw, sh);
    ctx.fillStyle = bg; for (let x = x0; x <= x0 + sw; x += 36) { ctx.beginPath(); ctx.arc(x, y0, 12, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(x, y0 + sh, 12, 0, Math.PI * 2); ctx.fill(); }
    for (let y = y0; y <= y0 + sh; y += 36) { ctx.beginPath(); ctx.arc(x0, y, 12, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(x0 + sw, y, 12, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeStyle = ink; ctx.lineWidth = 5; ctx.strokeRect(x0 + 40, y0 + 40, sw - 80, sh - 80);
    ctx.fillStyle = ink; ctx.font = `500 24px ${MONO_STACK}`; ctx.fillText("SONG EXPLAIN", x0 + 70, y0 + 100); ctx.textAlign = "right"; ctx.fillText(`No. ${feelNo(p.body)}`, x0 + sw - 70, y0 + 100); ctx.textAlign = "left";
    const ps = 330; drawCover(ctx, x0 + 70, y0 + 130, ps, song, cover, hue, 4);
    ctx.font = `700 46px ${SERIF_STACK}`; const tl = wrapLines(ctx, song.title || "", sw - 140 - ps - 30).slice(0, 3); tl.forEach((l, i) => ctx.fillText(l, x0 + 70 + ps + 30, y0 + 190 + i * 54));
    ctx.fillStyle = mute; ctx.font = `400 26px ${MONO_STACK}`; ctx.fillText(wrapLines(ctx, song.artist || "", sw - 140 - ps - 30)[0] || "", x0 + 70 + ps + 30, y0 + 200 + tl.length * 54);
    const t = fitText(ctx, p.body, (s) => `600 ${s}px ${SERIF_STACK}`, sw - 140, sh - 560, 52, 26, 1.35);
    ctx.fillStyle = ink; ctx.font = `600 ${t.size}px ${SERIF_STACK}`; t.lines.forEach((l, i) => ctx.fillText(l, x0 + 70, y0 + 540 + t.size + i * t.lh));
    drawPills(ctx, p.tags, x0 + 70, y0 + 540 + t.lines.length * t.lh + 24, x0 + sw - 70, y0 + sh - 150, ink, ink, `500 24px ${MONO_STACK}`);
    ctx.fillStyle = mute; ctx.font = `400 24px ${MONO_STACK}`; ctx.fillText(p.author ? `— ${p.author}  ·  ${p.date}` : p.date, x0 + 70, y0 + sh - 70);
    ctx.save(); ctx.translate(x0 + sw - 160, y0 + sh - 160); ctx.rotate(-0.25); ctx.strokeStyle = "rgba(58,42,26,.5)"; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, 0, 76, 0, Math.PI * 2); ctx.stroke(); for (let i = -50; i <= 50; i += 20) { ctx.beginPath(); ctx.moveTo(-62, i); ctx.lineTo(62, i); ctx.stroke(); } ctx.restore();
  },
});
async function feelingImage(p) {
  const W = 1080, H = 1350, song = p.song || {}, d = designOf(p.design), hue = feelHue(song);
  await loadCardFonts(`${song.title}${song.artist}${p.body}${p.tags.join("")}${p.author}Song Explain.`);
  if (["sticky", "polaroid", "notebook", "postcard"].includes(d)) { try { await document.fonts.load('600 60px "Caveat"', p.body + p.tags.join("")); } catch {} }
  let cover = null;
  if (song.cover) { try { const r = await rawApi("GET", `/api/cover?u=${encodeURIComponent(song.cover)}`); if (r.ok) cover = await createImageBitmap(await r.blob()); } catch {} }
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  ctx.textBaseline = "alphabetic"; ctx.textAlign = "left";
  DRAW[d](ctx, { ...p, song }, cover, W, H, hue);
  return new Promise((res) => c.toBlob(res, "image/png"));
}
async function saveFeelingImage(fid) {
  const p = FEEL.get(fid);
  if (!p) return;
  try {
    toast("Making your card…");
    const blob = await feelingImage(p);
    if (!blob) throw new Error("Could not create the image.");
    const name = `${p.song?.title || "feeling"} - my feeling`.replace(/[\\/:*?"<>|]+/g, "").trim().slice(0, 80) + ".png";
    const file = new File([blob], name, { type: "image/png" });
    if (SHARE_IMG) { await navigator.share({ files: [file], title: p.song?.title || "Song Explain" }); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("Card saved");
  } catch (e) { if (e.name !== "AbortError") toast(e.message, "err"); }
}

/* ---------- the form's card style picker and live preview ---------- */
function setDesign(id) {
  $("pdesign").value = designOf(id) === "paper" ? "" : designOf(id);
  document.querySelectorAll("#designs [data-design]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.design === designOf(id))));
  renderPreview();
}
// Shows how long the writing is. Shared feelings are limited to 1500 characters, so say so before saving fails.
function updateCount() {
  const n = [...$("pbody").value].length, pub = $("ppublic").checked, el = $("pcount");
  if (!el) return;
  el.textContent = pub ? `${n} / 1500 characters (shared feelings can be up to 1500)` : n ? `${n} characters` : "";
  el.classList.toggle("over", pub && n > 1500);
}
function renderPreview() {
  const box = $("fpreview");
  if (!box || !curSong) return;
  const text = $("pbody").value.trim();
  const pub = $("ppublic").checked;
  box.innerHTML = entryHTML({
    song: curSong, preview: true, design: $("pdesign").value, empty: !text,
    body: text || "Your words will appear here, like this…", mood: $("pmood").value, anchor: $("panchor").value.trim(),
    date: new Date().toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }),
    badge: pub ? ["Shared with the community", "shared"] : ["Only you can see this", ""],
  });
}

function setMood(m) {
  $("pmood").value = parseTags(m).slice(0, MAX_TAGS).join(",");
  const sel = getTags();
  const all = [...new Set([...sel, ...MOODS, ...TAG_POOL])];
  $("moods").innerHTML = all.map((t) => `<button type="button" class="mood" data-mood="${esc(t)}" aria-pressed="${sel.includes(t)}">${esc(t)}</button>`).join("");
  $("tagcount").textContent = `${sel.length}/${MAX_TAGS}`;
  renderPreview();
}
function toggleTag(t) {
  const sel = getTags();
  if (sel.includes(t)) return setMood(sel.filter((x) => x !== t).join(","));
  if (sel.length >= MAX_TAGS) return toast(`Up to ${MAX_TAGS} words per feeling`, "err");
  setMood([...sel, t].join(","));
}
function addCustomTags() {
  const raw = $("ptag").value;
  $("ptag").value = "";
  parseTags(raw.replace(/[，、;；]/g, ",")).forEach((t) => { t = t.replace(/\s+/g, " ").slice(0, MAX_TAG_LEN); if (!getTags().includes(t)) toggleTag(t); });
}
async function loadTagPool() {
  try {
    const rows = await json("GET", "/api/journal");
    const n = new Map();
    rows.forEach((r) => parseTags(r.mood).forEach((t) => n.set(t, (n.get(t) || 0) + 1)));
    TAG_POOL = [...n.entries()].filter(([t]) => !MOODS.includes(t)).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t);
    if ($("moods")) setMood($("pmood").value);
  } catch {}
}

async function renderSong(id) {
  $("navlib").classList.remove("on");
  let d;
  try { d = await json("GET", "/api/songs/" + id); } catch (e) { $("view").innerHTML = `<div class="empty"><p>${esc(e.message)}</p><p class="mono"><a href="#/">Back to library</a></p></div>`; return; }
  const { song, explanations, perspectives } = d;
  curSong = song;
  COMM.loaded = false; COMM.items = []; // every render builds a fresh page, so the community feed must be loaded again
  $("view").innerHTML = `
  <div class="fade" id="hero">
    <a class="back" href="#/">← Library</a>
    <header class="song-head">
      ${coverHTML(song)}
      <div>
        <span class="lab">${explanations.length ? "Explained" : "Song"}</span>
        <h1>${esc(song.title)}</h1>
        <p class="artist">${esc(song.artist)}</p>
        <dl class="facts mono">
          ${song.year ? `<dt>Year</dt><dd>${esc(song.year)}</dd>` : ""}${song.album ? `<dt>Album</dt><dd>${esc(song.album)}</dd>` : ""}
          <dt>Lyrics</dt><dd>${song.hasLyrics ? "saved on this computer, private" : "not saved yet"}</dd>
        </dl>
        <div class="row"><div id="listen" class="listen"></div><button class="btn ghost" id="cardbtn">Make a lyric card</button><button class="link danger" id="delsong">Delete song</button></div>
        <div class="row" style="margin-top:6px"><button class="link" id="simbtn">Same song, different spelling?</button></div>
      </div>
    </header>

    <div id="simbox"></div>

    <div class="tabs"><nav class="nav" role="tablist" aria-label="Song sections">
      <button role="tab" class="tab" data-tab="explain">Explanation${explanations.length ? ` (${explanations.length})` : ""}</button>
      <button role="tab" class="tab" data-tab="views">Listeners</button>
      <button role="tab" class="tab" data-tab="community">Community</button>
      <button role="tab" class="tab" data-tab="notes">My feelings${perspectives.length ? ` (${perspectives.length})` : ""}</button>
      <button role="tab" class="tab" data-tab="lyrics">Lyrics</button>
    </nav></div>

    <section class="panel col" id="p-explain">
      <div class="toolbar">
        <div class="seg" id="langseg" role="group" aria-label="Explanation language">${LANGS.map((l) => `<button data-lang="${l}" aria-pressed="false">${l}</button>`).join("")}</div>
        <span id="modelslot"></span>
        <button class="btn" id="explain">Explain this song</button>
        <span id="exstat" class="note" style="margin:0"></span>
      </div>
      <div id="live"></div>
      <div id="exlist"></div>
    </section>

    <section class="panel" id="p-views" hidden>
      <div id="views"><div class="cols">${[1, 2, 3, 4].map(() => `<div class="cm"><div class="sk" style="height:12px;width:40%;margin-bottom:14px"></div><div class="sk" style="height:12px;margin:8px 0"></div><div class="sk" style="height:12px;width:80%"></div></div>`).join("")}</div></div>
    </section>

    <section class="panel col" id="p-community" hidden>
      <span class="lab">What other people here feel about this song</span>
      <p class="note">Shared by people on this app under a display name. Be kind — you can report anything that isn't.</p>
      <div id="community"></div>
    </section>

    <section class="panel col" id="p-notes" hidden>
      <span class="lab">How does this song make you feel?</span>
      <input type="hidden" id="pmood">
      <div class="moods" id="moods"></div>
      <div class="tagadd"><input id="ptag" type="text" maxlength="40" placeholder="Or type your own word, then press Enter — e.g. bittersweet, 想家" autocomplete="off" aria-label="Add your own feeling word"><button type="button" class="btn ghost sm" id="ptagadd">Add</button><span class="mono note" id="tagcount" style="margin:0"></span></div>
      <div class="field"><input id="panchor" type="text" placeholder="About which part? e.g. Chorus, Verse 2 (optional)"></div>
      <div class="field"><textarea id="pbody" placeholder="Anything at all — a memory, a person, a moment, or just one word. Your own words, not the song's."></textarea></div>
      <p class="pcount mono" id="pcount"></p>
      <div class="prompts"><span class="mono">Not sure where to start?</span>${PROMPTS.map((t) => `<button type="button" class="link" data-prompt="${esc(t)}">${esc(t)}</button>`).join("")}</div>
      <input type="hidden" id="pdesign">
      <div class="designs-wrap"><span class="mono">Card style</span>
        <div class="designs" id="designs" role="group" aria-label="Card style">${DESIGNS.map((d) => `<button type="button" data-design="${d.id}" class="dz dz-${d.id}" aria-pressed="${d.id === "paper"}" title="${d.label}"><i></i><span>${d.label}</span></button>`).join("")}</div></div>
      <div class="preview-wrap"><span class="mono">Preview</span><div id="fpreview"></div></div>
      <label class="check"><input type="checkbox" id="ppublic"><span><b>Share this with the other people on this app</b>, under your display name. Don't include personal details. No links, and please don't paste lyrics. You can make it private again any time.</span></label>
      <div class="row" style="margin-top:14px"><button class="btn" id="padd">Save my feeling</button><button class="btn ghost" id="pcancel" hidden>Cancel</button><span id="pstat" class="note" style="margin:0"></span></div>
      <div id="plist" class="plist"></div>
    </section>

    <section class="panel col" id="p-lyrics" hidden>
      <div class="lyr-head"><span class="lab">Lyrics</span><span class="lyr-src" id="lyrsrc"></span></div>
      <p class="note lyr-note">Private to you — nobody else can see them. They are only used to help the AI explain this song. When you press Explain the app looks them up for you; if it can’t find them it will not guess.</p>
      <div id="lyrread">
        <div class="lyr-tools" id="lyrtools" hidden>
          <span class="mono">Text size</span>
          <span class="lyr-sz">${["S", "M", "L"].map((l, i) => `<button type="button" data-act="lyrsize" data-v="${i}" aria-pressed="false" aria-label="Text size ${l}">${l}</button>`).join("")}</span>
          <span class="mono" id="lyrcount"></span>
          <span class="push"><button class="link" data-act="lyrother" type="button" title="These lyrics are wrong? See what other sources have and choose">Wrong lyrics? Try others</button><button class="link" data-act="lyrcopy" type="button">Copy</button><button class="link" data-act="lyredit" type="button">Edit</button></span>
        </div>
        <div id="lyrcands" class="lyr-cands" hidden></div>
        <article class="lyr-view" id="lyrview" hidden></article>
        <div class="lyr-empty" id="lyrempty" hidden>
          <p class="lyr-empty-t">No lyrics saved for this song yet</p>
          <p class="note">Let the app look for them online, or paste them yourself. Please check they are the right song.</p>
          <div class="row"><button class="btn" data-act="lyrfind" type="button">Find lyrics online</button><button class="btn ghost" data-act="lyredit" type="button">Paste my own</button></div>
        </div>
      </div>
      <div id="lyredit" hidden>
        <label class="lyr-label" for="lyr">Paste or fix the lyrics — leave a blank line between verses</label>
        <textarea id="lyr" placeholder="Paste lyrics here"></textarea>
        <div class="row" style="margin-top:14px"><button class="btn" id="savelyr" type="button">Save lyrics</button><button class="btn ghost" id="lyrcancel" type="button">Cancel</button></div>
      </div>
    </section>
  </div>`;

  showTab(curTab);
  renderModelPicker();
  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));
  setLang(prefLang());
  document.querySelectorAll("#langseg button").forEach((b) => (b.onclick = () => setLang(b.dataset.lang)));
  setMood("");
  setDesign("paper");
  loadTagPool();
  $("designs").onclick = (e) => { const b = e.target.closest("[data-design]"); if (b) setDesign(b.dataset.design); };
  ["pbody", "panchor"].forEach((x) => ($(x).oninput = renderPreview));
  $("ppublic").onchange = renderPreview;
  $("pbody").addEventListener("input", () => updateCount());
  $("ppublic").addEventListener("change", () => updateCount());
  $("moods").onclick = (e) => { const b = e.target.closest(".mood"); if (b) toggleTag(b.dataset.mood); };
  $("ptagadd").onclick = addCustomTags;
  $("ptag").onblur = addCustomTags; // leaving the box adds what was typed, so nothing is lost
  $("ptag").onkeydown = (e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addCustomTags(); } };
  document.querySelector(".prompts").onclick = (e) => {
    const b = e.target.closest("[data-prompt]"); if (!b) return;
    const t = $("pbody"); t.value = t.value.trim() ? t.value.replace(/\s+$/, "") + "\n\n" + b.dataset.prompt + " " : b.dataset.prompt + " ";
    t.focus(); t.setSelectionRange(t.value.length, t.value.length);
  };

  loadListen(song);
  $("cardbtn").onclick = () => openCard(song);
  $("delsong").onclick = async () => { if (confirm("Delete this song and everything you saved for it?")) { await json("DELETE", "/api/songs/" + id); toast("Song deleted"); location.hash = "#/"; } };
  setLyricsText(song, "");
  if (song.hasLyrics) json("GET", `/api/songs/${id}/lyrics`).then((r) => { if ($("lyrview")) setLyricsText(song, r.lyrics); }).catch(() => {});
  $("lyrcancel").onclick = () => showLyrEdit(false);
  $("savelyr").onclick = async () => { await json("PUT", `/api/songs/${id}/lyrics`, { lyrics: $("lyr").value }); toast("Lyrics saved"); renderSong(id); };
  $("explain").onclick = () => explain(song);
  $("padd").onclick = async () => {
    try {
      addCustomTags(); // a word typed but not yet added still counts
      const pub = $("ppublic").checked;
      await sendPerspective("POST", `/api/songs/${id}/perspectives`, { body: $("pbody").value, mood: $("pmood").value, anchor: $("panchor").value, design: $("pdesign").value, isPublic: pub });
      toast(pub ? "Saved and shared" : "Saved (private)"); COMM.loaded = false; renderSong(id);
    } catch (e) { $("pstat").className = "note err"; $("pstat").textContent = e.message; }
  };

  if (!store.get("toured_song") && store.get("toured")) tourWhenReady("#exlist .empty, #exlist .article").then(() => { if (curSong === song) startTour(); });
  loadViews(song);
  $("simbtn").onclick = () => checkSimilar(song, true);
  checkSimilar(song, false);

  // saved explanations: newest in full, older versions folded away
  const exCard = (e) => `
    <article class="article"><div class="meta"><span>${esc(e.language)}</span><span>${esc(e.model || e.provider || "")}</span><span>${esc(fmtDate(e.created_at))}</span>
      <button class="link danger push" data-delex="${e.id}">delete</button></div><div class="prose">${md(e.body)}</div></article>`;
  let saved = explanations.slice();
  const drawSaved = () => {
    const open = document.querySelector("#exlist details")?.open; // keep "Earlier explanations" open if it was
    $("exlist").innerHTML = saved.length
      ? exCard(saved[0]) + (saved.length > 1 ? `<details style="margin-top:40px"${open ? " open" : ""}><summary class="note" style="cursor:pointer">Earlier explanations (${saved.length - 1})</summary>${saved.slice(1).map(exCard).join("")}</details>` : "")
      : ctrl ? "" : `<div class="empty" style="margin-top:30px"><p>No explanation yet.</p><p class="mono">Choose a language and press “Explain this song”. It finds the lyrics, reads what listeners say, then writes it up.</p></div>`;
    const tab = document.querySelector('.tab[data-tab="explain"]');
    if (tab) tab.textContent = `Explanation${saved.length ? ` (${saved.length})` : ""}`;
    document.querySelectorAll("[data-delex]").forEach((b) => (b.onclick = async () => {
      await json("DELETE", "/api/explanations/" + b.dataset.delex);
      saved = saved.filter((x) => String(x.id) !== b.dataset.delex);
      drawSaved(); // only the list changes: an explanation that is being written right now stays exactly as it is
    }));
  };
  drawSaved();
  // if an explanation is being written for this song while the page is rebuilt, put the live block and the Stop button back
  if (ctrl && LIVE.songId === id) { $("live").innerHTML = LIVE.html; const b = $("explain"); if (b) { b.textContent = "Stop"; b.classList.add("stop"); } $("exstat").textContent = LIVE.stat; }

  // perspectives
  $("plist").innerHTML = perspectives.length ? `<span class="lab plist-head">Your feelings about this song</span>` : `<div class="empty" style="margin-top:34px"><p>Nothing here yet.</p><p class="mono">Write the first thing this song makes you feel — only you will see it.</p></div>`;
  perspectives.forEach((p) => {
    const tmp = document.createElement("div");
    tmp.innerHTML = entryHTML({
      song, imgAuthor: p.is_public ? me?.displayName || "" : "", design: p.design,
      body: p.body, mood: p.mood, anchor: p.anchor, date: fmtDate(p.created_at) + (p.updated_at ? " · edited" : ""),
      badge: p.is_public ? (p.hidden ? ["Hidden by a moderator", "warn"] : ["Shared with the community", "shared"]) : ["Only you can see this", ""],
      actions: `<button class="link" data-vis>${p.is_public ? "make private" : "share"}</button><button class="link" data-edit>edit</button><button class="link danger" data-del>delete</button>`,
    });
    const el = tmp.firstElementChild;
    el.querySelector("[data-del]").onclick = async () => { if (confirm("Delete this feeling?")) { await json("DELETE", "/api/perspectives/" + p.id); renderSong(id); } };
    el.querySelector("[data-vis]").onclick = async () => {
      try {
        await sendPerspective("PUT", "/api/perspectives/" + p.id, { body: p.body, mood: p.mood || "", anchor: p.anchor || "", design: p.design || "", isPublic: !p.is_public });
        toast(p.is_public ? "Now private" : "Shared with the community"); COMM.loaded = false; renderSong(id);
      } catch (e) { toast(e.message, "err"); }
    };
    el.querySelector("[data-edit]").onclick = () => {
      setMood(p.mood || ""); $("panchor").value = p.anchor || ""; $("pbody").value = p.body; $("ppublic").checked = !!p.is_public; setDesign(p.design || "paper");
      $("padd").textContent = "Update"; $("pcancel").hidden = false;
      $("pcancel").onclick = () => renderSong(id);
      $("padd").onclick = async () => {
        try { addCustomTags(); await sendPerspective("PUT", "/api/perspectives/" + p.id, { body: $("pbody").value, mood: $("pmood").value, anchor: $("panchor").value, design: $("pdesign").value, isPublic: $("ppublic").checked }); toast("Updated"); COMM.loaded = false; renderSong(id); }
        catch (e) { $("pstat").className = "note err"; $("pstat").textContent = e.message; }
      };
      $("pbody").scrollIntoView({ behavior: "smooth", block: "center" });
    };
    $("plist").append(el);
  });
}

/* ---------- one song, one community ---------- */
// The same song can be filed under different artist spellings (e.g. "PA PUN BAND" / "怕胖團"). Ask once, and let the person link them.
async function checkSimilar(song, force) {
  let r;
  try { r = await json("GET", `/api/songs/${song.id}/similar`); } catch { return; }
  const box = $("simbox");
  if (!box || curSong?.id !== song.id) return;
  if (r.auto && !force) {
    box.innerHTML = `<div class="simbox"><b>Linked automatically</b><p>“${esc(song.title)}” matched ${esc(r.auto)} — same title and same cover art — so you share one community. If that is wrong, you can unlink it.</p><button class="link" data-sim="reset">Unlink</button> <button class="link" data-sim-ok>OK</button></div>`;
    box.onclick = async (e) => {
      const b = e.target.closest("button"); if (!b) return;
      try {
        if (b.dataset.sim === "reset") { await json("POST", `/api/songs/${song.id}/group`, { groupKey: "reset" }); COMM.loaded = false; toast("Unlinked"); if (curTab === "community") loadCommunity(song); }
        box.innerHTML = "";
      } catch (err) { toast(err.message, "err"); }
    };
    return;
  }
  if (!force && (r.checked || !r.suggestions.length)) { box.innerHTML = ""; return; }
  if (!r.suggestions.length) { box.innerHTML = `<div class="simbox"><p>No other version of “${esc(song.title)}” was found under a different name. You are already sharing with everyone who has this song.</p><button class="link" data-sim-close>close</button></div>`; box.onclick = () => (box.innerHTML = ""); return; }
  box.innerHTML = `<div class="simbox"><b>Is this the same song?</b>
    <p>Other people here have “${esc(song.title)}” saved under a different artist name. If it is the same song, link them — you will share one community and see each other’s feelings.</p>
    ${r.suggestions.map((x) => `<div class="simrow">${x.cover ? `<img src="${esc(x.cover)}" alt="" loading="lazy">` : ""}<span><b>${esc(x.title)}</b> · ${esc(x.artist)} <span class="mono">${x.people} ${x.people > 1 ? "people" : "person"}${x.strong ? " · same cover art" : ""}</span></span><button class="btn ghost" data-sim="${esc(x.group_key)}">Yes, same song</button></div>`).join("")}
    <button class="link" data-sim="">No, it’s a different song</button></div>`;
  box.onclick = async (e) => {
    const b = e.target.closest("[data-sim]"); if (!b) return;
    try {
      await json("POST", `/api/songs/${song.id}/group`, { groupKey: b.dataset.sim || null });
      box.innerHTML = ""; COMM.loaded = false;
      toast(b.dataset.sim ? "Linked — you now share one community" : "Got it");
      if (b.dataset.sim && curTab === "community") loadCommunity(song);
    } catch (err) { toast(err.message, "err"); }
  };
}

/* ---------- Community: feelings other people on this app chose to share ---------- */
const COMM = { loaded: false, items: [], hasMore: false };
const REPORT_REASON_LABELS = [
  ["spam", "Spam or advertising"], ["harassment", "Harassment or hate"], ["personal-info", "Shows personal information"],
  ["lyrics", "Pastes whole lyrics (copyright)"], ["other", "Something else"],
];

async function loadCommunity(song, more = false) {
  const box = $("community");
  if (!box) return;
  if (!more) { COMM.items = []; box.innerHTML = `<p class="note">Loading…</p>`; }
  try {
    const before = more && COMM.items.length ? COMM.items[COMM.items.length - 1].id : 0;
    const d = await json("GET", `/api/songs/${song.id}/community${before ? `?before=${before}` : ""}`);
    COMM.items = COMM.items.concat(d.items); COMM.hasMore = d.hasMore; COMM.loaded = true;
  } catch (e) { box.innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`; return; }
  renderCommunity(song);
}
function renderCommunity(song) {
  const box = $("community");
  if (!box) return;
  if (!COMM.items.length) {
    box.innerHTML = `<div class="empty" style="margin-top:18px"><p>No one has shared a feeling about this song yet.</p><p class="mono">Write one in “My feelings” and tick “Share” — you could be the first.</p></div>`;
    return;
  }
  box.innerHTML = COMM.items.map((p) => entryHTML({
      song, author: p.author, you: p.mine, design: p.design,
      body: p.body, mood: p.mood, anchor: p.anchor, date: fmtDate(p.published_at),
      actions: `${p.mine ? "" : `<button class="link" data-act="report" data-id="${p.id}">report</button>`}${me?.isAdmin ? `<button class="link danger" data-act="mhide-post" data-id="${p.id}">hide</button>` : ""}`,
    })).join("") +
    (COMM.hasMore ? `<div class="row" style="margin-top:22px"><button class="btn ghost" id="commmore">Show more</button></div>` : "");
  if ($("commmore")) $("commmore").onclick = () => loadCommunity(song, true);
}

// A display name is required before anything is shared. Resolves true once one is set.
let nameResolve = null;
function ensureDisplayName() {
  if (me?.displayName) return Promise.resolve(true);
  return new Promise((resolve) => {
    nameResolve = resolve;
    $("dname-in").value = ""; $("nameerr").textContent = "";
    $("namedlg").showModal(); $("dname-in").focus();
  });
}
$("namesave").onclick = async () => {
  try {
    const d = await json("PUT", "/api/auth/profile", { displayName: $("dname-in").value });
    me.displayName = d.displayName;
    const r = nameResolve; nameResolve = null;
    $("namedlg").close(); r?.(true);
    toast("Display name saved");
  } catch (e) { $("nameerr").textContent = e.message; }
};
$("namedlg").addEventListener("close", () => { if (nameResolve) { nameResolve(false); nameResolve = null; } });
$("dname-in").addEventListener("keydown", (e) => { if (e.key === "Enter") $("namesave").click(); });

// Save/edit a feeling; if sharing needs a display name, ask for it once and retry.
async function sendPerspective(method, url, payload) {
  try { return await json(method, url, payload); }
  catch (e) {
    if (e.code === "NEED_NAME" && (await ensureDisplayName())) return json(method, url, payload);
    throw e;
  }
}

let reportId = 0;
$("repreason").innerHTML = REPORT_REASON_LABELS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("");
$("repsend").onclick = async () => {
  try {
    await json("POST", `/api/perspectives/${reportId}/report`, { reason: $("repreason").value });
    $("reportdlg").close();
    COMM.items = COMM.items.filter((p) => p.id !== reportId);
    if (curSong) renderCommunity(curSong);
    toast("Thank you — a moderator will take a look.");
  } catch (e) { toast(e.message, "err"); }
};

/* ---------- Feedback / bug reports ---------- */
let fbKind = "bug";
function setFbKind(k) {
  fbKind = k;
  document.querySelectorAll("#fbkinds button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === k)));
}
function openFeedback() {
  $("fbmsg").value = ""; $("fbres").textContent = "";
  setFbKind("bug");
  $("fbpage").textContent = `We'll attach the page you're on (${location.hash || "#/"}) and your browser type to help us fix it.`;
  $("fbdlg").showModal(); $("fbmsg").focus();
}
$("fbsend").onclick = async () => {
  $("fbsend").disabled = true; $("fbres").className = "note"; $("fbres").style.margin = "0"; $("fbres").textContent = "Sending…";
  try {
    await json("POST", "/api/feedback", { kind: fbKind, message: $("fbmsg").value, page: location.hash || "#/" });
    $("fbdlg").close(); toast("Thank you — your feedback was sent.");
  } catch (e) { $("fbres").className = "note err"; $("fbres").textContent = e.message; }
  finally { $("fbsend").disabled = false; }
};

// Admin inbox
let fbFilter = "new";
function setFbBadge(n) {
  if (me) me.feedbackNew = n;
  if ($("fbbtn")) $("fbbtn").textContent = n > 0 ? `Feedback (${n} new)` : "Feedback";
}
async function openFeedbackAdmin() {
  $("fbadm").showModal();
  await loadFeedbackAdmin();
}
async function loadFeedbackAdmin() {
  document.querySelectorAll("#fbfilter button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === fbFilter)));
  $("fblist").innerHTML = `<p class="note">Loading…</p>`;
  try {
    const d = await json("GET", `/api/admin/feedback?filter=${fbFilter}`);
    setFbBadge(d.newCount);
    const kindLabel = { bug: "Bug", idea: "Idea", other: "Other" };
    $("fblist").innerHTML = d.items.length
      ? d.items.map((f) => `<div class="modrow">
          <div class="meta"><span>${esc(kindLabel[f.kind] || f.kind)}</span><span>${esc(f.display_name || "—")} · ${esc(f.email || "deleted account")}</span><span>${esc(fmtDate(f.created_at))}</span><span>${esc(f.page || "")}</span><span>${f.status === "new" ? "NEW" : "done"}</span></div>
          <p style="white-space:pre-wrap;margin:8px 0 6px">${esc(f.message)}</p>
          <p class="note" style="margin:0 0 10px">${esc(f.ua || "")}</p>
          <div class="row">${f.status === "new"
            ? `<button class="btn ghost sm" data-act="fbstatus" data-id="${f.id}" data-s="done">Mark done</button>`
            : `<button class="btn ghost sm" data-act="fbstatus" data-id="${f.id}" data-s="new">Reopen</button>`}
            <button class="link danger" data-act="fbdel" data-id="${f.id}">Delete</button></div></div>`).join("")
      : `<div class="empty"><p>${fbFilter === "new" ? "No new feedback." : "No feedback yet."}</p></div>`;
  } catch (e) { $("fblist").innerHTML = `<p class="note err">${esc(e.message)}</p>`; }
}

/* ---------- Invite codes (admins only) ---------- */
async function openInvites() {
  $("invdlg").showModal();
  $("invnew").innerHTML = "";
  await loadInvites();
}
async function loadInvites() {
  try {
    const d = await json("GET", "/api/admin/invites");
    const list = d.invites, cap = d.capacity;
    $("invcap").textContent = cap.max
      ? `Places: ${cap.users} of ${cap.max} taken · ${cap.unused} unused code${cap.unused === 1 ? "" : "s"} out · ${Math.max(0, cap.max - cap.users - cap.unused)} left to invite`
      : `${cap.users} account${cap.users === 1 ? "" : "s"} · ${cap.unused} unused code${cap.unused === 1 ? "" : "s"} · no total limit set (set MAX_USERS to add one)`;
    const when = (s) => (s ? fmtDate(s) : "—");
    $("invlist").innerHTML = list.length
      ? list.map((i) => `<div class="aimodel"><span class="dot ${i.status === "used" ? "ok" : i.status === "unused" ? "idle" : "failed"}"></span>
          <span class="grow">••••-${esc(i.hint)}${i.label ? " · " + esc(i.label) : ""}<br><span class="note" style="margin:0">${
            i.status === "used" ? `used by ${esc(i.used_name || i.used_email || "a deleted account")} on ${esc(when(i.used_at))}`
            : i.status === "unused" ? `unused · expires ${esc(when(i.expires_at))}` : i.status}</span></span>
          ${i.status === "unused" ? `<button class="link danger" data-act="invrevoke" data-id="${i.id}">Revoke</button>` : ""}</div>`).join("")
      : `<p class="note">No codes yet.</p>`;
  } catch (e) { $("invlist").innerHTML = `<p class="note err">${esc(e.message)}</p>`; }
}

let INV_LAST = [];

/* ---------- Moderation queue (admins only) ---------- */
async function openModeration() {
  $("moddlg").showModal();
  $("modlist").innerHTML = `<p class="note">Loading…</p>`;
  try {
    const q = await json("GET", "/api/admin/queue");
    $("modlist").innerHTML = q.length ? q.map((p) => `<div class="modrow">
        <div class="meta"><span>${esc(p.author)} · ${esc(p.author_email)}</span><span>${esc(p.song_title)} — ${esc(p.song_artist)}</span><span>${p.hidden ? "HIDDEN" : "visible"}</span><span>${p.open_reports} report${p.open_reports === 1 ? "" : "s"}${p.reasons ? ": " + esc(p.reasons) : ""}</span></div>
        <p style="white-space:pre-wrap;margin:8px 0 12px">${esc(p.body)}</p>
        <div class="row">${p.hidden ? `<button class="btn ghost sm" data-act="mact" data-do="restore" data-id="${p.id}">Restore</button>` : `<button class="btn sm" data-act="mact" data-do="hide" data-id="${p.id}">Hide</button><button class="btn ghost sm" data-act="mact" data-do="dismiss" data-id="${p.id}">Dismiss reports</button>`}</div></div>`).join("")
      : `<div class="empty"><p>Nothing to review.</p></div>`;
  } catch (e) { $("modlist").innerHTML = `<p class="note err">${esc(e.message)}</p>`; }
}

/* ---------- Listeners (comments) ---------- */
const V = { items: [], seen: new Set(), shown: 0, nOffset: 0, nMore: true, nTotal: 0, ytToken: null, ytMore: true, ytVideo: null, wiki: null, reddit: null };
const VCHUNK = 12;

function addViews(list, source) {
  for (const v of list) {
    if (V.seen.has(v.text)) continue;
    V.seen.add(v.text);
    V.items.push({ ...v, source });
  }
}
const viewCard = (v) => `<div class="cm"><span class="lab">${esc(v.source)}${v.likes == null ? "" : ` · ${v.likes.toLocaleString()} likes`}</span><p>${esc(v.text)}</p></div>`;

function renderViews(song) {
  const box = $("views");
  if (!box) return;
  const q = encodeURIComponent(`${song.title} ${song.artist}`);
  const links = `<div class="links">
      <a target="_blank" rel="noopener" href="https://www.google.com/search?q=${q}+lyrics+meaning">Google</a>
      <a target="_blank" rel="noopener" href="https://www.reddit.com/search/?q=${q}">Reddit</a>
      <a target="_blank" rel="noopener" href="https://genius.com/search?q=${q}">Genius</a>
      <a target="_blank" rel="noopener" href="https://www.zhihu.com/search?q=${q}">知乎</a>
      <a target="_blank" rel="noopener" href="https://music.163.com/#/search/m/?s=${q}">网易云</a>
      <a target="_blank" rel="noopener" href="https://www.youtube.com/results?search_query=${q}">YouTube</a></div>`;
  const hasYt = !!AI.youtube || !!SESS_YT;
  const canMore = V.shown < V.items.length || V.nMore;
  box.innerHTML = `
    ${V.items.length ? `<div class="toolbar"><button class="btn" id="vsum">Summarize what listeners feel</button><span id="vstat" class="note" style="margin:0"></span></div><div id="vlive"></div>` : ""}
    ${V.items.length ? `<div class="cols" style="margin-top:34px">${V.items.slice(0, V.shown).map(viewCard).join("")}</div>` : `<div class="empty"><p>No listener comments found on NetEase for this song.</p><p class="mono">Not every song has them — try the links below.</p></div>`}
    <div class="row" style="margin-top:6px">
      ${canMore && V.items.length ? `<button class="btn ghost" id="vmore">Show more${V.shown >= V.items.length ? " (load next page)" : ""}</button>` : ""}
      ${hasYt && V.ytMore ? `<button class="btn ghost" id="vyt">${V.ytVideo ? "More" : "Load"} YouTube comments</button>` : ""}
      ${!hasYt ? `<button class="btn ghost" data-act="settings">+ Add YouTube comments</button>` : ""}
      ${!V.reddit ? `<button class="btn ghost" id="vreddit">Load Reddit discussions</button>` : ""}
      <span id="vmstat" class="note" style="margin:0"></span>
    </div>
    <p class="note" style="margin-top:26px">${V.items.length} comments loaded${V.nTotal ? ` (NetEase has about ${V.nTotal.toLocaleString()})` : ""} — a sample of public listener comments, not everyone. Names are not shown.${V.ytVideo ? ` YouTube video: <a target="_blank" rel="noopener" href="${esc(V.ytVideo.url)}">${esc(V.ytVideo.title)}</a>.` : ""}${V.reddit?.threads?.length ? ` Reddit: ${V.reddit.threads.map((t) => `<a target="_blank" rel="noopener" href="${esc(t.url)}">${esc(t.title)}</a>`).join(" · ")}.` : ""}${V.wiki ? ` Background: <a target="_blank" rel="noopener" href="${esc(V.wiki.url)}">Wikipedia – ${esc(V.wiki.title)}</a>.` : ""}</p>
    <span class="lab" style="margin-top:30px">Keep exploring</span>${links}`;

  if ($("vsum")) $("vsum").onclick = () => summarizeViews(song);
  if ($("vmore")) $("vmore").onclick = () => showMoreViews(song);
  if ($("vyt")) $("vyt").onclick = () => loadYoutube(song);
  if ($("vreddit")) $("vreddit").onclick = () => loadReddit(song);
}

async function loadNetease(song) {
  const d = await json("GET", `/api/songs/${song.id}/views?source=netease&offset=${V.nOffset}`);
  addViews(d.items, "网易云");
  V.nOffset = d.nextOffset; V.nMore = d.hasMore; V.nTotal = d.total || V.nTotal;
  if (d.wiki) V.wiki = d.wiki;
  return d.items.length;
}

async function showMoreViews(song) {
  $("vmore").disabled = true;
  try {
    // Reveal already-loaded comments first; fetch the next NetEase page only when we run out.
    // Pages are filtered, so keep fetching until something new appears (bounded).
    let guard = 0;
    while (V.shown >= V.items.length && V.nMore && guard++ < 5) { $("vmstat").textContent = "Loading…"; await loadNetease(song); }
    V.shown = Math.min(V.shown + VCHUNK, V.items.length);
  } catch (e) { toast(e.message, "err"); if ($("vmore")) $("vmore").disabled = false; return; }
  renderViews(song);
}

// Reddit discussions about the song (public RSS, no key). Reddit sometimes asks servers to slow down — then say so.
async function loadReddit(song) {
  $("vreddit").disabled = true; $("vmstat").textContent = "Looking on Reddit…";
  try {
    const d = await json("GET", `/api/songs/${song.id}/views?source=reddit`);
    if (d.busy) { $("vreddit").disabled = false; $("vmstat").textContent = ""; toast("Reddit is asking us to slow down. Try again in a few minutes.", "err"); return; }
    V.reddit = d;
    const before = V.items.length;
    addViews(d.items, "Reddit");
    V.shown = Math.min(V.shown + (V.items.length - before), V.items.length);
    renderViews(song);
    toast(d.items.length ? `${d.items.length} Reddit comments added` : "No Reddit discussion found for this song.");
  } catch (e) { toast(e.message, "err"); if ($("vreddit")) { $("vreddit").disabled = false; $("vmstat").textContent = ""; } }
}

async function loadYoutube(song) {
  $("vyt").disabled = true; $("vmstat").textContent = "Loading YouTube comments…";
  try {
    const r = await fetch(`/api/songs/${song.id}/views?source=youtube&pageToken=${encodeURIComponent(V.ytToken || "")}`, { headers: SESS_YT ? { "x-yt-key": SESS_YT } : {} });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "YouTube request failed");
    if (!d.video) { V.ytMore = false; renderViews(song); toast("Couldn't find a matching YouTube video for this song."); return; }
    V.ytVideo = d.video; V.ytToken = d.nextPageToken; V.ytMore = !!d.nextPageToken;
    const before = V.items.length;
    addViews(d.items, "YouTube");
    V.shown = Math.min(V.shown + (V.items.length - before), V.items.length);
    renderViews(song);
  } catch (e) {
    toast(e.message, "err");
    if ($("vyt")) { $("vyt").disabled = false; $("vmstat").textContent = ""; }
  }
}

async function loadViews(song) {
  Object.assign(V, { items: [], seen: new Set(), shown: 0, nOffset: 0, nMore: true, nTotal: 0, ytToken: null, ytMore: true, ytVideo: null, wiki: null, reddit: null });
  try {
    await loadNetease(song);
    V.shown = Math.min(VCHUNK, V.items.length);
  } catch (e) {
    if ($("views")) $("views").innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`;
    return;
  }
  renderViews(song);
}

let vctrl = null;
async function summarizeViews(song) {
  if (vctrl) { vctrl.abort(); return; }
  if (!hasAI()) { toast("Connect an AI model first.", "err"); openSettings(); return; }
  const mine = (vctrl = new AbortController());
  $("vsum").textContent = "Stop"; $("vsum").classList.add("stop");
  $("vstat").className = "note"; $("vstat").textContent = `Reading ${Math.min(V.items.length, 120)} comments…`; $("vlive").innerHTML = "";
  try {
    // Summarize everything loaded so far (not just what is visible), best-liked first.
    const comments = [...V.items].sort((a, b) => b.likes - a.likes).slice(0, 120).map(({ text, likes }) => ({ text, likes }));
    const r = await api("POST", `/api/songs/${song.id}/views/summary`, { language: curLang, comments }, mine.signal);
    if (!r.ok) throw new Error((await r.json()).error);
    const reader = r.body.getReader(), dec = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      if ($("vlive")) $("vlive").innerHTML = `<div class="summary prose">${md(text)}</div>`;
    }
    if ($("vstat")) $("vstat").textContent = "";
  } catch (e) {
    if (e.name === "AbortError") { if ($("vlive")) $("vlive").innerHTML = ""; if ($("vstat")) $("vstat").textContent = "Stopped."; }
    else toast(e.message, "err");
  } finally {
    if (vctrl === mine) vctrl = null;
    if ($("vsum")) { $("vsum").textContent = "Summarize what listeners feel"; $("vsum").classList.remove("stop"); }
  }
}

/* ---------- Explain ---------- */
let ctrl = null; // current explain request, so it can be stopped
const LIVE = { songId: null, html: "", stat: "" }; // what the live block currently shows, so a page rebuild can't lose it
const setLive = (songId, html, stat) => { LIVE.songId = songId; LIVE.html = html; LIVE.stat = stat ?? LIVE.stat; if ($("live")) $("live").innerHTML = html; if (stat != null && $("exstat")) $("exstat").textContent = stat; };
// The answer stopped half-way: tell the person what happened, show what did arrive, and offer the next step.
let INTERRUPTED = null;
function showInterrupted(song, partial, reason) {
  INTERRUPTED = { song, partial, language: curLang };
  const html = `<div class="interrupted" role="alert"><b>The explanation stopped before it was finished</b>
      <p>${esc(reason)}</p>
      <p class="mono">${partial ? "What was written so far is shown below. It has not been saved." : "Nothing was written."}</p>
      <div class="row"><button class="btn" data-act="exretry" type="button">Try again</button>${partial ? `<button class="btn ghost" data-act="exkeep" type="button">Keep what was written</button>` : ""}</div></div>${partial ? `<article class="article partial"><div class="prose">${md(partial)}</div></article>` : ""}`;
  setLive(song.id, html, "");
}
async function explain(song) {
  if (ctrl) { ctrl.abort(); return; } // button acts as Stop while running
  if (!hasAI()) { toast("Connect an AI model first.", "err"); openSettings(true); return; }
  const mine = (ctrl = new AbortController());
  const btn = $("explain");
  btn.textContent = "Stop"; btn.classList.add("stop");
  $("exstat").className = "note"; $("exstat").textContent = "Finding the lyrics and what listeners say…";
  setLive(song.id, `<div class="article"><div class="sk" style="height:26px;width:60%;margin-bottom:22px"></div><div class="sk" style="height:12px;margin:12px 0"></div><div class="sk" style="height:12px;width:92%;margin:12px 0"></div><div class="sk" style="height:12px;width:76%;margin:12px 0"></div></div>`, "Finding the lyrics and what listeners say…");
  let text = "";
  try {
    const r = await api("POST", `/api/songs/${song.id}/explain`, { language: curLang }, mine.signal);
    if (!r.ok) throw new Error((await r.json()).error);
    const reader = r.body.getReader(), dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      setLive(song.id, `<article class="article"><div class="prose caret">${md(text)}</div></article>`, "Writing…");
    }
    ctrl = null;
    const cut = text.match(/\n*\[Error: ([\s\S]*)\]\s*$/);
    if (!cut) return renderSong(song.id); // reload: shows the saved copy
    showInterrupted(song, text.slice(0, cut.index).trim(), cut[1]);
  } catch (e) {
    if (e.name === "AbortError") {
      // partial text is discarded and not saved (the page may already have changed if the user navigated away)
      if ($("live")) $("live").innerHTML = "";
      if ($("exstat")) $("exstat").textContent = "Stopped — nothing was saved.";
    } else if (text.trim()) {
      // the connection broke while the answer was arriving: keep what arrived and say what happened
      showInterrupted(song, text.replace(/\n*\[Error: [\s\S]*$/, "").trim(), /network|fetch|connection|terminated|load failed/i.test(String(e.message)) ? "The connection was lost while the answer was being written. Check your internet and try again." : e.message);
    } else {
      if ($("live")) $("live").innerHTML = "";
      if ($("exstat")) $("exstat").textContent = "";
      const lyricsMissing = /lyrics/i.test(e.message) && /find|没有找到/.test(e.message);
      if (lyricsMissing && $("live")) {
        const q = encodeURIComponent(`${song.title} ${song.artist} lyrics 歌词`);
        $("live").innerHTML = `<div class="empty" style="margin-top:30px"><p>${esc(e.message.split(" / ")[0])}</p>
          <div class="links"><a target="_blank" rel="noopener" href="https://www.google.com/search?q=${q}">Google</a><a target="_blank" rel="noopener" href="https://genius.com/search?q=${q}">Genius</a><a target="_blank" rel="noopener" href="https://music.163.com/#/search/m/?s=${q}">网易云</a></div>
          <p style="margin-top:18px"><button class="btn ghost" data-act="pastelyrics">Paste the lyrics</button></p></div>`;
      } else {
        toast(e.message, "err");
        if (/AI settings|no longer connected|connection test/i.test(e.message)) loadAI(); // the picked model may have been removed or failed
      }
    }
  } finally {
    if (ctrl === mine) ctrl = null;
    const b = $("explain");
    if (b) { b.textContent = "Explain this song"; b.classList.remove("stop"); }
  }
}

/* ---------- Lyric card ---------- */
const CARD = { song: null, lines: [], picked: [], mode: "lyrics", theme: "paper", design: "classic", format: "story", own: "", cover: null, tint: null, lyricsLoaded: false, seq: 0 };
const CARD_MAX_LINES = 4, CARD_MAX_CHARS = 220;
const SERIF_STACK = '"Space Grotesk","Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif';
const MONO_STACK = '"DM Mono","Noto Sans SC","PingFang SC","Microsoft YaHei",ui-monospace,Consolas,monospace';

function setSeg(id, value) {
  document.querySelectorAll(`#${id} button`).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === value)));
}
function bindSeg(id, key) {
  document.querySelectorAll(`#${id} button`).forEach((b) => (b.onclick = () => { CARD[key] = b.dataset.v; setSeg(id, b.dataset.v); if (key === "mode") renderCardPicker(); drawCard(); }));
}

async function openCard(song) {
  Object.assign(CARD, { song, lines: [], picked: [], own: "", cover: null, tint: null, lyricsLoaded: false });
  $("cdesign").innerHTML = LYRIC_DESIGNS.map(([id, label]) => `<button data-v="${id}" aria-pressed="false">${label}</button>`).join("");
  setSeg("cmode", CARD.mode); setSeg("cdesign", CARD.design); setSeg("ctheme", CARD.theme); setSeg("cfmt", CARD.format);
  bindSeg("cmode", "mode"); bindSeg("cdesign", "design"); bindSeg("ctheme", "theme"); bindSeg("cfmt", "format");
  $("cshare").hidden = !(navigator.canShare && navigator.canShare({ files: [new File([""], "x.png", { type: "image/png" })] }));
  $("carddlg").showModal();
  renderCardPicker(); drawCard();
  loadCardCover(song); loadCardLyrics(song);
}

async function loadCardCover(song) {
  if (!song.cover) return;
  try {
    const r = await rawApi("GET", `/api/cover?u=${encodeURIComponent(song.cover)}`);
    if (!r.ok) return;
    const bmp = await createImageBitmap(await r.blob());
    if (CARD.song !== song) return;
    CARD.cover = bmp; CARD.tint = averageColor(bmp);
    drawCard();
  } catch {}
}
function averageColor(bmp) {
  const c = document.createElement("canvas"); c.width = c.height = 24;
  const g = c.getContext("2d"); g.drawImage(bmp, 0, 0, 24, 24);
  const d = g.getImageData(0, 0, 24, 24).data;
  let r = 0, gr = 0, b = 0, w = 0;
  for (let i = 0; i < d.length; i += 4) {
    const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
    const wt = 0.15 + (mx - mn) / 255; // favour colourful pixels over grey ones
    r += d[i] * wt; gr += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
  }
  return [r / w, gr / w, b / w];
}
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, s, l];
}

async function loadCardLyrics(song, find = false) {
  try {
    const d = find ? await json("POST", `/api/songs/${song.id}/lyrics/find`, {}) : await json("GET", `/api/songs/${song.id}/lyrics`);
    if (CARD.song !== song) return;
    CARD.lines = String(d.lyrics || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 400);
  } catch (e) {
    if (find) toast(e.message, "err");
  }
  CARD.lyricsLoaded = true;
  renderCardPicker();
}

function renderCardPicker() {
  const box = $("cpick");
  if (CARD.mode === "own") {
    box.innerHTML = `<div class="field"><textarea id="cown" maxlength="${CARD_MAX_CHARS}" style="min-height:120px" placeholder="A line that means something to you…"></textarea><label id="cown-n">${CARD.own.length} / ${CARD_MAX_CHARS}</label></div>`;
    $("cown").value = CARD.own;
    $("cown").oninput = () => { CARD.own = $("cown").value; $("cown-n").textContent = `${CARD.own.length} / ${CARD_MAX_CHARS}`; drawCard(); };
    return;
  }
  if (!CARD.lyricsLoaded) { box.innerHTML = `<p class="note">Loading lyrics…</p>`; return; }
  if (!CARD.lines.length) {
    box.innerHTML = `<p class="note">No lyrics are saved for this song yet.</p><div class="row"><button class="btn ghost sm" id="cfind">Find lyrics online</button></div>`;
    $("cfind").onclick = async () => { $("cfind").disabled = true; $("cfind").textContent = "Searching…"; await loadCardLyrics(CARD.song, true); };
    return;
  }
  box.innerHTML = `<div class="field"><label>Tap up to ${CARD_MAX_LINES} lines · <span id="cpicked">${CARD.picked.length}</span> chosen</label><div class="lines" id="clines">${CARD.lines.map((l, i) => `<button type="button" class="line" data-i="${i}" aria-pressed="${CARD.picked.includes(i)}">${esc(l)}</button>`).join("")}</div></div>`;
  document.querySelectorAll("#clines .line").forEach((b) => (b.onclick = () => {
    const i = Number(b.dataset.i);
    if (CARD.picked.includes(i)) CARD.picked = CARD.picked.filter((x) => x !== i);
    else {
      const next = [...CARD.picked, i].sort((a, c) => a - c);
      if (next.length > CARD_MAX_LINES) return toast(`Up to ${CARD_MAX_LINES} lines per card.`, "err");
      if (next.map((x) => CARD.lines[x]).join("\n").length > CARD_MAX_CHARS) return toast("That is a bit long for one card — pick shorter lines.", "err");
      CARD.picked = next;
    }
    b.setAttribute("aria-pressed", String(CARD.picked.includes(i)));
    $("cpicked").textContent = CARD.picked.length;
    drawCard();
  }));
}

function cardColors() {
  if (CARD.theme === "ink") return { bg: "#121211", fg: "#f1f1ee", mute: "rgba(241,241,238,.58)" };
  if (CARD.theme === "color") {
    const [h, s] = rgbToHsl(...(CARD.tint || [120, 100, 90]));
    return { bg: `hsl(${Math.round(h)} ${Math.round(Math.min(s, 0.5) * 100)}% 30%)`, fg: "#f8f4ee", mute: "rgba(248,244,238,.68)" };
  }
  return { bg: "#fafaf8", fg: "#111111", mute: "#7b7b78" };
}

// Break text into lines that fit maxW. CJK breaks per character; Latin per word; keeps closing punctuation with the line.
function wrapLines(ctx, text, maxW) {
  const out = [];
  const NO_START = "，。！？、；：）】」』”’,.!?;:)]}…";
  for (const para of String(text).split("\n")) {
    const tokens = para.match(/[぀-ヿ㐀-鿿＀-￯]|[^\s぀-ヿ㐀-鿿＀-￯]+|\s+/g) || [];
    let line = "";
    for (const t of tokens) {
      const trial = line + t;
      if (ctx.measureText(trial.trimEnd()).width <= maxW || !line.trim() || NO_START.includes(t)) line = trial;
      else { out.push(line.trimEnd()); line = t.trimStart(); }
    }
    out.push(line.trimEnd());
  }
  return out;
}

function drawMark(ctx, x, y, size, color) {
  const k = size / 64;
  ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 6.5;
  ctx.beginPath(); ctx.arc(29, 29, 19, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(29, 29, 5.5, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(53, 53, 7.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

async function loadCardFonts(text) {
  try {
    await Promise.all([
      document.fonts.load('700 60px "Space Grotesk"', text), document.fonts.load('400 24px "DM Mono"', text),
      document.fonts.load('700 60px "Noto Sans SC"', text), document.fonts.load('400 24px "Noto Sans SC"', text),
    ]);
  } catch {}
}

/* ---------- lyric card designs: the same hand-built looks as the feeling cards, filled with the lines you chose ---------- */
// Each design is drawn at 1080 × 1350 and then placed on the card (centred, on its own background colour), so every
// design works in both sizes — Story 9:16 and Square 1:1.
Object.assign(DRAW, {
  // a film still: the cover, darkened, with the line as a subtitle
  subtitle(ctx, p, cover, W, H, hue) {
    const song = p.song;
    ctx.fillStyle = `hsl(${hue} 22% 16%)`; ctx.fillRect(0, 0, W, H);
    if (cover) { const s = Math.max(W / cover.width, H / cover.height) * 1.05; ctx.drawImage(cover, (W - cover.width * s) / 2, (H - cover.height * s) / 2, cover.width * s, cover.height * s); }
    ctx.fillStyle = "rgba(0,0,0,.42)"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, 170); ctx.fillRect(0, H - 170, W, 170);
    const t = fitText(ctx, p.body, (s) => `500 ${s}px ${SERIF_STACK}`, W - 200, 330, 62, 30, 1.3);
    const top = H - 170 - 60 - t.lines.length * t.lh;
    ctx.textAlign = "center"; ctx.font = `500 ${t.size}px ${SERIF_STACK}`;
    t.lines.forEach((l, i) => { const y = top + t.size + i * t.lh, w = ctx.measureText(l).width; ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.fillRect(W / 2 - w / 2 - 18, y - t.size * 0.95, w + 36, t.size * 1.3); ctx.fillStyle = "#fff"; ctx.fillText(l, W / 2, y); });
    ctx.fillStyle = "#cfcfcf"; ctx.font = `400 26px ${MONO_STACK}`; ctx.fillText(capLine(ctx, song, W - 200).toUpperCase(), W / 2, H - 86); ctx.textAlign = "left";
    ctx.fillStyle = "rgba(255,255,255,.7)"; ctx.font = `500 24px ${MONO_STACK}`; ctx.fillText("SONG EXPLAIN", 60, 100);
  },
  // a typed page
  typewriter(ctx, p, cover, W, H, hue) {
    const pad = 130, ink = "#1d1b17", mute = "#8a857a", song = p.song;
    ctx.fillStyle = "#f7f5ef"; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(0,0,0,.06)"; ctx.lineWidth = 2; for (let y = 230; y < H - 120; y += 70) { ctx.beginPath(); ctx.moveTo(60, y); ctx.lineTo(W - 60, y); ctx.stroke(); }
    ctx.fillStyle = mute; ctx.font = `400 28px ${MONO_STACK}`; ctx.fillText("Dear listener,", pad, 190);
    const t = fitText(ctx, p.body, (s) => `500 ${s}px ${MONO_STACK}`, W - pad * 2, H - 520, 56, 28, 1.6);
    ctx.fillStyle = ink; ctx.font = `500 ${t.size}px ${MONO_STACK}`; t.lines.forEach((l, i) => ctx.fillText(l, pad, 290 + t.size + i * t.lh));
    const cy = 290 + t.size + (t.lines.length - 1) * t.lh; ctx.fillRect(pad + ctx.measureText(t.lines[t.lines.length - 1]).width + 6, cy - t.size * 0.8, 4, t.size * 0.95);
    ctx.fillStyle = mute; ctx.font = `400 28px ${MONO_STACK}`; ctx.fillText("— " + capLine(ctx, song, W - pad * 2 - 40), pad, H - 200);
    ctx.fillStyle = ink; ctx.font = `700 34px ${SERIF_STACK}`; ctx.textAlign = "right"; ctx.fillText("Song Explain.", W - pad, H - 120); ctx.textAlign = "left";
  },
  // a newspaper clipping with the line as the headline
  newspaper(ctx, p, cover, W, H, hue) {
    const pad = 100, ink = "#1a1a1a", mute = "#6c6552", song = p.song;
    ctx.fillStyle = "#eadfc8"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = ink; ctx.font = `700 78px ${SERIF_STACK}`; ctx.textAlign = "center"; ctx.fillText("THE DAILY SONG", W / 2, 190); ctx.textAlign = "left";
    ctx.fillRect(pad, 130 - 40, W - pad * 2, 4); ctx.fillRect(pad, 230, W - pad * 2, 4); ctx.fillRect(pad, 242, W - pad * 2, 2);
    ctx.fillStyle = mute; ctx.font = `400 24px ${MONO_STACK}`; ctx.fillText((song.year ? "VOL. " + song.year : "SPECIAL EDITION"), pad, 290); ctx.textAlign = "right"; ctx.fillText("PRICE: ONE LISTEN", W - pad, 290); ctx.textAlign = "left";
    const t = fitText(ctx, "“" + p.body.replace(/\n/g, " ") + "”", (s) => `700 ${s}px ${SERIF_STACK}`, W - pad * 2, 540, 84, 36, 1.2);
    ctx.fillStyle = ink; ctx.font = `700 ${t.size}px ${SERIF_STACK}`; t.lines.forEach((l, i) => ctx.fillText(l, pad, 360 + t.size + i * t.lh));
    const by = 360 + t.lines.length * t.lh + 50; ctx.fillRect(pad, by, W - pad * 2, 3);
    ctx.font = `500 28px ${MONO_STACK}`; ctx.fillStyle = mute; ctx.fillText("by " + capLine(ctx, song, W - pad * 2 - 80), pad, by + 56);
    const cw = (W - pad * 2 - 60) / 2; ctx.fillStyle = "rgba(0,0,0,.14)"; for (let c = 0; c < 2; c++) for (let y = by + 100; y < H - 220; y += 30) ctx.fillRect(pad + c * (cw + 60), y, cw * (0.7 + ((y * 7 + c * 13) % 30) / 100), 10);
    ctx.fillStyle = ink; ctx.font = `700 34px ${SERIF_STACK}`; ctx.textAlign = "right"; ctx.fillText("Song Explain.", W - pad, H - 90); ctx.textAlign = "left";
  },
});
const LYRIC_DESIGNS = [["classic", "Classic"], ["vinyl", "Vinyl"], ["cassette", "Cassette"], ["polaroid", "Polaroid"], ["subtitle", "Film subtitle"], ["typewriter", "Typewriter"], ["newspaper", "Newspaper"], ["poster", "Poster"], ["stamp", "Stamp"]];
// Draws one of the designs onto the lyric card canvas, whatever its size.
function drawLyricDesign(ctx, W, H, p, cover, hue) {
  const off = document.createElement("canvas"); off.width = 1080; off.height = 1350;
  const o = off.getContext("2d"); o.textBaseline = "alphabetic"; o.textAlign = "left";
  DRAW[CARD.design](o, p, cover, 1080, 1350, hue);
  const px = o.getImageData(3, 3, 1, 1).data; // the design's own background colour fills whatever the size leaves over
  ctx.fillStyle = `rgb(${px[0]},${px[1]},${px[2]})`; ctx.fillRect(0, 0, W, H);
  const s = Math.min(W / 1080, H / 1350), w = 1080 * s, h = 1350 * s;
  ctx.drawImage(off, (W - w) / 2, (H - h) / 2, w, h);
}

async function drawCard() {
  const seq = ++CARD.seq;
  const song = CARD.song;
  if (!song) return;
  const quote = CARD.mode === "own" ? CARD.own.trim() : CARD.picked.map((i) => CARD.lines[i]).join("\n");
  await loadCardFonts(`${song.title}${song.artist}${quote}Song Explain.`);
  if (seq !== CARD.seq) return; // a newer draw superseded this one
  $("cthemef").hidden = CARD.design !== "classic"; // the paper / ink / cover-colour choice belongs to the classic design only
  if (CARD.design !== "classic") {
    if (["polaroid"].includes(CARD.design)) { try { await document.fonts.load('600 60px "Caveat"', quote); } catch {} }
    if (seq !== CARD.seq) return;
    const c2 = $("cardcv"), W2 = 1080, H2 = CARD.format === "story" ? 1920 : 1080;
    c2.width = W2; c2.height = H2;
    const placeholder = CARD.mode === "own" ? "Write the words you want to share." : "Choose the lines you love.";
    drawLyricDesign(c2.getContext("2d"), W2, H2, { body: quote || placeholder, tags: [], author: "", date: song.year || "", song }, CARD.cover, feelHue(song));
    return;
  }

  const c = $("cardcv"), W = 1080, H = CARD.format === "story" ? 1920 : 1080, story = CARD.format === "story";
  c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const col = cardColors(), pad = 90;
  ctx.fillStyle = col.bg; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = "alphabetic";
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";

  // --- header: cover + title/artist
  const cs = story ? 250 : 190, cx = pad, cy = story ? 150 : 90;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.28)"; ctx.shadowBlur = 36; ctx.shadowOffsetY = 14;
  ctx.beginPath(); ctx.roundRect(cx, cy, cs, cs, 6); ctx.fillStyle = "#cfc8bd"; ctx.fill();
  ctx.restore();
  ctx.save(); ctx.beginPath(); ctx.roundRect(cx, cy, cs, cs, 6); ctx.clip();
  if (CARD.cover) ctx.drawImage(CARD.cover, cx, cy, cs, cs);
  else {
    const hue = [...song.title + song.artist].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) | 0, 7);
    ctx.fillStyle = `hsl(${Math.abs(hue) % 360} 22% 56%)`; ctx.fillRect(cx, cy, cs, cs);
    ctx.fillStyle = "rgba(255,250,240,.85)"; ctx.font = `700 ${cs * 0.5}px ${SERIF_STACK}`; ctx.textAlign = "center";
    ctx.fillText([...song.title][0] || "♪", cx + cs / 2, cy + cs * 0.67);
    ctx.textAlign = "left";
  }
  ctx.restore();

  const tx = cx + cs + 44, tw = W - pad - tx;
  ctx.fillStyle = col.fg; ctx.font = `700 ${story ? 54 : 44}px ${SERIF_STACK}`;
  let tl = wrapLines(ctx, song.title, tw);
  if (tl.length > 2) { tl = tl.slice(0, 2); tl[1] = tl[1].replace(/.{1}$/, "…"); }
  const tsz = story ? 54 : 44, tTop = cy + cs / 2 - (tl.length * tsz * 1.15 + 50) / 2 + tsz;
  tl.forEach((l, i) => ctx.fillText(l, tx, tTop + i * tsz * 1.15));
  ctx.fillStyle = col.mute; ctx.font = `400 ${story ? 30 : 26}px ${MONO_STACK}`;
  const artistLine = wrapLines(ctx, song.artist, tw)[0] || "";
  ctx.fillText(artistLine, tx, tTop + tl.length * tsz * 1.15 + 18);

  // --- quote block
  const areaTop = cy + cs + (story ? 150 : 90), areaBottom = H - pad - 130, areaH = areaBottom - areaTop, maxW = W - pad * 2;
  const placeholder = !quote;
  const text = placeholder ? (CARD.mode === "own" ? "Write the words you want to share." : "Choose the lines you love.") : quote;
  let size = story ? 100 : 84, lines, lh;
  for (; size >= 34; size -= 4) {
    ctx.font = `700 ${size}px ${SERIF_STACK}`;
    lines = wrapLines(ctx, text, maxW); lh = size * 1.22;
    if (lines.length * lh + 60 <= areaH) break;
  }
  if (placeholder) { size = Math.min(size, story ? 64 : 56); ctx.font = `700 ${size}px ${SERIF_STACK}`; lines = wrapLines(ctx, text, maxW); lh = size * 1.22; }
  const blockH = 40 + lines.length * lh;
  const y0 = areaTop + Math.max(0, (areaH - blockH) * 0.4);
  ctx.fillStyle = placeholder ? col.mute : col.fg;
  ctx.fillRect(pad, y0, 110, 4); // short rule, like the site's labels
  ctx.font = `700 ${size}px ${SERIF_STACK}`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = `${(-size * 0.02).toFixed(2)}px`;
  lines.forEach((l, i) => ctx.fillText(l, pad, y0 + 40 + size + i * lh - size * 0.18));
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";

  // --- footer: hairline, logo and wordmark
  const fy = H - pad - 56;
  ctx.fillStyle = col.mute; ctx.globalAlpha = 0.45; ctx.fillRect(pad, fy - 44, W - pad * 2, 2); ctx.globalAlpha = 1;
  drawMark(ctx, pad, fy - 8, 56, col.fg);
  ctx.fillStyle = col.fg; ctx.font = `700 42px ${SERIF_STACK}`;
  if ("letterSpacing" in ctx) ctx.letterSpacing = "-1px";
  ctx.fillText("Song Explain.", pad + 76, fy + 36);
  if ("letterSpacing" in ctx) ctx.letterSpacing = "0px";
  ctx.fillStyle = col.mute; ctx.font = `400 26px ${MONO_STACK}`; ctx.textAlign = "right";
  ctx.fillText(song.year || "", W - pad, fy + 34); ctx.textAlign = "left";
}

function cardBlob() { return new Promise((res) => $("cardcv").toBlob(res, "image/png")); }
function cardFileName() {
  return `${CARD.song.title} - ${CARD.song.artist}`.replace(/[\\/:*?"<>|]+/g, "").trim().slice(0, 80) + ".png";
}
$("cdl").onclick = async () => {
  try {
    await drawCard();
    const blob = await cardBlob();
    if (!blob) throw new Error("Could not create the image.");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = cardFileName(); a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast("Card saved");
  } catch (e) { toast(e.message, "err"); }
};
$("cshare").onclick = async () => {
  try {
    await drawCard();
    const file = new File([await cardBlob()], cardFileName(), { type: "image/png" });
    await navigator.share({ files: [file], title: CARD.song.title });
  } catch (e) { if (e.name !== "AbortError") toast(e.message, "err"); }
};

/* ---------- accounts ---------- */
function updateChrome() {
  const on = !!me;
  $("navl").style.visibility = on ? "visible" : "hidden"; // keep its space so the wordmark stays centered
  $("guidebtn").hidden = !on; $("aipill").hidden = !on; $("acct").hidden = !on;
  $("guidelink").hidden = !(on && guideUrl); $("guidesep").hidden = $("guidelink").hidden; if (guideUrl) $("guidelink").href = guideUrl;
  if (on) $("acct").textContent = me.email.split("@")[0].slice(0, 18);
}
function sessionExpired() {
  if (!me) return;
  wipeSession(); me = null; updateChrome(); renderAuth("login", "Your session expired. Please sign in again.");
}

function renderAuth(mode = "login", notice = "") {
  if (mode === "register" && regMode === "closed") mode = "login";
  if (mode === "register" && regFull) { mode = "login"; notice = notice || "The beta is full for now — thank you for your interest!"; }
  const reg = mode === "register";
  $("view").innerHTML = `
  <section class="auth fade">
    <h1>${reg ? "Make your<br>own space." : "Welcome<br>back."}</h1>
    <p class="mono">${reg ? "Your songs, lyrics, explanations and notes stay private to your account." : "Sign in to your song library."}</p>
    ${notice ? `<p class="note err">${esc(notice)}</p>` : ""}
    <form id="authform" novalidate>
      <div class="field"><label for="em">Email</label><input id="em" type="text" inputmode="email" autocomplete="email" autocapitalize="off" spellcheck="false"></div>
      <div class="field"><label for="pw">Password${reg ? " (at least 8 characters)" : ""}</label><input id="pw" type="password" autocomplete="${reg ? "new-password" : "current-password"}"></div>
      ${reg && regMode === "invite" ? `<div class="field"><label for="inv">Invite code (works once)</label><input id="inv" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" style="text-transform:uppercase"></div>` : ""}
      ${reg ? `<label class="check"><input type="checkbox" id="agree"><span>I am 18 or older and I agree to the <a href="/legal/terms" target="_blank" rel="noopener">Terms of Use</a> and the <a href="/legal/privacy" target="_blank" rel="noopener">Privacy Notice</a>.</span></label>` : ""}
      <div class="row" style="margin-top:24px"><button class="btn" type="submit" id="authgo">${reg ? "Create account" : "Sign in"}</button><span id="autherr" class="note err" style="margin:0"></span></div>
    </form>
    ${guideUrl ? `<p class="note alt"><a href="${esc(guideUrl)}" target="_blank" rel="noopener noreferrer">📖 Beta user guide (PDF) ↗</a> — how to get started, and how to get a free Gemini API key.</p>` : ""}
    ${regMode === "invite" && contactEmail ? `<p class="note alt">Want to try it? Email <a href="mailto:${esc(contactEmail)}?subject=Song%20Explain%20invite%20code">${esc(contactEmail)}</a> to request an invite code.</p>` : ""}
    ${regMode === "closed" && !reg ? "" : `<p class="note alt">${reg ? "Already have an account?" : "New here?"} <button class="more" id="authswitch">${reg ? "Sign in." : "Create an account."}</button></p>`}
  </section>`;
  $("em").focus();
  if ($("authswitch")) $("authswitch").onclick = () => renderAuth(reg ? "login" : "register");
  $("authform").onsubmit = async (e) => {
    e.preventDefault();
    if (reg && !$("agree").checked) { $("autherr").textContent = "Please tick the box to continue."; return; }
    $("authgo").disabled = true; $("authgo").classList.add("is-busy"); $("autherr").textContent = "";
    try {
      const r = await fetch(reg ? "/api/auth/register" : "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: $("em").value, password: $("pw").value, invite: $("inv")?.value, agree: reg ? $("agree").checked : undefined }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Something went wrong.");
      me = d.user; updateChrome();
      if (!me.termsAccepted && !(await requireTerms())) return;
      await initAI();
      route();
      if (!store.get("toured")) { await tourWhenReady("#lib .item, #lib .empty"); startTour(); }
    } catch (err) {
      if ($("autherr")) { $("autherr").textContent = err.message; $("authgo").disabled = false; $("authgo").classList.remove("is-busy"); }
    }
  };
}

// Accounts created before the Terms existed must accept them once. Resolves true when accepted, false if they sign out instead.
function requireTerms() {
  return new Promise((resolve) => {
    $("termsagree").checked = false; $("termsok").disabled = true;
    $("termsagree").onchange = () => ($("termsok").disabled = !$("termsagree").checked);
    $("termsok").onclick = async () => {
      try {
        await json("POST", "/api/auth/accept-terms", { agree: true });
        me.termsAccepted = true; $("termsdlg").close(); resolve(true);
      } catch (e) { toast(e.message, "err"); }
    };
    $("termsout").onclick = async () => {
      await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      $("termsdlg").close(); wipeSession(); me = null; updateChrome(); renderAuth("login"); resolve(false);
    };
    $("termsdlg").showModal();
  });
}
$("termsdlg").addEventListener("cancel", (e) => e.preventDefault()); // cannot be dismissed with Esc

function openAccount() {
  $("acctemail").textContent = me ? `Signed in as ${me.email}` : "";
  $("acctname").value = me?.displayName || ""; $("acctlang").value = prefLang(); $("modbtn").hidden = !me?.isAdmin; $("invbtn").hidden = !me?.isAdmin; $("fbbtn").hidden = !me?.isAdmin; $("adminsec").hidden = !me?.isAdmin; setFbBadge(me?.feedbackNew || 0);
  $("delpw").value = ""; $("acctdlg").showModal();
}
$("acctlang").onchange = async () => {
  try {
    const d = await json("PUT", "/api/auth/preferences", { language: $("acctlang").value });
    me.prefLang = d.prefLang; setLang(d.prefLang) ; toast("Language preference saved");
  } catch (e) { toast(e.message, "err"); $("acctlang").value = prefLang(); }
};
$("acctnamesave").onclick = async () => {
  try { const d = await json("PUT", "/api/auth/profile", { displayName: $("acctname").value }); me.displayName = d.displayName; toast("Display name saved"); }
  catch (e) { toast(e.message, "err"); }
};
$("logoutbtn").onclick = async () => {
  await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  $("acctdlg").close(); vaultForget(me.id); wipeSession(); me = null; curSong = null; updateChrome(); location.hash = "#/"; renderAuth("login");
};
$("exportbtn").onclick = async () => {
  try {
    const r = await rawApi("GET", "/api/export");
    if (!r.ok) throw new Error("Export failed");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await r.blob()); a.download = "song-explain-export.json"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) { toast(e.message, "err"); }
};
$("delacct").onclick = async () => {
  if (!confirm("Permanently delete your account and everything in it?")) return;
  try {
    const r = await fetch("/api/auth/account", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: $("delpw").value }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Could not delete the account.");
    $("acctdlg").close(); vaultForget(me.id); wipeSession(); me = null; curSong = null; updateChrome(); location.hash = "#/"; renderAuth("login"); toast("Account deleted");
  } catch (e) { toast(e.message, "err"); }
};

/* ---------- guide: a spotlight tour that points at the real controls ---------- */
// "Guide" in the top bar explains the page you are on: the home page, or a song. It highlights each control and says what it does.
const HOME_TOUR = [
  { sel: "#hsearch", t: "Search for a song", b: "Type a title and artist, or paste a YouTube link, then press Find. Pick the right result and the song is saved to your Library." },
  { sel: ".tryrow", t: "Not sure where to start?", b: "Tap one of these examples to open a song right away." },
  { sel: '.hint [data-act="add"]', t: "Can't find it?", b: "Add a new or indie song by hand — title, artist, and lyrics if you have them. Lyrics stay private to you." },
  { sel: ".libhead", t: "Your Library", b: "Every song you open is kept here. Tap a card to come back to its explanation and your notes." },
  { sel: "#libfilter", t: "Filter your Library", b: "Narrow your own songs by title or artist. This only looks at songs you already have." },
  { sel: "#navjournal", t: "Journal", b: "Everything you wrote about songs in one place, plus feelings other members shared about the songs in your Library." },
  { sel: "#aipill", t: "Connect an AI — once", b: "The explanations are written by an AI you connect with your own key. Pick a provider, paste the key, press Test & connect." },
  { sel: "#acct", t: "Account", b: "Your display name, the language explanations are written in, an AI model, your data, and sign out." },
  { sel: '.foot [data-act="feedback"]', t: "Send feedback", b: "Found a bug or have an idea? Tell us here, at the bottom of every page. It goes privately to the person running the app. Open a song and tap Guide again for the song tour." },
];
const SONG_TOUR = [
  { sel: ".song-head", t: "This is your song", b: "Each song gets its own page: the explanation, what listeners say, and your own feelings." },
  { sel: "#explain", t: "Press Explain", b: "The app finds the lyrics and what listeners say, then writes it up. It takes about a minute, and you can press Stop any time." },
  { sel: "#langseg", t: "Choose the language", b: "What language the explanation is written in. The lyrics are never translated." },
  { sel: "#modelslot", t: "Choose the AI", b: "If you connected more than one AI, pick which one writes this explanation." },
  { sel: '.tab[data-tab="explain"]', tab: "explain", t: "Explanation", b: "Your saved explanations live here, newest first. Press Explain again for a new version." },
  { sel: '.tab[data-tab="views"]', tab: "views", t: "Listeners", b: "What people write about this song elsewhere online. You can ask the AI to summarise it." },
  { sel: '.tab[data-tab="community"]', tab: "community", t: "Community", b: "Feelings other members here chose to share about this song. Be kind — you can report anything that isn't." },
  { sel: '.tab[data-tab="notes"]', tab: "notes", t: "My feelings", b: "Your own space for this song. The next few steps show how it works." },
  { sel: "#moods", tab: "notes", t: "Pick a word", b: "Tap the words that fit. You can pick up to five." },
  { sel: ".tagadd", tab: "notes", t: "Or type your own", b: "Any word, in any language. Press Enter or Add — a word you leave in the box is added for you when you save." },
  { sel: "#pbody", tab: "notes", t: "Say it in your own words", b: "A memory, a person, a moment, or just one word. Not sure where to start? Tap one of the prompts underneath." },
  { sel: "#designs", tab: "notes", t: "Make it a card", b: "Choose how your feeling looks — note, poster, letter and more. The preview shows it live." },
  { sel: "#p-notes .check", tab: "notes", t: "Private or shared", b: "Your feeling is private unless you tick this. Shared ones appear in Community under your display name." },
  { sel: "#padd", tab: "notes", t: "Save it", b: "Saved feelings show up below and in your Journal. You can edit or delete them later." },
  { sel: '.tab[data-tab="lyrics"]', tab: "lyrics", t: "Lyrics", b: "Private to you, only used to help the AI. The app looks them up for you; you can also paste your own." },
  { sel: "#cardbtn", t: "Lyric card", b: "Turn a few lines, or your own words, into an image to share." },
  { sel: "#simbtn", t: "Same song, different spelling?", b: "If this song exists twice under different spellings, link them so their Community feelings are shared." },
  { sel: "#delsong", t: "Delete song", b: "Removes this song and everything you saved for it. You will be asked to confirm." },
];

let TOUR = null;
const tourVis = (el) => !!el && el.getClientRects().length > 0;
function startTour() {
  if (TOUR) return;
  const onSong = /^#\/song\/\d+/.test(location.hash) && !!$("explain");
  const prevTab = curTab;
  const steps = (onSong ? SONG_TOUR : HOME_TOUR).filter((st) => {
    if (st.tab) showTab(st.tab);
    return tourVis(document.querySelector(st.sel));
  });
  if (onSong) showTab(prevTab);
  if (!steps.length) return;
  store.set(onSong ? "toured_song" : "toured", "1");
  const back = document.createElement("div"); back.className = "tour-back";
  const hole = document.createElement("div"); hole.className = "tour-hole";
  const pop = document.createElement("div"); pop.className = "tour-pop"; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-live", "polite");
  document.body.append(back, hole, pop);
  TOUR = { steps, i: 0, back, hole, pop, onSong, prevTab };
  window.addEventListener("resize", tourPlace); window.addEventListener("scroll", tourPlace, true); document.addEventListener("keydown", tourKey);
  tourShow();
}
function tourShow() {
  const T = TOUR; if (!T) return;
  const st = T.steps[T.i];
  if (st.tab) showTab(st.tab);
  const el = document.querySelector(st.sel);
  if (!tourVis(el)) { if (T.i < T.steps.length - 1) { T.i++; tourShow(); } else endTour(); return; }
  const r = el.getBoundingClientRect();
  if (r.top < 60 || r.bottom > innerHeight - 20) el.scrollIntoView({ block: "center", behavior: "auto" });
  const last = T.i === T.steps.length - 1;
  T.pop.innerHTML = `<div class="tour-meta"><span>${T.i + 1} / ${T.steps.length}</span><span class="grow"></span><button class="link" type="button" data-tour="end">Close</button></div>
    <h4>${esc(st.t)}</h4><p>${esc(st.b)}</p>
    <div class="tour-bar">${T.i ? '<button class="btn ghost" type="button" data-tour="back">Back</button>' : ""}<button class="btn" type="button" data-tour="next">${last ? "Done" : "Next"}</button></div>`;
  T.pop.querySelector('[data-tour="next"]').focus({ preventScroll: true });
  tourPlace();
}
function tourPlace() {
  const T = TOUR; if (!T) return;
  const el = document.querySelector(T.steps[T.i].sel);
  if (!tourVis(el)) return;
  const r = el.getBoundingClientRect(), pad = 8, h = T.hole.style;
  h.left = r.left - pad + "px"; h.top = r.top - pad + "px"; h.width = r.width + pad * 2 + "px"; h.height = r.height + pad * 2 + "px";
  const pw = T.pop.offsetWidth, ph = T.pop.offsetHeight, gap = 14;
  let top;
  if (innerHeight - r.bottom - pad > ph + gap + 8) top = r.bottom + pad + gap;
  else if (r.top - pad > ph + gap + 8) top = r.top - pad - gap - ph;
  else top = innerHeight - ph - 12;
  T.pop.style.top = Math.max(12, top) + "px";
  T.pop.style.left = Math.min(Math.max(12, r.left), Math.max(12, innerWidth - pw - 12)) + "px";
}
function endTour() {
  const T = TOUR; if (!T) return;
  TOUR = null;
  T.back.remove(); T.hole.remove(); T.pop.remove();
  window.removeEventListener("resize", tourPlace); window.removeEventListener("scroll", tourPlace, true); document.removeEventListener("keydown", tourKey);
  if (T.onSong && $("explain")) showTab(T.prevTab);
}
function tourKey(e) {
  if (e.key === "Escape") endTour();
  else if (e.key === "ArrowRight" || e.key === "Enter") { if (e.target.closest?.('[data-tour="back"]')) return; e.preventDefault(); tourNext(1); }
  else if (e.key === "ArrowLeft") tourNext(-1);
}
function tourNext(d) {
  const T = TOUR; if (!T) return;
  const n = T.i + d;
  if (n >= T.steps.length) { endTour(); return; }
  if (n < 0) return;
  T.i = n; tourShow();
}
document.addEventListener("click", (e) => {
  const b = e.target.closest?.("[data-tour]"); if (!b) return;
  const a = b.dataset.tour;
  if (a === "end") endTour(); else tourNext(a === "back" ? -1 : 1);
});
// Wait for the page to finish drawing before the tour looks for its controls.
async function tourWhenReady(sel) {
  for (let i = 0; i < 40 && !document.querySelector(sel); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 400));
}

/* ---------- router ---------- */
function route() {
  if (!me) { renderAuth(); return; }
  if (ctrl) ctrl.abort(); // leaving the page cancels a running explanation
  stopPreview();
  if (vctrl) vctrl.abort();
  window.scrollTo(0, 0);
  document.querySelectorAll(".navl a").forEach((x) => x.classList.remove("on"));
  const open = (p) => { const end = busy("Opening"); Promise.resolve(p).finally(end); };
  if (location.hash === "#/journal") { curTab = "explain"; open(renderJournal()); return; }
  const sm = location.hash.match(/^#\/search\/(.+)$/);
  if (sm) { curTab = "explain"; let q = sm[1]; try { q = decodeURIComponent(q); } catch {} renderSearch(q); return; }
  const m = location.hash.match(/^#\/song\/(\d+)/);
  if (!m) curTab = "explain";
  open(m ? renderSong(m[1]) : renderHome());
}
window.addEventListener("hashchange", route);
(async function boot() {
  try {
    const d = await (await fetch("/api/auth/me")).json();
    me = d.user; regMode = d.registration || "open"; regFull = !!d.full; guideUrl = d.guideUrl || null; contactEmail = d.contact || null;
  } catch { me = null; }
  updateChrome();
  if (me && !me.termsAccepted && !(await requireTerms())) return;
  if (me) await initAI();
  route();
  if (me && !store.get("toured") && !/^#\/song\//.test(location.hash)) { await tourWhenReady("#lib .item, #lib .empty"); startTour(); } // first visit: show the home tour once
})();
