import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Encryption at rest for users' API keys: AES-256-GCM with a per-user key derived (HKDF) from one
// master secret. A stolen database file alone is useless without the master secret, and a key row
// copied to another user's account will not decrypt (user id is part of the key and the AAD).
//
//   Hosting (HOST != 127.0.0.1):  APP_SECRET env var is REQUIRED (>= 32 chars).
//   Local use:                    if APP_SECRET is not set, one is generated into data/.app-secret.
let master = null;

export function init() {
  let s = process.env.APP_SECRET;
  if (s) {
    if (s.length < 32) throw new Error("APP_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 48");
  } else if ((process.env.HOST || "127.0.0.1") !== "127.0.0.1") {
    throw new Error("APP_SECRET is required when HOST is not 127.0.0.1 (it encrypts saved API keys). Generate one with: openssl rand -base64 48");
  } else {
    const file = path.join(path.dirname(process.env.DB_FILE || "data/songexplain.db"), ".app-secret");
    if (fs.existsSync(file)) s = fs.readFileSync(file, "utf8").trim();
    else {
      s = crypto.randomBytes(48).toString("base64");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, s, { mode: 0o600 });
    }
  }
  master = Buffer.from(s, "utf8");
}

const userKey = (userId) =>
  Buffer.from(crypto.hkdfSync("sha256", master, Buffer.from("song-explain/api-keys/v1"), Buffer.from(`user:${userId}`), 32));
const b64 = (b) => Buffer.from(b).toString("base64url");

export function encrypt(userId, label, plaintext) {
  if (!master) init();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", userKey(userId), iv);
  c.setAAD(Buffer.from(`${userId}:${label}`));
  const data = Buffer.concat([c.update(String(plaintext), "utf8"), c.final()]);
  return ["v1", b64(iv), b64(c.getAuthTag()), b64(data)].join(".");
}

export function decrypt(userId, label, blob) {
  if (!master) init();
  try {
    const [v, iv, tag, data] = String(blob).split(".");
    if (v !== "v1") throw new Error("bad version");
    const d = crypto.createDecipheriv("aes-256-gcm", userKey(userId), Buffer.from(iv, "base64url"));
    d.setAAD(Buffer.from(`${userId}:${label}`));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
  } catch {
    throw Object.assign(new Error("A saved API key could not be decrypted (the server secret changed?). Please enter it again in AI settings."), { status: 409 });
  }
}

// What is shown in the UI instead of the key: only the last 4 characters.
export const keyHint = (key) => (String(key).length >= 12 ? `••••${String(key).slice(-4)}` : "••••");
