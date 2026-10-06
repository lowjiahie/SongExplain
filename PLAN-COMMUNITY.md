# Song Explain — Community Platform Plan (Part B)

Extends [PLAN.md](PLAN.md). Vision: a place where music lovers share what a song's lyrics mean *to them* (life stories, feelings, interpretations), where anyone can browse many different perspectives on the same song, and where brand-new songs the AI doesn't know can be added by users so the AI can still explain them.

## 1. What changes vs. the current prototype
| Today | Community platform |
|---|---|
| Stateless: search → AI explanation | Every song has a **page** (permanent URL) |
| No accounts, no database | Accounts + database (posts, comments, songs) |
| AI view only | **AI view + many human perspectives** side by side |
| Song must exist in iTunes + lyrics.ovh | Users can **add unknown/new songs** and supply lyrics context |
| Nothing to moderate | Needs moderation, reporting, copyright takedown |

## 2. Core concepts
- **Song page** — one page per song: cover, title, artist, AI explanation (per language), and the community feed.
- **Perspective** — a user's post about a song: free text ("this song got me through my dad's illness…"), optional mood tags, optional anchor to a section (e.g. "Verse 2", "Chorus", "line 5" — *by reference, not by copying the lyric*), language, visibility.
- **Reactions** — "this resonates" (one tap), and replies/comments.
- **User-added song** — a song not found by recognition; created by a user with title, artist, language, year, optional links (YouTube etc.) and lyrics (see copyright rules).
- **AI explanation** — generated on demand with the viewer's own key, then saved on the song page so the next visitor doesn't pay again.

## 3. User flows
**A. Browse and share (main loop)**
```
Search / paste YouTube link → pick song → Song page
   ├─ Read AI explanation (choose English / 简体 / 繁體)
   ├─ Read perspectives (sort: top / newest / by mood / by language)
   └─ Log in → write a perspective (anchor to section, add mood tags) → publish
         → others react / reply / report
```

**B. Song not recognized or lyrics not found**
```
Search finds nothing (or lyrics missing)
   → "Add this song" form: title, artist, language, year, link, lyrics
   → Validation + spam check + duplicate check (title+artist)
   → Song page created (status: community-added, unverified)
   → Anyone with an API key clicks "Explain" → AI uses the stored lyrics as private context
   → Explanation saved to the page (labelled with provider/model, language, date)
   → Community perspectives start flowing in
```

**C. Moderation**
```
Report button → queue → admin reviews → hide/remove/ban → author notified
Copyright takedown request → lyrics + dependent content removed quickly
```

## 4. Features
**Phase B1 — Perspectives (MVP of the platform)**
- Login (Google / email magic link), profile with display name (pseudonym allowed)
- Song pages with permanent URLs
- Post / edit / delete own perspective; mood tags; section anchor
- Resonate (like), comment, report
- Sorting + filter by language
- Save the first AI explanation per song+language to the page

**Phase B2 — User-added songs**
- "Add this song" form with duplicate detection
- Private lyrics context (never displayed publicly — see rules)
- "Unverified" badge until confirmed by multiple users or an admin

**Phase B3 — Discovery & quality**
- Home feed: trending songs, recent perspectives, popular moods
- Follow users / songs, notification of replies
- AI "community summary": a one-click summary of how people feel about the song (BYOK, saved to page)
- Quality tools: block/mute, helpful-vote ranking, daily-new-post limits for new accounts

**Later**
- Multi-language UI, collections/playlists with stories, verified artists, cover-art/lyric-card sharing images, licensed lyrics provider.

## 5. Business rules
**Accounts and identity**
1. Reading is public; posting, commenting, reacting and adding songs require login.
2. Display name is a pseudonym by default; real name is never required. Email is never shown.
3. Minimum age 13 (state in Terms); users can delete their account and all their posts.
4. New accounts: limited to 3 posts/day and 1 added song/day until 7 days old (anti-spam).

**Perspectives**
5. Length 20–3,000 characters; plain text + simple formatting only; no images/links in posts for new accounts.
6. A user may post at most one top-level perspective per song (they can edit it); replies are unlimited within rate limits.
7. Users own their posts and can edit/delete anytime; edits are marked "edited".
8. Anchors reference a section ("Chorus", "Verse 2", "Line 5"), not quoted lyrics; quoting is limited to one short line (a few words) per post — enforced by length checks on quoted text.
9. Mood tags come from a fixed list (nostalgic, heartbreak, hopeful, angry, grateful, …) plus up to 3 custom tags.
10. Posts keep their original language; the UI shows a language chip and a language filter. Optional "translate this post" button (BYOK AI, not stored).
11. Personal/sensitive stories (grief, mental health): show a help-resources note when self-harm keywords are present; never auto-delete such posts, but flag them for a human check.

**Songs**
12. A song = unique (normalized title + artist). Catalog songs (iTunes ID) are verified by default; user-added songs are "community-added / unverified".
13. Duplicate detection runs before creation; users are shown existing matches first.
14. Only the song's basic metadata is public (title, artist, year, cover from catalog, external link).

