import crypto from "node:crypto";
import * as db from "./db.js";

// ---------- passwords (scrypt) ----------
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? rej(e) : res(k))));

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${(await scrypt(pw, salt)).toString("base64")}`;
}
const DUMMY = hashPassword("dummy-password-for-timing"); // so unknown emails cost the same time as known ones
export async function verifyPassword(pw, stored) {
  const [, saltB64, hashB64] = String(stored || (await DUMMY)).split("$");
  const expected = Buffer.from(hashB64 || "", "base64");
  const actual = await scrypt(pw, Buffer.from(saltB64 || "", "base64"));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// ---------- cookies & sessions ----------
export function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function setSessionCookie(req, res, token, maxAge) {
  const secure = req.secure || process.env.COOKIE_SECURE === "1";
  res.setHeader("Set-Cookie", `sid=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}${secure ? "; Secure" : ""}`);
}
export function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

// Attach req.user (or null) from the session cookie.
export function attachUser(req, _res, next) {
  req.sessionToken = cookies(req).sid || "";
  req.user = db.sessionUser(req.sessionToken);
  next();
}
export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Please sign in.", code: "AUTH" });
  next();
}

// ---------- CSRF defence ----------
// Cookies are SameSite=Lax and the API only accepts JSON; additionally reject cross-origin writes.
export function sameOriginWrites(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return res.status(403).json({ error: "Cross-origin request blocked." });
    } catch {
      return res.status(403).json({ error: "Bad origin." });
    }
  }
  next();
}

// ---------- simple in-memory rate limiter ----------
export function rateLimit({ windowMs, max, by = "ip", message = "Too many requests. Please slow down." }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60_000).unref();
  return (req, res, next) => {
    const id = by === "user" && req.user ? `u${req.user.id}` : `ip${req.ip}`;
    const now = Date.now();
    let h = hits.get(id);
    if (!h || h.reset < now) hits.set(id, (h = { n: 0, reset: now + windowMs }));
    if (++h.n > max) {
      res.setHeader("Retry-After", Math.ceil((h.reset - now) / 1000));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

// ---------- validation ----------
export const validEmail = (e) => typeof e === "string" && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
export const validPassword = (p) => typeof p === "string" && p.length >= 8 && p.length <= 200;

// ---------- registration & invite codes ----------
// closed: nobody can sign up · invite: a one-time code is needed · open: anyone can.
// Accounts listed in ADMIN_EMAILS can always sign up (so the owner can create the first account).
// When the app is hosted publicly (HOST != 127.0.0.1) and nothing is configured, it defaults to "invite", never "open".
export function registrationMode() {
  const r = String(process.env.REGISTRATION || "").toLowerCase();
  if (r === "closed") return "closed";
  if (r === "invite" || process.env.INVITE_CODE) return "invite";
  if (r === "open") return "open";
  return (process.env.HOST || "127.0.0.1") === "127.0.0.1" ? "open" : "invite";
}
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L: easy to read out loud
export function generateCode() {
  const part = () => Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join("");
  return `${part()}-${part()}`; // ~8.5e11 possibilities; guessing is also rate-limited
}
export const normalizeCode = (c) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
export const hashCode = (normalized) => crypto.createHash("sha256").update(normalized).digest("hex");
// Optional legacy shared code (INVITE_CODE). Works for everyone who knows it, so one-time codes are preferred.
export function sharedCodeMatches(raw) {
  const need = process.env.INVITE_CODE;
  if (!need) return false;
  const a = Buffer.from(String(raw || "")), b = Buffer.from(need);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
