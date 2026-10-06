import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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

const norm = (s) => String(s).toLowerCase().replace(/[\(\[].*?[\)\]]/g, "").replace(/\s+/g, " ").trim();
const songKey = (title, artist) => `${norm(title)}|${norm(artist)}`;
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
export const getUserById = (id) => db.prepare("SELECT id, email, created_at FROM users WHERE id = ?").get(id);
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
    if (lyrics?.trim()) db.prepare("UPDATE songs SET lyrics = ? WHERE id = ?").run(lyrics.trim(), found.id);
    return getSong(userId, found.id);
  }
  const info = db
    .prepare("INSERT INTO songs (user_id,key,title,artist,album,year,cover,source,lyrics) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(userId, key, title, artist, album ?? null, year ?? null, cover ?? null, source, lyrics?.trim() || null);
  return getSong(userId, Number(info.lastInsertRowid));
}

export const getSong = (userId, id) => publicSong(db.prepare("SELECT * FROM songs WHERE id = ? AND user_id = ?").get(id, userId));
export const getSongLyrics = (userId, id) => db.prepare("SELECT lyrics FROM songs WHERE id = ? AND user_id = ?").get(id, userId)?.lyrics || null;
export const setLyrics = (userId, id, lyrics) =>
  db.prepare("UPDATE songs SET lyrics = ? WHERE id = ? AND user_id = ?").run(lyrics?.trim() || null, id, userId);
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
export const addPerspective = (songId, { body, mood, anchor }) =>
  db.prepare("INSERT INTO perspectives (song_id,body,mood,anchor) VALUES (?,?,?,?)").run(songId, body, mood || null, anchor || null);
export const updatePerspective = (userId, id, { body, mood, anchor }) =>
  db
    .prepare(
      `UPDATE perspectives SET body=?, mood=?, anchor=?, updated_at=datetime('now')
       WHERE id=? AND song_id IN (SELECT id FROM songs WHERE user_id = ?)`
    )
    .run(body, mood || null, anchor || null, id, userId);
export const deletePerspective = (userId, id) =>
  db.prepare("DELETE FROM perspectives WHERE id = ? AND song_id IN (SELECT id FROM songs WHERE user_id = ?)").run(id, userId);

// Everything a user owns, for data export.
export function exportAll(userId) {
  const songs = db.prepare("SELECT * FROM songs WHERE user_id = ? ORDER BY id").all(userId);
  return songs.map((s) => ({
    title: s.title, artist: s.artist, album: s.album, year: s.year, cover: s.cover, source: s.source, lyrics: s.lyrics, created_at: s.created_at,
    explanations: listExplanations(s.id).map(({ language, provider, model, body, created_at }) => ({ language, provider, model, body, created_at })),
    perspectives: listPerspectives(s.id).map(({ body, mood, anchor, created_at, updated_at }) => ({ body, mood, anchor, created_at, updated_at })),
  }));
}
