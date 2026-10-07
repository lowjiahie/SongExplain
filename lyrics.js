import * as OpenCC from "opencc-js";

// Online lyrics lookup across several free sources. Each source returns plain text or null.
// Order depends on the song: Chinese titles try NetEase first, others try LRCLIB first; Kugou and lyrics.ovh are fallbacks.
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
  const hit = await lrclibOnce(artist, title);
  if (hit) return hit;
  const st = toSimplified(stripNoise(title)), sa = toSimplified(stripNoise(artist));
  return st !== stripNoise(title) || sa !== stripNoise(artist) ? lrclibOnce(sa, st) : null; // 魚 vs 鱼: the database may use either
}
async function lrclibOnce(artist, title) {
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

// Kugou (unofficial public endpoints) — large Chinese catalogue, and plenty of English / Japanese / Korean / Malay pop.
const DERIVATIVE_TITLE = /伴奏|karaoke|ktv|instrumental|cover|翻唱|remix|dj|live|现场|纯音乐/i;
const uniq = (xs) => [...new Set(xs.filter(Boolean))];
async function fromKugou(artist, title) {
  const t = stripNoise(title), a = stripNoise(artist);
  for (const q of uniq([`${toSimplified(t)} ${toSimplified(a)}`, `${t} ${a}`, toSimplified(t)])) {
    const s = await getJson(`https://mobileservice.kugou.com/api/v3/search/song?format=json&keyword=${enc(q)}&page=1&pagesize=10`);
    const songs = (s?.data?.info || []).filter((x) => looseEq(x.songname, t) && !DERIVATIVE_TITLE.test(x.songname) && x.hash);
    const sameArtist = (x) => String(x.singername || "").split(/[、,&，]/).some((n) => looseEq(n, a));
    // "Jay Chou" vs "周杰伦": different scripts can't be compared, so accept an exact title match from the first result
    const crossScript = (x) => hasCJK(x.singername || "") !== hasCJK(a) && flat(x.songname) === flat(t);
    const hit = songs.find(sameArtist) || songs.find(crossScript);
    if (!hit) continue;
    const c = await getJson(`https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${enc(hit.songname)}&hash=${hit.hash}&duration=${(hit.duration || 0) * 1000}`);
    const cand = (c?.candidates || [])[0];
    if (!cand) continue;
    const d = await getJson(`https://lyrics.kugou.com/download?ver=1&client=pc&id=${cand.id}&accesskey=${cand.accesskey}&fmt=lrc&charset=utf8`);
    if (!d?.content) continue;
    let text = cleanLrc(Buffer.from(d.content, "base64").toString("utf8"));
    text = text.split(/\r?\n/).filter((l, i) => !(i === 0 && /^.{1,40}\s-\s.{1,80}$/.test(l.trim()))).join("\n").trim(); // "Artist - Title" header line
    if (usable(text)) return text;
  }
  return null;
}

// Looking up lyrics hits several free sites, so remember the answer for a while: a hit for 6 hours, a miss for 20 minutes
// (so pressing Explain again on a song nobody has lyrics for doesn't repeat the whole search every time).
const LYRIC_CACHE = new Map(); // key -> { exp, value: Promise<{text, source}|null> }
// fresh: true skips the remembered answer (used by the "Sync lyrics" button).
export async function fetchLyrics(artist, title, { fresh = false } = {}) {
  const key = flat(artist) + "|" + flat(stripNoise(title));
  const hit = LYRIC_CACHE.get(key);
  if (hit && hit.exp > Date.now() && !fresh) return hit.value;
  const value = findLyrics(artist, title).catch(() => null);
  LYRIC_CACHE.set(key, { exp: Date.now() + 20 * 60_000, value });
  value.then((r) => { if (r) LYRIC_CACHE.get(key).exp = Date.now() + 6 * 3600_000; });
  if (LYRIC_CACHE.size > 500) LYRIC_CACHE.delete(LYRIC_CACHE.keys().next().value);
  return value;
}

// Returns { text, source } or null.
async function findLyrics(artist, title) {
  const chinese = hasCJK(title) || hasCJK(artist);
  const sources = [
    ["LRCLIB", fromLrclib],
    ["NetEase", fromNetease],
    ["Kugou", fromKugou],
    ["lyrics.ovh", fromLyricsOvh],
  ];
  if (chinese) sources.unshift(sources.splice(1, 1)[0]); // NetEase first for Chinese
  for (const [source, fn] of sources) {
    const text = await fn(artist, title);
    if (text) return { text: text.trim(), source };
  }
  return null;
}

export { fromLrclib, fromNetease, fromLyricsOvh, fromKugou }; // exported so each source can be measured on its own
