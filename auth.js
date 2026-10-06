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

export function checkInvite(code) {
  const need = process.env.INVITE_CODE;
  if (process.env.REGISTRATION === "closed") return "Registration is closed.";
  if (!need) return null;
  const a = Buffer.from(String(code || "")), b = Buffer.from(need);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? null : "A valid invite code is required.";
}
