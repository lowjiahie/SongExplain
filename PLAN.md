# Song Explain — Plan, Flow, Rules, Budget

## 0. Decisions (confirmed)
- **Audience / languages:** English and Chinese (English, 简体中文, 繁體中文).
- **Pricing:** free for everyone.
- **AI cost model:** bring-your-own-key (BYOK). Every user supplies their own Anthropic API key and pays their own usage. The operator pays **no AI cost**.
- **Provider-agnostic:** users can use any AI platform — Anthropic, OpenAI, Gemini, DeepSeek, Qwen, Groq, OpenRouter, or any custom OpenAI-compatible endpoint (llm.js).
- **Hosting:** undecided — the app is a tiny stateless Node service, so any free tier works. Decide later.

> **Community platform (shared perspectives, user-added songs):** see [PLAN-COMMUNITY.md](PLAN-COMMUNITY.md).

> **Stage 1 (current): personal use.** Single user, no login, local SQLite (data/songexplain.db), server bound to localhost, lyrics private. Public/community stage comes later.

## 1. Goal
User pastes a YouTube link or types a song name → system recognizes the song → user confirms from candidates → AI explains the lyrics in depth, in the user's chosen language.

## 2. User flow
```
Input (YouTube link | song name)
   │
   ├─ link?  → YouTube oEmbed → raw title + channel
   │
   ▼
Clean & guess (rules first, AI only if needed)
   │
   ▼
Search catalog (iTunes API; MusicBrainz as fallback) → up to 8 candidates
   │
   ▼
User selects the right song  (or "none of these" → refine query / paste lyrics)
   │
   ▼
Choose explanation language
   │
   ▼
Cache lookup (song_id + language + prompt_version)
   ├─ hit  → return instantly (cost $0)
   └─ miss → get lyrics (provider → user paste) → AI explain (streamed) → save to cache
   │
   ▼
Show explanation (sections, copy/share, regenerate in another language)
```

