const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const md = (t) => DOMPurify.sanitize(marked.parse(t));
const MOODS = ["nostalgic", "heartbreak", "hopeful", "angry", "grateful", "healing", "lonely", "joyful"];
const LANGS = ["English", "简体中文", "繁體中文"];
let me = null;          // signed-in user { id, email } or null
let regFull = false;    // the beta has reached MAX_USERS
let regMode = "open";   // open | invite | closed
// Only harmless preferences live in the browser (theme, language, which model you picked).
// API keys are NEVER stored here — they are saved encrypted on the server (see AI settings).
const PER_USER = /^activeModel$/;
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
  $("toasts").append(el); setTimeout(() => el.remove(), kind === "err" ? 6000 : 3200);
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
const POPULAR = ["anthropic", "openai", "gemini", "deepseek"];
let aiAdding = false;      // the add form is open although something is already connected
let aiOther = false;       // "Other…" was chosen, so show the full provider list
let aiModelOpen = false;   // the model name field is open

async function openSettings() {
  $("airemember").checked = store.get("rememberKeys") === "1";
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
  const link = KEY_LINKS[pid];
  $("aikeylink").hidden = !link; if (link) $("aikeylink").href = link;
  $("aikey").placeholder = k && remember ? "Leave empty to use your saved key" : "Paste your API key";
  $("aikeyhint").textContent = k && remember ? `A ${p?.short || ""} key is already saved (${k.hint}).` : "";
  document.querySelectorAll("#remseg button").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.v === "1") === remember)));
  $("remnote").textContent = remember
    ? "Saved on the server, encrypted. You will only ever see its last 4 characters."
    : "Not saved anywhere — it disappears when you close or refresh this tab.";
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
  $("aisub").textContent = hasAny ? "Choose which one to use from the Model menu next to “Explain this song”." : "Pick a provider, paste your key, and you're done.";
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
      ${(byProv[pid] || []).map((m) => row(m.status, m.model, statusText[m.status] || "", `<button class="link" data-act="retest" data-id="${m.id}">Test</button><button class="link danger" data-act="rmmodel" data-id="${m.id}">Remove</button>`, m.status === "failed" ? m.error : "")).join("")}</div>`;
  }).join("");
  const sess = SESS.length
    ? `<div class="aiprov"><div class="row"><b>This visit only</b><span class="note" style="margin:0">not saved</span></div>
        ${SESS.map((s) => row(s.status, `${s.short} · ${s.model}`, s.status === "ok" ? "connected" : "failed", `<button class="link" data-act="stest" data-sid="${s.sid}">Test</button><button class="link danger" data-act="srm" data-sid="${s.sid}">Remove</button>`, s.status === "failed" ? s.error : "")).join("")}</div>`
    : "";
  $("aimodels").innerHTML = saved + sess;

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
  await loadAI();
}

/* ---------- API helper ---------- */
async function api(method, url, body, signal) {
  const r = await rawApi(method, url, body, signal);
  if (r.status === 401) {
    try { if ((await r.clone().json()).code === "AUTH") sessionExpired(); } catch {}
  }
  return r;
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
    else if (act === "candpage") { CAND.page = Number(el.dataset.p); renderCandidates(); $("results").scrollIntoView({ behavior: "smooth", block: "start" }); }
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
      $("airemember").checked = el.dataset.v === "1"; store.set("rememberKeys", el.dataset.v === "1" ? "1" : "");
      syncProviderFields();
    } else if (act === "aiadd") { aiAdding = true; renderAISettings(); $("aikey").focus(); }
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
    else if (act === "mod") { $("acctdlg").close(); openModeration(); }
    else if (act === "mact") {
      await json("POST", `/api/admin/perspectives/${el.dataset.id}/${el.dataset.do}`, {});
      COMM.loaded = false; openModeration();
    } else if (act === "mhide-post") {
      if (!confirm("Hide this post from the community feed?")) return;
      await json("POST", `/api/admin/perspectives/${el.dataset.id}/hide`, {});
      COMM.items = COMM.items.filter((p) => p.id !== Number(el.dataset.id)); if (curSong) renderCommunity(curSong); toast("Hidden");
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
    const s = await json("POST", "/api/songs", { title: $("mt").value, artist: $("ma").value, lyrics: $("ml").value, source: "manual" });
    $("adddlg").close(); $("mt").value = $("ma").value = $("ml").value = "";
    location.hash = "#/song/" + s.id;
  } catch (e) { toast(e.message, "err"); }
};

/* ---------- Home: search results + library ---------- */
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
      <p class="hint">Try: a song title and artist — or a youtube.com link.</p>
    </section>
    <div class="results" id="results" hidden><span class="lab">Search results</span><p class="note status" id="status"></p><div class="masonry" id="cands"></div><nav class="pager" id="cpager" aria-label="Search result pages" hidden></nav></div>
    <span class="lab" style="margin-bottom:26px">Library <span id="libcount"></span></span>
    <div id="lib" class="masonry"></div>
  </div>`;
  $("hsearch").onsubmit = async (e) => {
    e.preventDefault();
    const q = $("q").value.trim();
    if (!q) { $("q").focus(); return; }
    $("find").disabled = true;
    await findSongs(q);
    if ($("find")) $("find").disabled = false;
    $("results")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  $("q").focus();
  try {
    const songs = await json("GET", "/api/songs");
    if (!$("lib")) return;
    $("libcount").textContent = songs.length ? `(${songs.length})` : "";
    if (!songs.length) { $("lib").className = ""; $("lib").innerHTML = `<div class="empty"><p>Nothing here yet.</p><p class="mono">Search for a song above. Every song you open is kept in this library.</p></div>`; return; }
    songs.forEach((s) => {
      const b = document.createElement("button");
      b.className = "item";
      const label = s.explanations ? "Explained" : s.perspectives ? "Notes" : "Song";
      b.innerHTML = `${coverHTML(s)}<span class="lab">${label}${s.perspectives ? ` · ${s.perspectives} ${s.perspectives > 1 ? "notes" : "note"}` : ""}</span>
        <h3>${esc(s.title)}</h3><div class="by">${esc(s.artist)}</div>${s.excerpt ? `<p class="ex">${esc(s.excerpt)}</p>` : ""}<span class="more">Read More.</span>`;
      b.onclick = () => (location.hash = "#/song/" + s.id);
      $("lib").append(b);
    });
  } catch (e) { toast(e.message, "err"); }
}

