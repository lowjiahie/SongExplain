import * as OpenCC from "opencc-js";
import { getJson, toSimplified, hasCJK } from "./lyrics.js";

// Song search that is meant to find the song you have in mind, not just the exact spelling.
//   • several free catalogues in parallel: Deezer (huge, forgiving of typos, has covers), Apple iTunes
//     (US + TW + MY first, more regions only when needed) and MusicBrainz (obscure / older songs) as a last resort
//   • the query is cleaned (YouTube noise, brackets, "feat.") and tried in a few variants:
//     simplified <-> traditional Chinese, "《title》 artist" marks, a shorter version for typos
//   • everything is merged, de-duplicated and ranked by how well it matches what was typed;
//     karaoke / tribute / "originally performed by" versions are pushed down
const toTW = OpenCC.Converter({ from: "cn", to: "tw" });
const toCN = OpenCC.Converter({ from: "tw", to: "cn" });
const enc = encodeURIComponent;

/* ---------------- cleaning ---------------- */
// Strip the noise that YouTube titles and users add around a song name.
export function cleanTitle(raw) {
  return String(raw || "")
    .replace(/[\(\[【「（][^\)\]】」）]*(official|mv|m\/v|lyric|audio|video|visuali[sz]er|hd|4k|remaster|live|karaoke|歌词|歌詞|完整版|官方|高清|动态|动态歌词|字幕|纯享|现场)[^\)\]】」）]*[\)\]】」）]/gi, " ")
    .replace(/\b(official\s*(music\s*)?(video|mv|audio|lyric\s*video)|lyrics?\s*video|lyrics?|visuali[sz]er|m\/v|mv|hd|4k)\b/gi, " ")
    .replace(/(歌词|歌詞|完整版|高清)/g, " ")
    .replace(/\s*[-–—]\s*topic\b/gi, " ")
    .replace(/\bvevo\b/gi, " ")
    .replace(/\b(feat\.?|ft\.?|featuring)\b.*$/i, " ")
    .replace(/[|_｜]/g, " ")
    .replace(/\s+[-–—]\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
// Collapse whitespace and drop repeated words ("Rick Astley Rick Astley" -> "Rick Astley").
const tidy = (s) => {
  const seen = new Set();
  return String(s).split(/\s+/).filter((w) => { const k = w.toLowerCase(); if (!w || seen.has(k)) return false; seen.add(k); return true; }).join(" ").trim();
};

export function buildQueries(raw) {
  const q = tidy(cleanTitle(raw));
  const out = [];
  const add = (s) => { s = tidy(s || ""); if (s.length >= 2 && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s); };
  const marked = q.match(/[《「『“"]([^》」』”"]+)[》」』”"]/); // 《晴天》周杰伦
  if (marked) add(`${marked[1]} ${q.replace(marked[0], " ")}`);
  add(q);
  if (hasCJK(q)) { add(toTW(q)); add(toCN(q)); }
  const words = q.split(" ");
  if (words.length >= 3) add(words.slice(0, -1).join(" ")); // a typo or stray word at the end
  return out.slice(0, 4);
}

/* ---------------- matching & ranking ---------------- */
const norm = (s) => toSimplified(String(s || "").toLowerCase()).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const tokensOf = (n) => n.match(/[぀-ヿ㐀-鿿]|[^\s぀-ヿ㐀-鿿]+/g) || []; // CJK by character, others by word
const baseTitle = (t) => norm(String(t).replace(/[\(\[（【].*?[\)\]）】]/g, " ").replace(/\s[-–—]\s.*$/, " "));
// Two entries are the same recording only if they differ by edition noise (remaster, deluxe, "- 2011 Remaster", feat. ...),
// NOT if one is a remix / live / acoustic / cover version.
const EDITION_NOISE = /remaster|deluxe|anniversary|bonus|explicit|clean|mono|stereo|expanded|single|album version|radio edit|from |feat|ft\.|with |\d{4}/i;
const dupTitle = (t) =>
  norm(String(t).replace(/[\(\[（【]([^\)\]）】]*)[\)\]）】]/g, (m, inner) => (EDITION_NOISE.test(inner) ? " " : m)).replace(/\s[-–—]\s.*(remaster|version|edit|mix|\d{4}).*$/i, " "));
