import { getJson, findNeteaseSong, NETEASE_HEADERS, stripNoise, looseEq, hasCJK, toSimplified } from "./lyrics.js";

// "What do other people say about this song?" — gathered from public sources, shown to the user
// and handed to the AI as background data. Everything is validated; if nothing trustworthy is
// found we return nothing, and the AI is told not to claim any outside knowledge.
const enc = encodeURIComponent;
const cache = new Map(); // in-memory, per server run

// Listener comments from NetEase Cloud Music: real feelings and stories from people who love the song.
// Nicknames are deliberately not collected.
async function listenerViews(artist, title) {
  const hit = await findNeteaseSong(artist, title);
  if (!hit) return [];
  const c = await getJson(`https://music.163.com/api/v1/resource/comments/R_SO_4_${hit.id}?limit=30&offset=0`, NETEASE_HEADERS);
  const seen = new Set();
  return [...(c?.hotComments || []), ...(c?.comments || [])]
    .map((x) => ({ text: String(x.content || "").replace(/\s+/g, " ").trim(), likes: x.likedCount || 0 }))
    .filter((x) => x.text.length >= 15 && x.text.length <= 400 && !/https?:\/\/|加微信|关注我|求赞/.test(x.text))
    .filter((x) => (seen.has(x.text) ? false : seen.add(x.text)))
    .sort((a, b) => b.likes - a.likes)
    .slice(0, 30);
}

// Wikipedia article about the song itself (verified: title must match AND the artist must be mentioned).
async function wikipediaBackground(artist, title) {
  const t = stripNoise(title), a = stripNoise(artist);
  const langs = hasCJK(t) || hasCJK(a) ? ["zh", "en"] : ["en"];
  for (const lang of langs) {
    const q = lang === "zh" ? `${toSimplified(t)} ${toSimplified(a)}` : `${t} ${a} song`;
    const s = await getJson(`https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${enc(q)}&srlimit=4&format=json&origin=*`);
    for (const r of s?.query?.search || []) {
      if (!looseEq(r.title, t)) continue;
      const x = await getJson(
        `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exsectionformat=plain&titles=${enc(r.title)}&format=json&origin=*&redirects=1`
      );
      const text = Object.values(x?.query?.pages || {})[0]?.extract || "";
      // The article must actually be about this artist's song.
      const head = text.slice(0, 1500);
      if (text && (looseEq(head, a) || toSimplified(head).includes(toSimplified(a))))
        return { lang, title: r.title, url: `https://${lang}.wikipedia.org/wiki/${enc(r.title.replace(/ /g, "_"))}`, text: text.slice(0, 5000) };
    }
  }
  return null;
}

const cleanComment = (x) => ({ text: String(x.content || "").replace(/\s+/g, " ").trim(), likes: x.likedCount || 0 });
const okComment = (x) => x.text.length >= 12 && x.text.length <= 500 && !/https?:\/\/|加微信|关注我|求赞|互关/.test(x.text);
const neteaseIds = new Map();

// Page through NetEase comments. Page 0 = the "hot" comments first, then the newest ones;
// later pages are the newest comments, 100 at a time (many are short, so we filter).
export async function neteasePage(artist, title, offset = 0) {
  const key = `${artist}|${title}`.toLowerCase();
  if (!neteaseIds.has(key)) neteaseIds.set(key, (await findNeteaseSong(artist, title))?.id || null);
  const id = neteaseIds.get(key);
  if (!id) return { items: [], hasMore: false, total: 0, nextOffset: 0 };
  const c = await getJson(`https://music.163.com/api/v1/resource/comments/R_SO_4_${id}?limit=100&offset=${offset}`, NETEASE_HEADERS);
  const raw = [...(offset === 0 ? c?.hotComments || [] : []), ...(c?.comments || [])];
  return {
    items: raw.map(cleanComment).filter(okComment),
    total: c?.total || 0,
    hasMore: !!c?.more,
    nextOffset: offset + 100,
  };
}