## 3. Features
**MVP (build first)**
- Input box accepting YouTube URL (youtube.com, youtu.be, music.youtube.com) or free text
- Song recognition + candidate list with cover, artist, year
- Language selector: English, 简体中文, 繁體中文 (easy to extend)
- Streamed AI explanation: overview, section-by-section, deeper interpretation, takeaway
- Optional "paste your own lyrics" for missing or wrong lyrics
- BYOK: user enters their own API key (stored only in their browser, sent per request, never saved server-side)
- Per-browser result cache (saves the user's own money on repeats)
- Light abuse protection on the free proxy endpoints (no spend cap needed)

**Phase 2**
- Explanation history (browser localStorage first, accounts later)
- Share link for an explanation
- Translate-only mode (reuse an existing explanation instead of regenerating)
- Depth levels: Quick (short) / Detailed
- Feedback button (👍/👎, "wrong song") to improve prompts

**Phase 3 (only if there is traction)**
- Accounts + free quota / paid plan
- Audio-based recognition (humming / clip) — costly, defer
- Spotify / Apple Music link support

## 4. Business rules
**Input**
1. Max input length 300 chars; strip tracking params from URLs.
2. Only YouTube hosts are accepted as links; other URLs are rejected with a clear message.
3. Playlists / channels / non-music videos: use the single video's title; if no candidate matches, ask the user to type the song name.

**Recognition**
4. Rule-based cleanup first (remove "Official MV", "Lyrics", "4K", brackets). Call AI only when the catalog search returns no confident match.
5. Always show candidates; never auto-pick when confidence is low. The user always confirms, unless there is exactly one strong match.
6. Show a maximum of 8 candidates; dedupe remasters/live versions of the same title+artist.

**Lyrics and copyright**
7. Lyrics are used only as private context for the AI; they are not displayed or stored in our database.
8. The explanation must not reproduce full lyrics — quote at most short lines (a line or less) per point.
9. If lyrics cannot be found, the AI must say so and explain only what it reliably knows; no fabricated lines or facts.
10. User-pasted lyrics are used for that request only and not saved.
11. Takedown contact on the site; honor removal requests for cached explanations.

**Explanation quality**
12. Output language = user's selection; song and artist names stay in the original script.
13. Interpretations are labeled as the AI's view; facts about artist intent are hedged unless well known.
14. Fixed structure (overview → sections → interpretation → takeaway) via one versioned prompt.
15. Explicit content is explained neutrally and factually (no refusal for mature themes, no gratuitous detail).

**Caching (per user, in the browser)**
16. Cache key = `song + artist + language`. Re-opening the same song/language is instant and costs the user nothing.
17. Pasted-lyrics requests are not cached.
18. "Regenerate" bypasses the cache and is paid by the user.

**BYOK and cost control**
19. No API key → explanation is blocked with a clear "enter your key" message; recognition still works without AI.
20. Keys live only in the user's browser (localStorage) and travel in a request header over HTTPS; the server never logs or stores them.
21. Recognition is rule-based first; AI is used only as a fallback when the catalog search finds nothing (uses the user's key).
22. Max output tokens and lyrics length are capped so one request can't surprise the user with a large bill. Show an approximate cost note ("about 1–3 US cents per explanation").
22a. Bad / rejected / out-of-credit keys show a friendly error, never a stack trace.

**Privacy**
23. No account required for MVP. Log only song id, language, and timing; no personal data.
24. User API keys are never persisted on the server; the operator has no key of their own in production.

## 5. Architecture (cheapest viable)
| Part | Choice | Cost |
|---|---|---|
| Frontend | Static HTML/JS (current) or Next.js later | Free |
| Backend | One Node/Express service (current); deploy on Cloudflare Workers / Render / Fly free tier | $0–5/mo |
| Song search | iTunes Search API (no key); MusicBrainz fallback | Free |
| YouTube title | oEmbed (no key, no quota) — avoids YouTube Data API | Free |
| Lyrics | lyrics.ovh (free, unreliable) + user paste | Free |
| AI | Claude via the **user's own key** | $0 to operator |
| Cache | Browser localStorage (no database needed) | Free |
| Abuse protection | Simple per-IP limit on the proxy endpoints (in-memory) | Free |
| Domain | Optional | ~$10/yr |

## 6. Budget
**Operator: about $0/month.** Everything runs on free tiers (iTunes search, YouTube oEmbed, lyrics.ovh, static page + one tiny Node service). Optional: domain ≈ $10/year.

**Users pay their own AI usage.** Rough estimate (check current Anthropic pricing): one detailed explanation is about 3,000 input + 1,500 output tokens, i.e. roughly **$0.03 on a Sonnet-class model, ~$0.01 on a Haiku-class model**; cache hits cost $0. So 100 explanations ≈ $1–3 for the user.

**What this means**
- No spend cap, billing, or quota system needed. This removes the biggest cost and the biggest build item.
- Friction: users need an API key. Mitigate with a clear one-minute "how to get a key" guide and a note that the key never leaves their browser except to call the API.
- Risk to manage: because the key passes through our server to Anthropic, keep the proxy stateless, log nothing sensitive, and use HTTPS. (If you want zero key exposure to the server, a later option is calling Anthropic directly from the browser.)
- Growth option later: if free-with-own-key limits adoption, add an optional hosted "we pay" tier — but that is not needed now.

## 7. Build phases
1. **Done (prototype):** recognition, candidates, language choice, streamed explanation.
2. **Week 1 (done in code):** BYOK key input, URL validation, rule-based cleanup, US+TW catalog search (English + Chinese), browser cache, friendly key/credit errors.
   **Remaining:** per-IP limit on proxy endpoints, "how to get a key" guide, Quick/Detailed toggle.
3. **Week 2:** history (localStorage), Quick/Detailed modes, feedback button, deploy, takedown/contact page.
4. **Later:** accounts, share links, paid tier, pre-generation of popular songs.

## 8. Risks
| Risk | Mitigation |
|---|---|
| Free lyrics API is unreliable or disappears | User paste; swap provider (e.g. licensed API if the product grows) |
| Copyright complaints | Rules 7–11; no lyrics displayed or stored |
| Wrong song identified | Mandatory candidate confirmation; "wrong song" feedback |
| Cost spike from abuse | Rules 19–22 |
| AI hallucinating meanings | Rules 9, 13; label as interpretation |
| iTunes API weak for obscure/non-English songs | MusicBrainz fallback; manual title/artist entry |

## 9. Open decisions
1. Hosting provider (decide later) — any of Cloudflare / Render / Fly / VPS works.
2. Whether to later offer a "we pay" tier for users without a key.
3. Whether to call Anthropic directly from the browser (no key ever touches our server) instead of proxying.