const firstArtist = (a) => norm(String(a).split(/,|&|\bfeat\.?|\bft\.?|、|\/|;|\band\b/i)[0]);
const DERIVATIVE = /karaoke|instrumental|tribute|originally performed|made famous|in the style of|backing track|piano ver|guitar version|lullaby|8-?bit|ringtone|music box|cover version|[(\[]\s*cover\b|\bcover by\b|nightcore|sped up|slowed|lo-?fi|8d audio|カラオケ|ガイド無し|オルゴール|カバー|ピアノ|伴奏|翻唱|原曲歌手/i;

// Edit distance up to `max` (small strings only) — lets "sheran" find "sheeran".
function within(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] <= max;
}
const SLANG = { u: "you", r: "are", ur: "your", y: "why", n: "and", "2": "to", "4": "for" };

function tokenHit(t, hay, hayWords) {
  if (hay.includes(t)) return true;
  if (SLANG[t] && hayWords.includes(SLANG[t])) return true;
  if (/^[a-z]+$/.test(t) && t.length >= 4) { // typo tolerance for words of 4+ letters
    const max = t.length >= 8 ? 2 : 1;
    return hayWords.some((w) => within(t, w, max));
  }
  return false;
}

const expandSlang = (tokens) => tokens.map((t) => SLANG[t] || t);
function artistInQuery(artist, qTokens) {
  const words = tokensOf(artist).filter((w) => w.length > 1 || /[\u3040-\u30ff\u3400-\u9fff]/.test(w));
  if (!words.length) return false;
  return words.every((w) => qTokens.some((t) => t === w || (/^[a-z]+$/.test(w) && w.length >= 4 && within(t, w, w.length >= 8 ? 2 : 1))));
}
// All scoring weights in one place, so they can be tuned against recorded results without touching the logic.
export const W = {
  tokens: 1.0, titleIn: 0.5, titleExact: 0.4, artistIn: 0.3,
  pos: { itunes: [0.5, 0.08], deezer: [0.5, 0.08], musicbrainz: [0.3, 0.05] }, // [bonus at position 0, loss per position]
  agree: 0.3, pop: 0.8, derivative: -0.7,
  artistTop: 0.0, // the artist matches what was typed AND a catalogue puts the song near its top
  alias: 0.0,     // the text barely matches (other script / translated title) but a catalogue itself ranks it first
};

function score(c, qn, qTokens, queryWantsDerivative) {
  const qn2 = expandSlang(qTokens).join(" ");
  const hay = norm(`${c.title} ${c.artist} ${c.album || ""}`);
  const hayWords = hay.split(" ");
  const title = baseTitle(c.title), artist = firstArtist(c.artist);
  const ratio = qTokens.length ? qTokens.filter((t) => tokenHit(t, hay, hayWords)).length / qTokens.length : 0;
  let s = W.tokens * ratio;
  if (title.length >= 2 && (qn.includes(title) || qn2.includes(title))) s += W.titleIn;          // the song's title is in what was typed
  if (title && (norm(c.title) === qn || norm(c.title) === qn2)) s += W.titleExact;                // typed exactly the title
  const artistHit = artist.length >= 2 && (qn.includes(artist) || artistInQuery(c.artist, qTokens));
  if (artistHit) s += W.artistIn;                                                                  // the artist is in what was typed
  // trust each catalogue's own ranking for its best hits (best position over the lists the song appeared in)
  let posBonus = 0;
  for (const [via, p] of Object.entries(c.bestPos)) { const [base, step] = W.pos[via] || [0.3, 0.05]; posBonus = Math.max(posBonus, base - p * step); }
  s += Math.max(0, posBonus);
  if (artistHit && c.pos <= 2) s += W.artistTop;
  if (ratio < 0.5 && c.pos === 0) s += W.alias;
  s += W.agree * (c.srcs.size - 1);                                                                // two catalogues agree -> probably the right song
  if (c.pop > 0) s += W.pop * Math.min(1, Math.log10(c.pop) / 6);                                  // Deezer popularity: originals outrank cover versions
  if (!queryWantsDerivative && DERIVATIVE.test(`${c.title} ${c.artist} ${c.album || ""}`)) s += W.derivative;
  return s + (c.cover ? 0.02 : 0) + (c.year ? 0.01 : 0);
}

// Merge duplicates (same title + first artist across sources/editions), keep the richest data, rank by score.
export function rank(lists, rawQuery) {
  const qn = norm(cleanTitle(rawQuery));
  const qTokens = tokensOf(qn);
  const wantsDerivative = DERIVATIVE.test(rawQuery);
  const byKey = new Map();
  let order = 0;
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++)           // interleave sources so one catalogue cannot crowd out the others
    for (const list of lists) {
      const c = list[i];
      if (!c || !c.title || !c.artist) continue;
      const key = `${dupTitle(c.title)}|${firstArtist(c.artist)}`;
      const have = byKey.get(key);
      if (!have) byKey.set(key, { ...c, order: order++, pos: i, srcs: new Set([c.via]), pop: c.pop || 0, bestPos: { [c.via]: i } });
      else {                                   // fill gaps from the duplicate
        have.cover ||= c.cover; have.year ||= c.year; have.album ||= c.album;
        have.pos = Math.min(have.pos, i); have.srcs.add(c.via); have.bestPos[c.via] = Math.min(have.bestPos[c.via] ?? 1e9, i); have.pop = Math.max(have.pop || 0, c.pop || 0);
        if (c.via === "itunes" && c.cover) have.cover = c.cover; // Apple covers are the sharpest
      }
    }
  return [...byKey.values()]
    .map((c) => ({ ...c, _s: score(c, qn, qTokens, wantsDerivative) }))
    .sort((a, b) => b._s - a._s || a.order - b.order);
}

