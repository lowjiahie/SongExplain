# Song Explain

Find a song, get an AI explanation of what it means, and write down what it means to *you*. Share songs and feelings with other members, or keep everything private.

Free and bring-your-own-key: every person connects their own AI account, so the operator pays no AI cost.

## What it does

- **Find a song** — type a title and artist, or paste a YouTube link. Candidates come from the music catalogue; pick the right one.
- **Explain** — an AI writes a deeper reading of the song in English, 简体中文 or 繁體中文, using lyrics and what listeners say online.
- **Your feelings** — pick feeling words, write a few lines, and turn them into a card (15+ designs). Private by default.
  - **✨ Polish with AI** — suggests a nicer wording as a preview. Nothing changes until you tap *Use this*, and you can always restore your original.
  - **♪ Add a lyric line** — pick lines from the lyrics you saved and drop them into your note.
- **Shared** — every song members shared, one card per song (the same song is merged), with who shared it and, if they chose, why. You can share just the song and keep your feelings private.
- **Journal** — everything you wrote, searchable by song, word or feeling.
- **Listen** — jump to YouTube Music, Spotify, Apple Music and others, or play a 30-second preview.
- **Lyric cards** — turn a few lines or your own words into an image to share.
- **What's new** — a one-time popup that points to new features after an update.

## Quick start

Requires Node.js 22 or newer (it uses the built-in SQLite).

```bash
npm install
npm start          # http://localhost:3456
```

Open the page and register. The first account inherits any songs saved before accounts existed. Then open **AI settings**, pick a provider, paste your key and press *Test & connect*.

Copy `.env.example` to `.env` to change settings. See [DEPLOY.md](DEPLOY.md) for hosting and multi-user setup.

## AI providers

Anthropic (Claude), OpenAI, Google Gemini, DeepSeek, Alibaba Qwen, Groq, OpenRouter, or any custom OpenAI-compatible URL. Keys are either kept only in the open tab (default) or saved encrypted on the server; they are never stored in the browser.

## Privacy and safety

- Lyrics stay private to the account that saved them and are only used as context for the AI. They are never shown to other people.
- Feelings are private unless you tick *Share*. Shared feelings use only a display name, never an email.
- Links and long quotes of lyrics are not allowed in shared feelings. Members can report posts; moderators (`ADMIN_EMAILS`) can hide them.
- Polishing sends only your note, the song title and artist to the AI you connected.

## Project layout

| Path | What it is |
|---|---|
| `server.js` | Express server and API routes |
| `db.js` | SQLite schema and queries |
| `auth.js`, `secrets.js` | Accounts, sessions, rate limits, key encryption |
| `llm.js`, `connections.js` | AI providers and per-user connections |
| `search.js`, `lyrics.js`, `context.js` | Song search, lyrics lookup, listener comments |
| `public/` | The single-page front end (`index.html`, `app.js`) |

More background: [PLAN.md](PLAN.md) (product plan) and [PLAN-COMMUNITY.md](PLAN-COMMUNITY.md) (community rules).

## License

[MIT](LICENSE)
