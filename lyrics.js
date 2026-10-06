import * as OpenCC from "opencc-js";

// Online lyrics lookup across several free sources. Each source returns plain text or null.
// Order depends on the song: Chinese titles try NetEase first, others try LRCLIB first.
export const toSimplified = OpenCC.Converter({ from: "tw", to: "cn" });

export const stripNoise = (s) =>
  String(s)
    .replace(/[\(\[（【].*?[\)\]）】]/g, " ")
    .replace(/\s*[-–—]\s*(remaster(ed)?|live|version|single|mono|stereo|\d{4}).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
export const flat = (x) => toSimplified(String(x)).toLowerCase().replace(/[\s\p{P}]/gu, "");
export const looseEq = (a, b) => {
  a = flat(a);
  b = flat(b);
  return !!a && !!b && (a.includes(b) || b.includes(a));
};
export const hasCJK = (s) => /[぀-ヿ㐀-鿿]/.test(s);

// Reject junk entries (user-submitted databases contain placeholders like "probe").
const usable = (t) => {
  const text = String(t || "").trim();
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines.length >= 4 && text.length >= 60 && !/^\[?instrumental\]?$/i.test(text);
};

// Remove LRC timestamps and credit lines (作词/作曲/…).
const CREDIT = /^\s*(作词|作曲|编曲|制作人?|混音|母带|监制|词|曲|lyrics?|music|composed?|arranged?|producer|written)\s*(by)?\s*[:：]/i;
const cleanLrc = (t) =>
  String(t)
    .replace(/\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, "")
    .split(/\r?\n/)
    .filter((l) => !CREDIT.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export async function getJson(url, headers = {}) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 SongExplain/1.0 (personal use)", ...headers },
      signal: AbortSignal.timeout(8000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
const enc = encodeURIComponent;

async function fromLrclib(artist, title) {
  const t = stripNoise(title), a = stripNoise(artist);
  const exact = await getJson(`https://lrclib.net/api/get?artist_name=${enc(a)}&track_name=${enc(t)}`);
  if (usable(exact?.plainLyrics)) return exact.plainLyrics;
  for (const url of [
    `https://lrclib.net/api/search?track_name=${enc(t)}&artist_name=${enc(a)}`,
    `https://lrclib.net/api/search?q=${enc(`${t} ${a}`)}`,
    `https://lrclib.net/api/search?track_name=${enc(t)}`,
  ]) {
    const list = ((await getJson(url)) || []).filter((r) => usable(r.plainLyrics) && looseEq(r.trackName, t));
    const hit = list.find((r) => looseEq(r.artistName, a)) || (hasCJK(a) ? list[0] : null);
    if (hit) return hit.plainLyrics;
  }
  return null;
}

// NetEase Cloud Music (unofficial public endpoints) — excellent for Chinese, decent for English/Japanese/Korean.
export const NETEASE_HEADERS = { Referer: "https://music.163.com/" };
export async function findNeteaseSong(artist, title) {
  const t = stripNoise(title), a = stripNoise(artist);
  for (const q of [...new Set([`${toSimplified(t)} ${toSimplified(a)}`, `${t} ${a}`, toSimplified(t)])]) {
    const s = await getJson(`https://music.163.com/api/search/get?s=${enc(q)}&type=1&limit=10`, NETEASE_HEADERS);
    const songs = (s?.result?.songs || []).filter((x) => looseEq(x.name, t));
    const hit = songs.find((x) => (x.artists || []).some((ar) => looseEq(ar.name, a)));
    if (hit) return hit;
  }
  return null;
}

async function fromNetease(artist, title) {
  const hit = await findNeteaseSong(artist, title);
  if (!hit) return null;
  const l = await getJson(`https://music.163.com/api/song/lyric?id=${hit.id}&lv=1`, NETEASE_HEADERS);
  const text = cleanLrc(l?.lrc?.lyric || "");
  return usable(text) ? text : null;
}

async function fromLyricsOvh(artist, title) {
  const j = await getJson(`https://api.lyrics.ovh/v1/${enc(stripNoise(artist))}/${enc(stripNoise(title))}`);
  return usable(j?.lyrics) ? j.lyrics.trim() : null;
}

// Returns { text, source } or null.
export async function fetchLyrics(artist, title) {
  const chinese = hasCJK(title) || hasCJK(artist);
  const sources = [
    ["LRCLIB", fromLrclib],
    ["NetEase", fromNetease],
    ["lyrics.ovh", fromLyricsOvh],
  ];
  if (chinese) sources.unshift(sources.splice(1, 1)[0]); // NetEase first for Chinese
  for (const [source, fn] of sources) {
    const text = await fn(artist, title);
    if (text) return { text: text.trim(), source };
  }
  return null;
}