// Search results are fetched once (up to ~40 songs) and shown 8 at a time with page numbers.
const PAGE_SIZE = 8;
let CAND = { items: [], page: 0 };

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
    b.onclick = async () => { try { const s = await json("POST", "/api/songs", c); location.hash = "#/song/" + s.id; } catch (e) { toast(e.message, "err"); } };
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

async function findSongs(input) {
  $("results").hidden = false; $("cands").innerHTML = ""; $("cpager").hidden = true;
  $("status").className = "note status"; $("status").textContent = "Listening for the song…";
  try {
    const d = await json("POST", "/api/identify", { input });
    if (!$("status")) return;
    const from = d.source ? `From YouTube: “${d.source.title}” — ${d.source.channel}. ` : "";
    if (!d.candidates.length) {
      $("status").innerHTML = `${esc(from)}No matching songs found. <button class="more" id="addit">Add it yourself.</button>`;
      $("addit").onclick = () => openAdd(d.queries?.[0] || input); return;
    }
    $("status").textContent = from + (d.candidates.length > PAGE_SIZE ? `${d.candidates.length} songs found. Choose the right one:` : "Choose the right one:");
    CAND = { items: d.candidates, page: 0 };
    renderCandidates();
  } catch (e) {
    if ($("status")) { $("status").className = "note status err"; $("status").textContent = e.message; }
  }
}

/* ---------- Song page ---------- */
let curSong = null;
let curTab = "explain";
let curLang = store.get("lang") || "English";

