import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backupTo, DB_PATH } from "./db.js";

// Snapshots live next to the database (on the same volume). They protect against bad deploys and
// corrupted data; to survive losing the volume, also download one now and then (see DEPLOY.md).
const DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), "backups");
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP) || 7); // newest N files; the privacy notice promises ≤ 30 days
const DAY = 24 * 3600 * 1000;
const list = () => fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /^songexplain-.*\.db$/.test(f)).sort() : [];

export function runBackup() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
  const file = path.join(DIR, `songexplain-${stamp}.db`);
  backupTo(file);
  for (const old of list().slice(0, -KEEP)) fs.rmSync(path.join(DIR, old), { force: true });
  return file;
}

// Runs one snapshot if the newest is older than a day. The machine sleeps when idle, so this is
// checked at start-up and every few hours while it is awake.
export function backupIfDue() {
  try {
    const last = list().at(-1);
    if (last && Date.now() - fs.statSync(path.join(DIR, last)).mtimeMs < DAY) return;
    console.log("Backup written:", runBackup());
  } catch (e) {
    console.error("Backup failed:", e.message);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log("Backup written:", runBackup());
