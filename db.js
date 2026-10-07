import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as OpenCC from "opencc-js";

// One SQLite file. Every song, explanation and note belongs to a user, and every query below is
// scoped by user id — a user can never read or change another user's data.
const DB_FILE = process.env.DB_FILE || "data/songexplain.db";
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_keys (            -- one saved credential per provider (encrypted; see secrets.js)
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                       -- anthropic | openai | ... | youtube
  key_enc TEXT NOT NULL,
  hint TEXT,                                    -- ••••abcd (never the key)
  base_url TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, provider)
);
CREATE TABLE IF NOT EXISTS ai_models (          -- models the user connected; only status='ok' ones are selectable
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'untested',      -- ok | failed | untested
  error TEXT,
  tested_at TEXT,
  UNIQUE (user_id, provider, model)
);
CREATE TABLE IF NOT EXISTS explanations (
  id INTEGER PRIMARY KEY,
  song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  provider TEXT, model TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS perspectives (
  id INTEGER PRIMARY KEY,
  song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  mood TEXT, anchor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
`);

const SONGS_SQL = (name) => `CREATE TABLE ${name} (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,                  -- normalized title|artist, for de-duplication (per user)
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  album TEXT, year TEXT, cover TEXT,
  source TEXT NOT NULL DEFAULT 'catalog',   -- catalog | manual
  lyrics TEXT,                        -- private to the owner; only returned by the owner-only lyrics route
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, key)
)`;

// Create the songs table, or upgrade the single-user version (global UNIQUE key, no user_id).
const cols = db.prepare("PRAGMA table_info(songs)").all();
if (!cols.length) {
  db.exec(SONGS_SQL("songs"));
} else if (!cols.some((c) => c.name === "user_id")) {
  db.exec("PRAGMA foreign_keys = OFF; BEGIN;");
  db.exec(SONGS_SQL("songs_new"));
  db.exec(`INSERT INTO songs_new (id, key, title, artist, album, year, cover, source, lyrics, created_at)
           SELECT id, key, title, artist, album, year, cover, source, lyrics, created_at FROM songs;
           DROP TABLE songs; ALTER TABLE songs_new RENAME TO songs; COMMIT; PRAGMA foreign_keys = ON;`);
}

/* ---------- community (opt-in sharing of a feeling) ---------- */
const hasCol = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
if (!hasCol("users", "display_name")) db.exec("ALTER TABLE users ADD COLUMN display_name TEXT");
// The language the person wants AI explanations written in (default 简体中文).
if (!hasCol("users", "pref_lang")) db.exec("ALTER TABLE users ADD COLUMN pref_lang TEXT");
// Which version of the Terms/Privacy Notice the user accepted, and when (consent record).
if (!hasCol("users", "terms_version")) db.exec("ALTER TABLE users ADD COLUMN terms_version TEXT");
if (!hasCol("users", "terms_accepted_at")) db.exec("ALTER TABLE users ADD COLUMN terms_accepted_at TEXT");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_dname ON users(display_name COLLATE NOCASE) WHERE display_name IS NOT NULL");
for (const [col, def] of [["is_public", "INTEGER NOT NULL DEFAULT 0"], ["hidden", "INTEGER NOT NULL DEFAULT 0"], ["published_at", "TEXT"], ["design", "TEXT"]])
  if (!hasCol("perspectives", col)) db.exec(`ALTER TABLE perspectives ADD COLUMN ${col} ${def}`);
db.exec(`
CREATE INDEX IF NOT EXISTS idx_persp_public ON perspectives(is_public, hidden, song_id);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  perspective_id INTEGER NOT NULL REFERENCES perspectives(id) ON DELETE CASCADE,
  reporter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',          -- open | dismissed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (perspective_id, reporter_id)
);
`);

const norm = (s) => String(s).toLowerCase().replace(/[\(\[].*?[\)\]]/g, "").replace(/\s+/g, " ").trim();
const songKey = (title, artist) => `${norm(title)}|${norm(artist)}`;
const toCN = OpenCC.Converter({ from: "tw", to: "cn" });
// The identity the community uses for "the same song". Stronger than the per-user key: simplified/traditional Chinese,
// punctuation, spacing, "(feat. …)", "- Remastered" and "A & B" all collapse, so trivial spelling differences never split a song.
const canonPart = (s) => toCN(String(s).toLowerCase()).replace(/[\(\[（【].*?[\)\]）】]/g, "").replace(/[\p{P}\p{S}\s]+/gu, "");
const canonTitle = (t) => canonPart(String(t).replace(/\s[-–—]\s(remaster|remastered|live|version|ver\.|mono|stereo|single|radio|deluxe|\d{4}).*$/i, ""));
const canonArtist = (a) => canonPart(String(a).split(/\s*(?:feat\.?|ft\.?|featuring|with|&|\/|,|、|×|\bx\b|\band\b)\s+/i)[0]);
// The same album art has the same identity however it is sized: Deezer's md5 path, or Apple's path without the size file name.
export function coverToken(url) {
  try {
    const u = new URL(String(url));
    const dz = u.pathname.match(/\/images\/(?:cover|artist)\/([0-9a-f]{32})/);
    if (/dzcdn\.net$/i.test(u.hostname) && dz) return "dz:" + dz[1];
    if (/mzstatic\.com$/i.test(u.hostname)) { const p = u.pathname.split("/"); p.pop(); return p.length > 3 ? "mz:" + p.join("/") : null; }
  } catch {}
  return null;
}
const albumKeyOf = (album) => (album ? canonPart(String(album).replace(/\s[-–—]\s(single|ep|deluxe.*)$/i, "")) : "");
const groupKeyOf = (title, artist) => `${canonTitle(title)}|${canonArtist(artist)}`;
// group_key = who this song is shared with in the community. group_checked = the owner has answered "same song as…?".
if (!hasCol("songs", "group_key")) db.exec("ALTER TABLE songs ADD COLUMN group_key TEXT");
if (!hasCol("songs", "group_checked")) db.exec("ALTER TABLE songs ADD COLUMN group_checked INTEGER NOT NULL DEFAULT 0");
for (const [c, def] of [["cover_token", "TEXT"], ["album_key", "TEXT"], ["linked_note", "TEXT"]]) if (!hasCol("songs", c)) db.exec(`ALTER TABLE songs ADD COLUMN ${c} ${def}`);
// lyrics_auto = the stored lyrics were fetched online (not typed or pasted by the owner), so the AI is still told they may be wrong.
if (!hasCol("songs", "lyrics_auto")) {
  db.exec("ALTER TABLE songs ADD COLUMN lyrics_auto INTEGER NOT NULL DEFAULT 0");
  db.exec("UPDATE songs SET lyrics_auto = 1 WHERE lyrics IS NOT NULL AND source = 'catalog'"); // earlier versions fetched them for catalog songs
}
db.exec("CREATE INDEX IF NOT EXISTS idx_songs_group ON songs(group_key)");
for (const r of db.prepare("SELECT id, cover, album FROM songs WHERE cover_token IS NULL AND album_key IS NULL").all())
  db.prepare("UPDATE songs SET cover_token = ?, album_key = ? WHERE id = ?").run(coverToken(r.cover), albumKeyOf(r.album), r.id);
for (const r of db.prepare("SELECT id, title, artist FROM songs WHERE group_key IS NULL").all())
  db.prepare("UPDATE songs SET group_key = ? WHERE id = ?").run(groupKeyOf(r.title, r.artist), r.id);
const publicSong = (r) => r && { ...r, user_id: undefined, lyrics: undefined, hasLyrics: !!r.lyrics };

/* ---------- users & sessions ---------- */
export const createUser = (email, passHash) => {
  const info = db.prepare("INSERT INTO users (email, pass_hash) VALUES (?, ?)").run(email, passHash);
  const id = Number(info.lastInsertRowid);
  // The very first account inherits any songs saved before accounts existed (your original local data).
  if (db.prepare("SELECT COUNT(*) AS n FROM users").get().n === 1)
    db.prepare("UPDATE songs SET user_id = ? WHERE user_id IS NULL").run(id);
  return id;
};
export const getUserByEmail = (email) => db.prepare("SELECT * FROM users WHERE email = ?").get(email);
export const getUserById = (id) => db.prepare("SELECT id, email, display_name, pref_lang, terms_version, created_at FROM users WHERE id = ?").get(id);
export const setPrefLang = (userId, lang) => db.prepare("UPDATE users SET pref_lang = ? WHERE id = ?").run(lang, userId);
export const countUsers = () => db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
export const deleteUser = (id) => db.prepare("DELETE FROM users WHERE id = ?").run(id);

const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");
const SESSION_MS = 30 * 24 * 3600 * 1000;
export function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)").run(hashToken(token), userId, Date.now() + SESSION_MS);
  return { token, maxAge: SESSION_MS };
}
export function sessionUser(token) {
  if (!token) return null;
  const row = db.prepare("SELECT user_id, expires_at FROM sessions WHERE token_hash = ?").get(hashToken(token));
  if (!row || row.expires_at < Date.now()) return null;
  return getUserById(row.user_id);
}
export const deleteSession = (token) => token && db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
export const deleteUserSessions = (userId) => db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
export const purgeSessions = () => db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());

/* ---------- songs (all scoped by user) ---------- */
export function upsertSong(userId, { title, artist, album, year, cover, source = "catalog", lyrics }) {
  const key = songKey(title, artist);
  const found = db.prepare("SELECT * FROM songs WHERE user_id = ? AND key = ?").get(userId, key);
  if (found) {
    if (lyrics?.trim()) db.prepare("UPDATE songs SET lyrics = ?, lyrics_auto = 0 WHERE id = ?").run(lyrics.trim(), found.id);
    return getSong(userId, found.id);
  }
  const info = db
    .prepare("INSERT INTO songs (user_id,key,group_key,cover_token,album_key,title,artist,album,year,cover,source,lyrics) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(userId, key, groupKeyOf(title, artist), coverToken(cover), albumKeyOf(album), title, artist, album ?? null, year ?? null, cover ?? null, source, lyrics?.trim() || null);
  const id = Number(info.lastInsertRowid);
  autoLink(userId, id);
  return getSong(userId, id);
}

export const getSong = (userId, id) => publicSong(db.prepare("SELECT * FROM songs WHERE id = ? AND user_id = ?").get(id, userId));
export const getSongLyrics = (userId, id) => db.prepare("SELECT lyrics FROM songs WHERE id = ? AND user_id = ?").get(id, userId)?.lyrics || null;
export const getSongLyricsInfo = (userId, id) => {
  const r = db.prepare("SELECT lyrics, lyrics_auto FROM songs WHERE id = ? AND user_id = ?").get(id, userId);
  return { lyrics: r?.lyrics || null, auto: !!r?.lyrics_auto };
};
// auto = true when the text was fetched online; false when the owner typed or pasted it.
export const setLyrics = (userId, id, lyrics, auto = false) =>
  db.prepare("UPDATE songs SET lyrics = ?, lyrics_auto = ? WHERE id = ? AND user_id = ?").run(lyrics?.trim() || null, auto && lyrics?.trim() ? 1 : 0, id, userId);
export const deleteSong = (userId, id) => db.prepare("DELETE FROM songs WHERE id = ? AND user_id = ?").run(id, userId);

export const listSongs = (userId) =>
  db
    .prepare(
      `SELECT s.id, s.title, s.artist, s.cover, s.source,
         (SELECT COUNT(*) FROM perspectives p WHERE p.song_id = s.id) AS perspectives,
         (SELECT COUNT(*) FROM explanations e WHERE e.song_id = s.id) AS explanations,
         (SELECT body FROM explanations e WHERE e.song_id = s.id ORDER BY e.id DESC LIMIT 1) AS latest,
         (SELECT body FROM perspectives p WHERE p.song_id = s.id ORDER BY p.id DESC LIMIT 1) AS latest_note
       FROM songs s WHERE s.user_id = ? ORDER BY s.id DESC`
    )
    .all(userId);

// The functions below take a song id that the caller has ALREADY verified belongs to the user via getSong().
export const listExplanations = (songId) => db.prepare("SELECT * FROM explanations WHERE song_id = ? ORDER BY id DESC").all(songId);
export const addExplanation = (songId, language, provider, model, body) =>
  db.prepare("INSERT INTO explanations (song_id,language,provider,model,body) VALUES (?,?,?,?,?)").run(songId, language, provider, model, body);
export const deleteExplanation = (userId, id) =>
  db.prepare("DELETE FROM explanations WHERE id = ? AND song_id IN (SELECT id FROM songs WHERE user_id = ?)").run(id, userId);

export const listPerspectives = (songId) => db.prepare("SELECT * FROM perspectives WHERE song_id = ? ORDER BY id DESC").all(songId);
export const addPerspective = (songId, { body, mood, anchor, isPublic, design }) =>
  db
    .prepare(`INSERT INTO perspectives (song_id,body,mood,anchor,design,is_public,published_at) VALUES (?,?,?,?,?,?,${isPublic ? "datetime('now')" : "NULL"})`)
    .run(songId, body, mood || null, anchor || null, design || null, isPublic ? 1 : 0);
// Editing a post never un-hides a post a moderator hid. Making it public stamps published_at once.
export const updatePerspective = (userId, id, { body, mood, anchor, isPublic, design }) =>
  db
    .prepare(
      `UPDATE perspectives SET body=?, mood=?, anchor=?, design=?, is_public=?, updated_at=datetime('now'),
         published_at = CASE WHEN ? = 1 AND published_at IS NULL THEN datetime('now') ELSE published_at END
       WHERE id=? AND song_id IN (SELECT id FROM songs WHERE user_id = ?)`
    )
    .run(body, mood || null, anchor || null, design || null, isPublic ? 1 : 0, isPublic ? 1 : 0, id, userId);
export const listJournal = (userId) =>
  db
    .prepare(
      `SELECT p.id, p.song_id, p.body, p.mood, p.anchor, p.design, p.is_public, p.hidden, p.created_at, p.updated_at, s.title, s.artist, s.cover
       FROM perspectives p JOIN songs s ON s.id = p.song_id WHERE s.user_id = ? ORDER BY p.id DESC`
    )
    .all(userId);
export const deletePerspective =(userId, id) =>
  db.prepare("DELETE FROM perspectives WHERE id = ? AND song_id IN (SELECT id FROM songs WHERE user_id = ?)").run(id, userId);

// Everything a user owns, for data export.
export function exportAll(userId) {
  const songs = db.prepare("SELECT * FROM songs WHERE user_id = ? ORDER BY id").all(userId);
  return songs.map((s) => ({
    title: s.title, artist: s.artist, album: s.album, year: s.year, cover: s.cover, source: s.source, lyrics: s.lyrics, created_at: s.created_at,
    explanations: listExplanations(s.id).map(({ language, provider, model, body, created_at }) => ({ language, provider, model, body, created_at })),
    perspectives: listPerspectives(s.id).map(({ body, mood, anchor, created_at, updated_at, is_public }) => ({ body, mood, anchor, created_at, updated_at, shared_publicly: !!is_public })),
  }));
}

/* ---------- saved AI credentials & connected models (all scoped by user) ---------- */
export const getAiKeyRow = (userId, provider) => db.prepare("SELECT * FROM ai_keys WHERE user_id = ? AND provider = ?").get(userId, provider);
export const listAiKeys = (userId) => db.prepare("SELECT provider, hint, base_url, updated_at FROM ai_keys WHERE user_id = ? ORDER BY provider").all(userId);
export const setAiKey = (userId, provider, keyEnc, hint, baseUrl) =>
  db
    .prepare(
      `INSERT INTO ai_keys (user_id, provider, key_enc, hint, base_url) VALUES (?,?,?,?,?)
       ON CONFLICT (user_id, provider) DO UPDATE SET key_enc=excluded.key_enc, hint=excluded.hint, base_url=excluded.base_url, updated_at=datetime('now')`
    )
    .run(userId, provider, keyEnc, hint, baseUrl || null);
export function deleteAiKey(userId, provider) {
  db.prepare("DELETE FROM ai_models WHERE user_id = ? AND provider = ?").run(userId, provider);
  db.prepare("DELETE FROM ai_keys WHERE user_id = ? AND provider = ?").run(userId, provider);
}

export const listAiModels = (userId) => db.prepare("SELECT * FROM ai_models WHERE user_id = ? ORDER BY provider, model").all(userId);
export const getAiModel = (userId, id) => db.prepare("SELECT * FROM ai_models WHERE id = ? AND user_id = ?").get(id, userId);
export function upsertAiModel(userId, provider, model, status, error) {
  db.prepare(
    `INSERT INTO ai_models (user_id, provider, model, status, error, tested_at) VALUES (?,?,?,?,?,datetime('now'))
     ON CONFLICT (user_id, provider, model) DO UPDATE SET status=excluded.status, error=excluded.error, tested_at=datetime('now')`
  ).run(userId, provider, model, status, error || null);
  return db.prepare("SELECT * FROM ai_models WHERE user_id = ? AND provider = ? AND model = ?").get(userId, provider, model);
}
export const setAiModelStatus = (userId, id, status, error) =>
  db.prepare("UPDATE ai_models SET status = ?, error = ?, tested_at = datetime('now') WHERE id = ? AND user_id = ?").run(status, error || null, id, userId);
export const deleteAiModel = (userId, id) => db.prepare("DELETE FROM ai_models WHERE id = ? AND user_id = ?").run(id, userId);

/* ---------- community: display names, public feed, reports, moderation ---------- */
export function setDisplayName(userId, name) {
  try {
    db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(name, userId);
    return true;
  } catch {
    return false; // name already taken (unique, case-insensitive)
  }
}

// One of the user's own perspectives (with its song), or undefined.
export const getOwnPerspective = (userId, id) =>
  db
    .prepare("SELECT p.*, s.user_id AS owner_id, s.id AS song_id FROM perspectives p JOIN songs s ON s.id = p.song_id WHERE p.id = ? AND s.user_id = ?")
    .get(id, userId);

export const countPublishedSince = (userId, sinceSql) =>
  db
    .prepare(
      `SELECT COUNT(*) AS n FROM perspectives p JOIN songs s ON s.id = p.song_id
       WHERE s.user_id = ? AND p.published_at IS NOT NULL AND p.published_at >= ${sinceSql}`
    )
    .get(userId).n;

// Public feelings about the same song (matched by normalized title|artist) written by anyone who has an account.
// Returns only what is safe to show: text, mood, anchor, date, a display name. Never an email or user id.
export function listCommunity(userId, groupKey, beforeId, limit = 20) {
  const rows = db
    .prepare(
      `SELECT p.id, p.body, p.mood, p.anchor, p.design, p.published_at, p.updated_at, u.display_name AS author, (s.user_id = ?) AS mine
       FROM perspectives p
       JOIN songs s ON s.id = p.song_id
       JOIN users u ON u.id = s.user_id
       WHERE s.group_key = ? AND p.is_public = 1 AND p.hidden = 0 AND u.display_name IS NOT NULL ${beforeId ? "AND p.id < ?" : ""}
       ORDER BY p.id DESC LIMIT ?`
    )
    .all(...[userId, groupKey, ...(beforeId ? [beforeId] : []), limit + 1]);
  return { items: rows.slice(0, limit).map((r) => ({ ...r, mine: !!r.mine })), hasMore: rows.length > limit };
}

// What other people shared about songs that are in MY library (matched by song key). My own posts are not included —
// they are already in my journal. Returns my copy of the song so each post can link to it.
export function listCommunityFeed(userId, beforeId, limit = 20) {
  const rows = db
    .prepare(
      `SELECT p.id, p.body, p.mood, p.anchor, p.design, p.published_at, u.display_name AS author, m.id AS song_id, m.title, m.artist, m.cover
       FROM perspectives p
       JOIN songs s ON s.id = p.song_id
       JOIN users u ON u.id = s.user_id
       JOIN songs m ON m.user_id = ? AND m.group_key = s.group_key
       WHERE s.user_id <> ? AND p.is_public = 1 AND p.hidden = 0 AND u.display_name IS NOT NULL ${beforeId ? "AND p.id < ?" : ""}
       GROUP BY p.id ORDER BY p.id DESC LIMIT ?`
    )
    .all(...[userId, userId, ...(beforeId ? [beforeId] : []), limit + 1]);
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

// Report a public perspective. Three different people reporting hides it until a moderator looks.
export function reportPerspective(reporterId, perspectiveId, reason) {
  const p = db
    .prepare("SELECT p.id, s.user_id AS owner_id FROM perspectives p JOIN songs s ON s.id = p.song_id WHERE p.id = ? AND p.is_public = 1 AND p.hidden = 0")
    .get(perspectiveId);
  if (!p) return { error: "That post is no longer visible.", status: 404 };
  if (p.owner_id === reporterId) return { error: "You can't report your own post.", status: 400 };
  db.prepare("INSERT OR IGNORE INTO reports (perspective_id, reporter_id, reason) VALUES (?,?,?)").run(perspectiveId, reporterId, reason);
  const n = db.prepare("SELECT COUNT(DISTINCT reporter_id) AS n FROM reports WHERE perspective_id = ? AND status = 'open'").get(perspectiveId).n;
  if (n >= 3) db.prepare("UPDATE perspectives SET hidden = 1 WHERE id = ?").run(perspectiveId);
  return { ok: true, reports: n, autoHidden: n >= 3 };
}

// Moderation queue: public posts with open reports, or hidden posts, newest report first.
export const moderationQueue = () =>
  db
    .prepare(
      `SELECT p.id, p.body, p.mood, p.anchor, p.hidden, p.published_at, u.display_name AS author, u.email AS author_email,
              sg.title AS song_title, sg.artist AS song_artist,
              (SELECT COUNT(*) FROM reports r WHERE r.perspective_id = p.id AND r.status = 'open') AS open_reports,
              (SELECT group_concat(DISTINCT r.reason) FROM reports r WHERE r.perspective_id = p.id AND r.status = 'open') AS reasons
       FROM perspectives p
       JOIN songs sg ON sg.id = p.song_id
       JOIN users u ON u.id = sg.user_id
       WHERE p.is_public = 1 AND (p.hidden = 1 OR EXISTS (SELECT 1 FROM reports r WHERE r.perspective_id = p.id AND r.status = 'open'))
       ORDER BY open_reports DESC, p.id DESC LIMIT 100`
    )
    .all();
export const setHidden = (id, hidden) => db.prepare("UPDATE perspectives SET hidden = ? WHERE id = ?").run(hidden ? 1 : 0, id);
export const dismissReports = (id) => db.prepare("UPDATE reports SET status = 'dismissed' WHERE perspective_id = ?").run(id);

/* ---------- invite codes: one person, one code, one use ---------- */
// The code itself is never stored (only a SHA-256 hash and its last 4 characters), so a leaked database
// cannot be used to sign up. An admin sees a new code exactly once, when it is created.
db.exec(`
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY,
  code_hash TEXT UNIQUE NOT NULL,
  hint TEXT NOT NULL,
  label TEXT,                                   -- who it is for, e.g. "Mei"
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at TEXT
);
`);
const USABLE = "used_at IS NULL AND revoked = 0 AND (expires_at IS NULL OR expires_at > datetime('now'))";
export const inviteIsUsable = (codeHash) => !!db.prepare(`SELECT 1 FROM invites WHERE code_hash = ? AND ${USABLE}`).get(codeHash);
export const countUnusedInvites = () => db.prepare(`SELECT COUNT(*) AS n FROM invites WHERE ${USABLE}`).get().n;
export function createInvite(adminId, codeHash, hint, label, days) {
  const info = db
    .prepare("INSERT INTO invites (code_hash, hint, label, created_by, expires_at) VALUES (?,?,?,?, datetime('now', ?))")
    .run(codeHash, hint, label || null, adminId, `+${Math.floor(days)} days`);
  return Number(info.lastInsertRowid);
}
export const listInvites = () =>
  db
    .prepare(
      `SELECT i.id, i.hint, i.label, i.created_at, i.expires_at, i.used_at, u.display_name AS used_name, u.email AS used_email,
              CASE WHEN i.used_at IS NOT NULL THEN 'used' WHEN i.revoked = 1 THEN 'revoked'
                   WHEN i.expires_at IS NOT NULL AND i.expires_at <= datetime('now') THEN 'expired' ELSE 'unused' END AS status
       FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.id DESC LIMIT 200`
    )
    .all();
export const revokeInvite = (id) => db.prepare("UPDATE invites SET revoked = 1 WHERE id = ? AND used_at IS NULL").run(id).changes === 1;

// Create the account and burn the invite in ONE transaction: two people can never use the same code,
// and a failed sign-up never wastes a code.
export function createUserWithInvite(email, passHash, codeHash) {
  if (!codeHash) return createUser(email, passHash);
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = db.prepare(`UPDATE invites SET used_at = datetime('now') WHERE code_hash = ? AND ${USABLE}`).run(codeHash);
    if (r.changes !== 1) throw Object.assign(new Error("INVITE_USED"), { code: "INVITE_USED" });
    const id = createUser(email, passHash);
    db.prepare("UPDATE invites SET used_by = ? WHERE code_hash = ?").run(id, codeHash);
    db.exec("COMMIT");
    return id;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export const acceptTerms = (userId, version) =>
  db.prepare("UPDATE users SET terms_version = ?, terms_accepted_at = datetime('now') WHERE id = ?").run(version, userId);

/* ---------- feedback / bug reports (readable by admins only) ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,   -- deleted together with the account
  kind TEXT NOT NULL,                                       -- bug | idea | other
  message TEXT NOT NULL,
  page TEXT,                                                -- where in the app the user was, e.g. #/song/8
  ua TEXT,                                                  -- browser type, truncated
  status TEXT NOT NULL DEFAULT 'new',                       -- new | done
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
export const addFeedback = (userId, { kind, message, page, ua }) =>
  db.prepare("INSERT INTO feedback (user_id, kind, message, page, ua) VALUES (?,?,?,?,?)").run(userId, kind, message, page || null, ua || null);
export const listFeedback = (onlyNew) =>
  db
    .prepare(
      `SELECT f.id, f.kind, f.message, f.page, f.ua, f.status, f.created_at, u.display_name, u.email
       FROM feedback f LEFT JOIN users u ON u.id = f.user_id ${onlyNew ? "WHERE f.status = 'new'" : ""}
       ORDER BY f.id DESC LIMIT 200`
    )
    .all();
export const countNewFeedback = () => db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE status = 'new'").get().n;
export const setFeedbackStatus = (id, status) => db.prepare("UPDATE feedback SET status = ? WHERE id = ?").run(status, id);
export const deleteFeedback = (id) => db.prepare("DELETE FROM feedback WHERE id = ?").run(id);

// Before saving a song: what in MY library is the same song, or looks like it? Same title (any artist spelling) is enough to ask.
export function findLibraryMatches(userId, { title, artist, album, cover }) {
  const t = canonTitle(title), gk = groupKeyOf(title, artist), key = songKey(title, artist);
  const token = coverToken(cover), albumKey = albumKeyOf(album);
  return db
    .prepare("SELECT id, key, title, artist, cover, group_key, cover_token, album_key FROM songs WHERE user_id = ? AND substr(group_key, 1, ?) = ? ORDER BY id DESC LIMIT 6")
    .all(userId, t.length + 1, t + "|")
    .map((r) => ({
      id: r.id, title: r.title, artist: r.artist, cover: r.cover,
      // exact = already in the library under this very name; same = same song, spelled a little differently;
      // likely = same title and same cover art / album; similar = same title only
      match: r.key === key ? "exact" : r.group_key === gk ? "same" : (token && r.cover_token === token) || (albumKey && r.album_key === albumKey) ? "likely" : "similar",
    }));
}

/* ---------- "is this the same song as…?" ---------- */
// Other people's versions of the same title that are filed under a different artist spelling (e.g. "PA PUN BAND" vs "怕胖團").
// Only catalog facts (title, artist, cover) and counts are returned — never anything a user wrote.
// Same title AND the same cover art (or the same album) is as good as certain: link it straight away, and tell the owner so they can undo it.
function autoLink(userId, songId) {
  const r = similarSongs(userId, songId);
  const strong = r?.suggestions.filter((s) => s.strong) || [];
  const groups = new Set(strong.map((s) => s.group_key));
  if (groups.size !== 1) return;
  const s = strong[0];
  db.prepare("UPDATE songs SET group_key = ?, group_checked = 1, linked_note = ? WHERE id = ?").run(s.group_key, `${s.title} · ${s.artist}`, songId);
}
export function similarSongs(userId, songId) {
  const mine = db.prepare("SELECT title, group_key, group_checked, cover_token, album_key, linked_note FROM songs WHERE id = ? AND user_id = ?").get(songId, userId);
  if (!mine) return null;
  const t = canonTitle(mine.title);
  const rows = db
    .prepare(
      `SELECT group_key, MIN(title) AS title, MIN(artist) AS artist, MIN(cover) AS cover, COUNT(DISTINCT user_id) AS people,
         MAX(CASE WHEN (? IS NOT NULL AND cover_token = ?) OR (? <> '' AND album_key = ?) THEN 1 ELSE 0 END) AS strong
       FROM songs WHERE id <> ? AND group_key <> ? AND substr(group_key, 1, ?) = ?
       GROUP BY group_key ORDER BY strong DESC, people DESC LIMIT 5`
    )
    .all(mine.cover_token, mine.cover_token, mine.album_key || "", mine.album_key || "", songId, mine.group_key, t.length + 1, t + "|");
  return { checked: !!mine.group_checked, auto: mine.linked_note || null, suggestions: rows.map((r) => ({ ...r, strong: !!r.strong })) };
}
// Join another group (only one that really has the same title), or just record "these are different songs" (groupKey = null).
export function setSongGroup(userId, songId, groupKey) {
  const mine = db.prepare("SELECT title FROM songs WHERE id = ? AND user_id = ?").get(songId, userId);
  if (!mine) return { error: "Song not found", status: 404 };
  if (groupKey) {
    const ok = db.prepare("SELECT 1 FROM songs WHERE group_key = ? AND id <> ? LIMIT 1").get(groupKey, songId);
    if (!ok || !String(groupKey).startsWith(canonTitle(mine.title) + "|")) return { error: "That isn't the same title.", status: 400 };
    db.prepare("UPDATE songs SET group_key = ?, group_checked = 1, linked_note = NULL WHERE id = ?").run(groupKey, songId);
  } else {
    db.prepare("UPDATE songs SET group_checked = 1 WHERE id = ?").run(songId);
  }
  return { ok: true };
}
// Back to this song's own identity (undo a link).
export const resetSongGroup = (userId, songId) =>
  db.prepare("UPDATE songs SET group_key = ?, group_checked = 1, linked_note = NULL WHERE id = ? AND user_id = ?").run(
    ...(() => { const r = db.prepare("SELECT title, artist FROM songs WHERE id = ? AND user_id = ?").get(songId, userId); return [r ? groupKeyOf(r.title, r.artist) : null, songId, userId]; })()
  );