function showTab(name) {
  curTab = name;
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== "p-" + name));
  if (name === "community" && curSong && !COMM.loaded) loadCommunity(curSong);
}
function setLang(l) {
  curLang = l; store.set("lang", l);
  document.querySelectorAll("#langseg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lang === l)));
}
function setMood(m) {
  $("pmood").value = m || "";
  document.querySelectorAll(".mood").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mood === m)));
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
        <div class="row"><button class="btn ghost" id="cardbtn">Make a lyric card</button><button class="link danger" id="delsong">Delete song</button></div>
      </div>
    </header>

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
      <div class="moods">${MOODS.map((m) => `<button type="button" class="mood" data-mood="${m}" aria-pressed="false">${m}</button>`).join("")}</div>
      <div class="field"><input id="panchor" type="text" placeholder="About which part? e.g. Chorus, Verse 2 (optional)"></div>
      <div class="field"><textarea id="pbody" placeholder="A memory, a person, a moment in your life this song brings back…"></textarea></div>
      <label class="check"><input type="checkbox" id="ppublic"><span><b>Share this with the other people on this app</b>, under your display name. Don't include personal details. No links, and please don't paste lyrics. You can make it private again any time.</span></label>
      <div class="row" style="margin-top:14px"><button class="btn" id="padd">Save my feeling</button><button class="btn ghost" id="pcancel" hidden>Cancel</button><span id="pstat" class="note" style="margin:0"></span></div>
      <div id="plist"></div>
    </section>

    <section class="panel col" id="p-lyrics" hidden>
      <span class="lab">Lyrics — private, on this computer only</span>
      <p class="note">When you press Explain, the app looks the lyrics up automatically and saves them here. If it can't find them it will not guess — paste them yourself, and check they are the right song.</p>
      <textarea id="lyr" style="min-height:300px" placeholder="Paste lyrics here"></textarea>
      <div class="row" style="margin-top:14px"><button class="btn ghost" id="savelyr">Save lyrics</button></div>
    </section>
  </div>`;

  showTab(curTab);
  renderModelPicker();
  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => showTab(t.dataset.tab)));
  setLang(curLang);
  document.querySelectorAll("#langseg button").forEach((b) => (b.onclick = () => setLang(b.dataset.lang)));
  document.querySelectorAll(".mood").forEach((b) => (b.onclick = () => setMood($("pmood").value === b.dataset.mood ? "" : b.dataset.mood)));

  $("cardbtn").onclick = () => openCard(song);
  $("delsong").onclick = async () => { if (confirm("Delete this song and everything you saved for it?")) { await json("DELETE", "/api/songs/" + id); toast("Song deleted"); location.hash = "#/"; } };
  if (song.hasLyrics) json("GET", `/api/songs/${id}/lyrics`).then((r) => { if ($("lyr")) $("lyr").value = r.lyrics; }).catch(() => {});
  $("savelyr").onclick = async () => { await json("PUT", `/api/songs/${id}/lyrics`, { lyrics: $("lyr").value }); toast("Lyrics saved"); renderSong(id); };
  $("explain").onclick = () => explain(song);
  $("padd").onclick = async () => {
    try {
      const pub = $("ppublic").checked;
      await sendPerspective("POST", `/api/songs/${id}/perspectives`, { body: $("pbody").value, mood: $("pmood").value, anchor: $("panchor").value, isPublic: pub });
      toast(pub ? "Saved and shared" : "Saved (private)"); COMM.loaded = false; renderSong(id);
    } catch (e) { $("pstat").className = "note err"; $("pstat").textContent = e.message; }
  };

  loadViews(song);

  // saved explanations: newest in full, older versions folded away
  const exCard = (e) => `
    <article class="article"><div class="meta"><span>${esc(e.language)}</span><span>${esc(e.model || e.provider || "")}</span><span>${esc(fmtDate(e.created_at))}</span>
      <button class="link danger push" data-delex="${e.id}">delete</button></div><div class="prose">${md(e.body)}</div></article>`;
  $("exlist").innerHTML = explanations.length
    ? exCard(explanations[0]) + (explanations.length > 1 ? `<details style="margin-top:40px"><summary class="note" style="cursor:pointer">Earlier explanations (${explanations.length - 1})</summary>${explanations.slice(1).map(exCard).join("")}</details>` : "")
    : `<div class="empty" style="margin-top:30px"><p>No explanation yet.</p><p class="mono">Choose a language and press “Explain this song”. It finds the lyrics, reads what listeners say, then writes it up.</p></div>`;
  document.querySelectorAll("[data-delex]").forEach((b) => (b.onclick = async () => { await json("DELETE", "/api/explanations/" + b.dataset.delex); renderSong(id); }));

  // perspectives
  $("plist").innerHTML = perspectives.length ? "" : `<div class="empty" style="margin-top:34px"><p>Nothing here yet.</p><p class="mono">Write the first thing this song makes you feel — only you will see it.</p></div>`;
  perspectives.forEach((p) => {
    const el = document.createElement("article");
    el.className = "entry";
    el.innerHTML = `<div class="meta">${p.mood ? `<span>${esc(p.mood)}</span>` : ""}${p.anchor ? `<span>${esc(p.anchor)}</span>` : ""}<span>${esc(fmtDate(p.created_at))}${p.updated_at ? " · edited" : ""}</span><span>${p.is_public ? (p.hidden ? "shared · hidden by a moderator" : "shared with the community") : "private"}</span>
      <span class="push"><button class="link" data-vis>${p.is_public ? "make private" : "share"}</button> <button class="link" data-edit>edit</button> <button class="link danger" data-del>delete</button></span></div>
      <p>${esc(p.body)}</p>`;
    el.querySelector("[data-del]").onclick = async () => { if (confirm("Delete this feeling?")) { await json("DELETE", "/api/perspectives/" + p.id); renderSong(id); } };
    el.querySelector("[data-vis]").onclick = async () => {
      try {
        await sendPerspective("PUT", "/api/perspectives/" + p.id, { body: p.body, mood: p.mood || "", anchor: p.anchor || "", isPublic: !p.is_public });
        toast(p.is_public ? "Now private" : "Shared with the community"); COMM.loaded = false; renderSong(id);
      } catch (e) { toast(e.message, "err"); }
    };
    el.querySelector("[data-edit]").onclick = () => {
      setMood(p.mood || ""); $("panchor").value = p.anchor || ""; $("pbody").value = p.body; $("ppublic").checked = !!p.is_public;
      $("padd").textContent = "Update"; $("pcancel").hidden = false;
      $("pcancel").onclick = () => renderSong(id);
      $("padd").onclick = async () => {
        try { await sendPerspective("PUT", "/api/perspectives/" + p.id, { body: $("pbody").value, mood: $("pmood").value, anchor: $("panchor").value, isPublic: $("ppublic").checked }); toast("Updated"); COMM.loaded = false; renderSong(id); }
        catch (e) { $("pstat").className = "note err"; $("pstat").textContent = e.message; }
      };
      $("pbody").scrollIntoView({ behavior: "smooth", block: "center" });
    };
    $("plist").append(el);
  });
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
  box.innerHTML = COMM.items.map((p) => `<article class="entry"><div class="meta"><span>${esc(p.author)}${p.mine ? " (you)" : ""}</span>${p.mood ? `<span>${esc(p.mood)}</span>` : ""}${p.anchor ? `<span>${esc(p.anchor)}</span>` : ""}<span>${esc(fmtDate(p.published_at))}</span>
      <span class="push">${p.mine ? "" : `<button class="link" data-act="report" data-id="${p.id}">report</button>`}${me?.isAdmin ? ` <button class="link danger" data-act="mhide-post" data-id="${p.id}">hide</button>` : ""}</span></div>
      <p>${esc(p.body)}</p></article>`).join("") +
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
const V = { items: [], seen: new Set(), shown: 0, nOffset: 0, nMore: true, nTotal: 0, ytToken: null, ytMore: true, ytVideo: null, wiki: null };
const VCHUNK = 12;

function addViews(list, source) {
  for (const v of list) {
    if (V.seen.has(v.text)) continue;
    V.seen.add(v.text);
    V.items.push({ ...v, source });
  }
}
const viewCard = (v) => `<div class="cm"><span class="lab">${esc(v.source)} · ${v.likes.toLocaleString()} likes</span><p>${esc(v.text)}</p></div>`;

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
      <span id="vmstat" class="note" style="margin:0"></span>
    </div>
    <p class="note" style="margin-top:26px">${V.items.length} comments loaded${V.nTotal ? ` (NetEase has about ${V.nTotal.toLocaleString()})` : ""} — a sample of public listener comments, not everyone. Names are not shown.${V.ytVideo ? ` YouTube video: <a target="_blank" rel="noopener" href="${esc(V.ytVideo.url)}">${esc(V.ytVideo.title)}</a>.` : ""}${V.wiki ? ` Background: <a target="_blank" rel="noopener" href="${esc(V.wiki.url)}">Wikipedia – ${esc(V.wiki.title)}</a>.` : ""}</p>
    <span class="lab" style="margin-top:30px">Keep exploring</span>${links}`;

  if ($("vsum")) $("vsum").onclick = () => summarizeViews(song);
  if ($("vmore")) $("vmore").onclick = () => showMoreViews(song);
  if ($("vyt")) $("vyt").onclick = () => loadYoutube(song);
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
  Object.assign(V, { items: [], seen: new Set(), shown: 0, nOffset: 0, nMore: true, nTotal: 0, ytToken: null, ytMore: true, ytVideo: null, wiki: null });
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
async function explain(song) {
  if (ctrl) { ctrl.abort(); return; } // button acts as Stop while running
  if (!hasAI()) { toast("Connect an AI model first.", "err"); openSettings(); return; }
  const mine = (ctrl = new AbortController());
  const btn = $("explain");
  btn.textContent = "Stop"; btn.classList.add("stop");
  $("exstat").className = "note"; $("exstat").textContent = "Finding the lyrics and what listeners say…";
  $("live").innerHTML = `<div class="article"><div class="sk" style="height:26px;width:60%;margin-bottom:22px"></div><div class="sk" style="height:12px;margin:12px 0"></div><div class="sk" style="height:12px;width:92%;margin:12px 0"></div><div class="sk" style="height:12px;width:76%;margin:12px 0"></div></div>`;
  let text = "";
  try {
    const r = await api("POST", `/api/songs/${song.id}/explain`, { language: curLang }, mine.signal);
    if (!r.ok) throw new Error((await r.json()).error);
    const reader = r.body.getReader(), dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
      $("exstat").textContent = "Writing…";
      $("live").innerHTML = `<article class="article"><div class="prose caret">${md(text)}</div></article>`;
    }
    ctrl = null;
    if (!/\[Error: /.test(text)) return renderSong(song.id); // reload: shows the saved copy
    $("exstat").textContent = "";
  } catch (e) {
    if (e.name === "AbortError") {
      // partial text is discarded and not saved (the page may already have changed if the user navigated away)
      if ($("live")) $("live").innerHTML = "";
      if ($("exstat")) $("exstat").textContent = "Stopped — nothing was saved.";
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
const CARD = { song: null, lines: [], picked: [], mode: "lyrics", theme: "paper", format: "story", own: "", cover: null, tint: null, lyricsLoaded: false, seq: 0 };
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
  setSeg("cmode", CARD.mode); setSeg("ctheme", CARD.theme); setSeg("cfmt", CARD.format);
  bindSeg("cmode", "mode"); bindSeg("ctheme", "theme"); bindSeg("cfmt", "format");
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

async function drawCard() {
  const seq = ++CARD.seq;
  const song = CARD.song;
  if (!song) return;
  const quote = CARD.mode === "own" ? CARD.own.trim() : CARD.picked.map((i) => CARD.lines[i]).join("\n");
  await loadCardFonts(`${song.title}${song.artist}${quote}Song Explain.`);
  if (seq !== CARD.seq) return; // a newer draw superseded this one

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
  $("aipill").hidden = !on; $("acct").hidden = !on;
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
    ${regMode === "closed" && !reg ? "" : `<p class="note alt">${reg ? "Already have an account?" : "New here?"} <button class="more" id="authswitch">${reg ? "Sign in." : "Create an account."}</button></p>`}
  </section>`;
  $("em").focus();
  if ($("authswitch")) $("authswitch").onclick = () => renderAuth(reg ? "login" : "register");
  $("authform").onsubmit = async (e) => {
    e.preventDefault();
    if (reg && !$("agree").checked) { $("autherr").textContent = "Please tick the box to continue."; return; }
    $("authgo").disabled = true; $("autherr").textContent = "";
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
    } catch (err) {
      if ($("autherr")) { $("autherr").textContent = err.message; $("authgo").disabled = false; }
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
  $("acctname").value = me?.displayName || ""; $("modbtn").hidden = !me?.isAdmin; $("invbtn").hidden = !me?.isAdmin; $("fbbtn").hidden = !me?.isAdmin; setFbBadge(me?.feedbackNew || 0);
  $("delpw").value = ""; $("acctdlg").showModal();
}
$("acctnamesave").onclick = async () => {
  try { const d = await json("PUT", "/api/auth/profile", { displayName: $("acctname").value }); me.displayName = d.displayName; toast("Display name saved"); }
  catch (e) { toast(e.message, "err"); }
};
$("logoutbtn").onclick = async () => {
  await fetch("/api/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  $("acctdlg").close(); wipeSession(); me = null; curSong = null; updateChrome(); location.hash = "#/"; renderAuth("login");
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
    $("acctdlg").close(); wipeSession(); me = null; curSong = null; updateChrome(); location.hash = "#/"; renderAuth("login"); toast("Account deleted");
  } catch (e) { toast(e.message, "err"); }
};

/* ---------- router ---------- */
function route() {
  if (!me) { renderAuth(); return; }
  if (ctrl) ctrl.abort(); // leaving the page cancels a running explanation
  if (vctrl) vctrl.abort();
  window.scrollTo(0, 0);
  const m = location.hash.match(/^#\/song\/(\d+)/);
  if (!m) curTab = "explain";
  m ? renderSong(m[1]) : renderHome();
}
window.addEventListener("hashchange", route);
(async function boot() {
  try {
    const d = await (await fetch("/api/auth/me")).json();
    me = d.user; regMode = d.registration || "open"; regFull = !!d.full;
  } catch { me = null; }
  updateChrome();
  if (me && !me.termsAccepted && !(await requireTerms())) return;
  if (me) await initAI();
  route();
})();