**Lyrics and copyright (highest legal risk)**
15. **Submitted lyrics are never shown publicly.** They are stored privately and only sent to the AI as context when a user requests an explanation. (Showing full lyrics publicly would need a licence.)
16. The submitter confirms in a checkbox that they are allowed to provide the text and understand it is used only for generating an explanation.
17. AI explanations and posts may quote at most a short line; the prompt and a server check enforce this (reject output with long verbatim runs).
18. A copyright/takedown form and contact address are mandatory before public launch; valid requests remove stored lyrics and flagged content within a short, documented time.
19. Prompt-injection safety: lyrics and posts are passed to the AI inside delimited data blocks with an instruction to treat them as data, never as commands.
20. *(Get a lawyer to review Terms, takedown process and the lyrics approach before opening to the public. This plan is not legal advice.)*

**AI explanations**
21. Generated with the requesting user's own key (BYOK); the operator pays nothing.
22. Saved explanation is labelled with provider, model, language, date and "AI interpretation".
23. First saved explanation per song+language is the default; a user may add an alternative from a different model ("another AI's view"), capped at 3 per song+language.
24. Saved explanations are generated server-side from the stored lyrics; users cannot upload arbitrary explanation text as "AI" (prevents fake AI content).
25. If no lyrics are available and the model doesn't know the song, the AI must say so and invite the user to add the song/lyrics.

**Moderation and safety**
26. Every post/comment/song has a Report button; 3 reports from distinct users auto-hide pending review.
27. Prohibited: hate, harassment, doxxing, spam, sexual content involving minors, copyright dumps. Violations → remove; repeat → ban.
28. Appeals: one email appeal per removal.
29. Rate limits on all writes; Cloudflare Turnstile (free) on signup and posting for new accounts.
30. Admin tools: review queue, hide/restore, ban user, edit/merge duplicate songs.

**Privacy**
31. Store only what's needed: email (auth), display name, posts, reactions. No tracking ads.
32. Data export and deletion on request. Privacy policy states that API keys are never stored on the server.

## 6. Architecture (low-cost)
| Layer | Choice | Why / cost |
|---|---|---|
| Database + auth | **Supabase free tier** (Postgres, email/Google login, row-level security) | $0 to start; no custom auth code. Check current limits; free projects can pause after inactivity |
| Frontend | Next.js (or keep static + small JS) on Cloudflare Pages / Vercel free | $0 |
| API logic | Serverless functions (Cloudflare Workers / Vercel) replacing the Node server | $0 within free limits |
| AI | User's key, per request (existing llm.js) | $0 operator |
| Song search | iTunes + MusicBrainz | $0 |
| Images | Only catalog cover URLs; **no user uploads** at first | avoids storage + moderation cost |
| Anti-spam | Cloudflare Turnstile | $0 |
| Email | Supabase built-in (limited) → later Resend/Brevo free tier | $0 |
| Domain | one domain | ≈ $10/yr |

**Data model (sketch)**
- `profiles(id, display_name, created_at, banned)`
- `songs(id, title, artist, album, year, cover_url, catalog_id, status[verified|community|hidden], created_by)`
- `song_lyrics_private(song_id, lyrics, submitted_by, consent_at)` — *no public read access*
- `explanations(id, song_id, language, provider, model, body, created_by, created_at)`
- `perspectives(id, song_id, user_id, body, language, anchor, moods[], status, created_at, edited_at)`
- `comments(id, perspective_id, user_id, body, status)`
- `reactions(user_id, perspective_id)`
- `reports(id, target_type, target_id, reporter_id, reason, status)`

## 7. Budget
- **Build/launch (operator): about $0–10/month** (free tiers + domain).
- **When it grows:** Supabase paid plan is around $25/month (check current pricing) once database size or users exceed the free tier; hosting/CDN usually still free until significant traffic.
- **AI cost: $0 to operator** (BYOK). Optional paid features later (e.g. AI moderation, community-summary on the house) are the only things that would create an AI bill; skip until there is demand.
- **Real hidden cost: moderation time.** Mitigate with report-based moderation, new-account limits, fixed tags, no images/links, and recruiting trusted volunteer moderators.

## 8. Build order
1. **B1 (≈ 2–3 weeks):** Supabase setup, login, song pages, perspectives (post/react/comment/report), save AI explanation to page.
2. **B2 (≈ 1–2 weeks):** add-song form, private lyrics, duplicate check, unverified badge, takedown form.
3. **B3:** home feed, follow/notifications, community summary, moderation dashboard.
4. Launch small (invite-only / one language community first) to learn moderation load before opening wide.

## 9. Risks
| Risk | Mitigation |
|---|---|
| Copyright claims over user-submitted lyrics | Private lyrics, never displayed, takedown process, legal review (rules 15–20) |
| Spam / abuse / harmful content | Login, rate limits, Turnstile, report auto-hide, admin queue |
| Emotional/sensitive posts (grief, self-harm) | Resource note, human review of flagged posts, clear guidelines |
| Cold-start: empty song pages | Seed with AI explanations; start with a few popular songs and a small invited group |
| Fake/low-quality AI content | Server-generated explanations only, labelled with model |
| Free-tier limits / pausing | Monitor; budget the $25/mo upgrade; keep export scripts |
| BYOK friction for explanations | Saved explanations shared across visitors, so most readers never need a key |

## 10. Decisions needed
1. **Lyrics policy:** keep submitted lyrics private (recommended) vs. show them publicly (needs a licence — not recommended).
2. **Posting identity:** pseudonymous login only (recommended) vs. allow anonymous posts without login (more spam).
3. **Backend:** adopt Supabase (recommended, fastest + cheapest) vs. self-host Postgres.
4. **Launch scope:** English + Chinese from day one, or start with one language community?
5. **Moderation:** who reviews reports at launch (you alone, or invited volunteers)?
