# Song Deep Dive

The fun learning layer for music. While a song plays, get the story behind it, the people who made it, and how it connects to everything else — as glanceable cards that go deeper on tap.

**Mission:** help people fall deeper in love with the music they hear, add a little joy and curiosity — then send them back out to *live*. Human-first, wellbeing-first, built to adapt. (Full north star: `../Mission & Vision.md`.)

**Status:** Phase 1 — the **Family Beta** (runnable scaffold; first testers are Mauricio + Maite, Lucas, Diego, Dagum, Pipe). Real knowledge pipeline arrives in Phase 2.

## What's here

```
app/
├── SETUP.md                    # ← start here: create accounts & deploy (free tier)
├── src/                        # static front-end (Azure Static Web Apps)
│   ├── index.html              # app shell
│   ├── styles.css              # theme
│   ├── config.js               # paste your Spotify Client ID here
│   ├── spotify.js              # Spotify OAuth (PKCE) + player abstraction
│   └── app.js                  # UI wiring, polling, deep-dive fetch, manual search
├── api/                        # Azure Functions (serverless API)
│   └── deepdive/               # GET /api/deepdive — returns a song deep-dive (Phase 1 stub)
├── staticwebapp.config.json    # routing/security for Static Web Apps
└── .github/workflows/          # CI/CD to Azure on push
```

## Architecture (Phase 1)

- **Front-end:** plain HTML/CSS/JS — no build step, hosts on Azure Static Web Apps free tier.
- **Player abstraction:** `src/spotify.js` exposes `getCurrentTrack()`; Spotify is the active adapter. A YouTube adapter can be dropped in later without touching the UI.
- **API:** one Azure Function (`/api/deepdive`) returns the deep-dive payload. The `cards` contract is fixed; Phase 2 swaps the stub for open-data + AI + caching behind it.
- **Cost:** nothing at this stage — all free tiers, serverless scales to zero.

## Run locally

```bash
npm install -g @azure/static-web-apps-cli
cd app
swa start src --api-location api
# http://localhost:4280
```

Add your Spotify **Client ID** to `src/config.js` first (see `SETUP.md`).

## Deploy

Push to GitHub and link the repo to an Azure Static Web App (Free plan). See `SETUP.md` for the click-by-click.

## Roadmap & control

The phased roadmap and approvals live in the **Mission Control** dashboard (in the project folder / Cowork sidebar). Approve the next phase there, or just say `approve phase 2` in chat.