/* ---------------- sources ---------------- */
const norm1 = (r) => ({
  title: r.trackName, artist: r.artistName, album: r.collectionName,
  year: r.releaseDate?.slice(0, 4), cover: r.artworkUrl100?.replace("100x100", "400x400"), via: "itunes",
});
async function itunes(term, stores, limit = 30) {
  const lists = await Promise.all(stores.map(async (country) => {
    const j = await getJson(`https://itunes.apple.com/search?media=music&entity=song&limit=${limit}&country=${country}&term=${enc(term)}`);
    return (j?.results || []).filter((r) => r.trackName && r.artistName).map(norm1);
  }));
  return lists;
}
async function deezer(term) {
  const j = await getJson(`https://api.deezer.com/search?q=${enc(term)}&limit=50`);
  return (j?.data || []).map((t) => ({
    title: t.title_short || t.title, artist: t.artist?.name, album: t.album?.title, year: null,
    cover: t.album?.cover_big || t.album?.cover_medium || null, via: "deezer", pop: t.rank || 0,
  }));
}
async function musicbrainz(term) {
  const j = await getJson(`https://musicbrainz.org/ws/2/recording?query=${enc(term)}&fmt=json&limit=25`, { "User-Agent": "SongExplain/1.0 ( personal beta )" });
  return (j?.recordings || []).map((r) => ({
    title: r.title, artist: (r["artist-credit"] || []).map((a) => a.name).join(", ") || null,
    album: r.releases?.[0]?.title || null, year: (r["first-release-date"] || "").slice(0, 4) || null, cover: null, via: "musicbrainz",
  }));
}

/* ---------------- the search ---------------- */
const cache = new Map(); // normalized query -> { at, result }; keeps repeat searches instant and spares the free APIs
const TTL = 10 * 60_000;
const GOOD = 0.9;
const CONFIDENT = 1.7; // a result that matches title + artist this well means we can stop searching wider

export async function searchSongs(raw, { record } = {}) {
  const key = norm(cleanTitle(raw));
  if (!key) return { candidates: [], queries: [] };
  const hit = record ? null : cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.result;

  const queries = buildQueries(raw);
  const main = queries[0] || String(raw);
  const cjk = hasCJK(main);
  const lists = [];
  const look = () => { const r = rank(lists, main); return { best: r[0]?._s || 0, good: r.filter((c) => c._s >= GOOD).length }; };

  // Phase 1: the main query, everywhere that is cheap.
  const stores = cjk ? ["TW", "MY", "US"] : ["US", "MY", "TW"];
  const [apple, dz] = await Promise.all([itunes(main, stores), deezer(main)]);
  lists.push(...apple, dz);

  // Phase 2: not enough good matches -> try the other spellings (simplified/traditional, shorter, 《》 form).
  const v2 = look();
  if ((v2.best < CONFIDENT || v2.good < 3) && queries.length > 1) {
    const rest = queries.slice(1);
    const more = await Promise.all(rest.flatMap((q) => [deezer(q), itunes(q, [hasCJK(q) ? "TW" : "US"], 25).then((x) => x[0] || [])]));
    lists.push(...more);
  }

  // Phase 3: still thin -> wider Apple regions and MusicBrainz (older / obscure / regional songs).
  const v3 = look();
  if (v3.best < 1.3 || v3.good < 2) {
    const [wide, mb] = await Promise.all([itunes(main, ["HK", "SG", "GB", "JP"], 15), musicbrainz(main)]);
    lists.push(...wide, mb);
  }

  if (record) record.push({ raw, main, lists });
  const ranked = rank(lists, main);
  // Keep strong matches first; weaker ones follow so the page is never empty when something plausible exists.
  const candidates = ranked.map(({ _s, order, pos, srcs, pop, bestPos, ...c }) => ({ ...c, via: [...srcs].join("+") }));
  const result = { candidates, queries };
  if (candidates.length) {
    cache.set(key, { at: Date.now(), result });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
  }
  return result;
}

// Combine result lists (e.g. from AI-suggested spellings) without repeating songs.
export function mergeCandidates(first, ...others) {
  const seen = new Set(first.map((c) => `${dupTitle(c.title)}|${firstArtist(c.artist)}`));
  const out = [...first];
  for (const list of others) for (const c of list) {
    const k = `${dupTitle(c.title)}|${firstArtist(c.artist)}`;
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  }
  return out;
}