// YouTube comments via the user's OWN YouTube Data API key (free quota). Finds the song's video,
// then pages through its comments (most relevant first).
const ytVideos = new Map();
export async function youtubePage(artist, title, apiKey, pageToken = "") {
  const t = stripNoise(title), a = stripNoise(artist);
  const yt = async (path, params) => {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({ ...params, key: apiKey })}`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const reason = j.error?.errors?.[0]?.reason || "";
      if (reason === "commentsDisabled") throw Object.assign(new Error("Comments are disabled on this video."), { status: 422 });
      if (/quotaExceeded|rateLimit/.test(reason)) throw Object.assign(new Error("Your YouTube API daily quota is used up. Try again tomorrow."), { status: 429 });
      throw Object.assign(new Error(`YouTube API error: ${j.error?.message || r.status}`), { status: r.status === 400 || r.status === 403 ? 401 : 502 });
    }
    return j;
  };
  const vkey = `${artist}|${title}`.toLowerCase();
  if (!ytVideos.has(vkey)) {
    const s = await yt("search", { part: "snippet", q: `${t} ${a}`, type: "video", maxResults: "8", videoCategoryId: "10" });
    const hit = (s.items || []).find((i) => looseEq(i.snippet.title, t) && (looseEq(i.snippet.title, a) || looseEq(i.snippet.channelTitle, a)))
      || (s.items || []).find((i) => looseEq(i.snippet.title, t));
    ytVideos.set(vkey, hit ? { id: hit.id.videoId, title: hit.snippet.title } : null);
  }
  const video = ytVideos.get(vkey);
  if (!video) return { items: [], nextPageToken: null, video: null };
  const p = { part: "snippet", videoId: video.id, order: "relevance", maxResults: "50", textFormat: "plainText" };
  if (pageToken) p.pageToken = pageToken;
  const c = await yt("commentThreads", p);
  return {
    items: (c.items || [])
      .map((i) => ({ text: String(i.snippet.topLevelComment.snippet.textDisplay || "").replace(/\s+/g, " ").trim(), likes: i.snippet.topLevelComment.snippet.likeCount || 0 }))
      .filter(okComment),
    nextPageToken: c.nextPageToken || null,
    video: { title: video.title, url: `https://www.youtube.com/watch?v=${video.id}` },
  };
}

// Reddit discussions about the song, through Reddit's public RSS feeds (no account or key). Best effort: Reddit may refuse
// requests from some servers, in which case this simply finds nothing. Only the text of posts and comments is kept —
// never user names. The page links to the threads so people can read (and join) them on Reddit itself.
const REDDIT_UA = "Mozilla/5.0 (compatible; SongExplain/1.0; personal use)";
const decodeHtml = (s) =>
  String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, "&");
const htmlToText = (s) => decodeHtml(decodeHtml(s).replace(/<(br|\/p|\/li)\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
let redditBusyUntil = 0;
async function redditFeed(url) {
  if (Date.now() < redditBusyUntil) return [];
  try {
    const r = await fetch(url, { headers: { "User-Agent": REDDIT_UA, Accept: "application/atom+xml,application/xml,text/xml" }, signal: AbortSignal.timeout(9000) });
    if (r.status === 429) { redditBusyUntil = Date.now() + 5 * 60_000; return []; } // Reddit asks us to slow down: stop asking for 5 minutes
    if (!r.ok) return [];
    const xml = await r.text();
    return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => ({
      title: htmlToText((m[1].match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || ""),
      url: (m[1].match(/<link[^>]*href="([^"]+)"/) || [])[1] || "",
      text: htmlToText((m[1].match(/<content[^>]*>([\s\S]*?)<\/content>/) || [])[1] || ""),
    }));
  } catch { return []; }
}
const redditCache = new Map();
export async function redditPage(artist, title) {
  const t = stripNoise(title), a = stripNoise(artist);
  const key = `${a}|${t}`.toLowerCase();
  const hit = redditCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  if (Date.now() < redditBusyUntil) return { items: [], threads: [], busy: true };
  const found = await redditFeed(`https://www.reddit.com/search.rss?q=${enc(`"${t}" ${a}`)}&sort=relevance&t=all&limit=15`);
  // a thread counts only if it really mentions both the song and the artist
  const threads = found.filter((f) => /\/comments\//.test(f.url) && looseEq(`${f.title} ${f.text}`, t) && looseEq(`${f.title} ${f.text}`, a)).slice(0, 4);
  const items = [], seen = new Set();
  const add = (text) => { if (okComment({ text }) && !seen.has(text)) { seen.add(text); items.push({ text, likes: null }); } };
  for (const th of threads) { add(th.text); }
  const bodies = await Promise.all(threads.slice(0, 3).map((th) => redditFeed(th.url.replace(/\/?$/, "/") + ".rss?limit=40&sort=top")));
  bodies.forEach((entries) => entries.slice(1).forEach((e) => add(e.text))); // the first entry is the post itself
  const busy = Date.now() < redditBusyUntil; // a request was refused part-way: don't remember an empty answer
  const value = { items: items.slice(0, 60), threads: threads.map((th) => ({ title: th.title.slice(0, 120), url: th.url })), busy };
  if (!busy) redditCache.set(key, { value, exp: Date.now() + (items.length ? 3600_000 : 600_000) });
  return value;
}

// Returns { views: [{text, likes}], comments: [text] (top 12, for the AI), wiki }.
export async function gatherContext(artist, title) {
  const key = `${artist}|${title}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.exp > Date.now()) return hit.ctx;
  const [views, wiki] = await Promise.all([
    listenerViews(artist, title).catch(() => []),
    wikipediaBackground(artist, title).catch(() => null),
  ]);
  const ctx = { views, comments: views.slice(0, 12).map((v) => v.text), wiki };
  // found something: keep it 6 hours; found nothing: only 10 minutes, so a temporary failure isn't remembered for long
  cache.set(key, { ctx, exp: Date.now() + (views.length || wiki ? 6 * 3600_000 : 10 * 60_000) });
  return ctx;
}
