# Song Deep Dive — Setup Guide (Phase 1: Foundations)

This guide gets the foundation running on **100% free tiers**. You create three accounts; the repo scaffold (already in this folder) handles the code. Estimated time: ~30–40 minutes.

> You only need to do the **account** steps yourself — everything in `src/` and `api/` is already scaffolded. Where you see `TODO`, that's a value you paste from a step below.

---

## Step 1 — GitHub (source control + auto-deploy)

1. Create a free account at https://github.com (skip if you have one).
2. Create a new **empty** repository named `song-deep-dive` (Private is fine).
3. From this `app/` folder, push the scaffold:
   ```bash
   cd app
   git init
   git add .
   git commit -m "Phase 1: foundation scaffold"
   git branch -M main
   git remote add origin https://github.com/<your-username>/song-deep-dive.git
   git push -u origin main
   ```

---

## Step 2 — Spotify Developer app (the player)

1. Go to https://developer.spotify.com/dashboard and log in with your Spotify account.
2. Click **Create app**. Use:
   - **App name:** Song Deep Dive
   - **Redirect URIs:** add **both**:
     - `http://localhost:4280/` (local dev)
     - `https://<your-site-name>.azurestaticapps.net/` (fill in after Step 3)
   - **APIs used:** Web API
3. Save. Copy your **Client ID** (no client secret is needed — we use PKCE).
4. Paste the Client ID into `src/config.js` → `SPOTIFY_CLIENT_ID`.
5. **Invite the Family Beta.** In the app's **Settings → User Management**, add your testers by the email on their Spotify account:
   - Mauricio (you, #1) · Maite · Lucas · Diego · Dagum · Pipe

> **This is by design, not a limit.** A new Spotify app runs in *development mode*, which allows a small set of named testers — a perfect fit for our **Family Beta**. Public scale would later need Spotify's *extended access* (a separate, gated step you approve). For now, the family is all we need.

**Scopes we request:** `user-read-currently-playing`, `user-read-playback-state` (read what you're listening to). Nothing that modifies your account.

---

## Step 3 — Azure (free hosting)

1. Create a free account at https://azure.microsoft.com/free (the free tier we use costs nothing).
2. In the Azure Portal, create a resource → **Static Web App**:
   - **Plan type:** **Free**
   - **Source:** GitHub → authorize → pick your `song-deep-dive` repo, branch `main`
   - **Build presets:** Custom →
     - **App location:** `/src`
     - **Api location:** `/api`
     - **Output location:** *(leave blank)*
3. Create. Azure adds a deploy workflow and gives you a URL like `https://<name>.azurestaticapps.net`.
4. Go back to **Step 2** and add that URL to your Spotify Redirect URIs, and set it as `REDIRECT_URI` in `src/config.js` for production.

> A `.github/workflows/...` file is already included so CI/CD works on push. If Azure also adds one, keep Azure's and delete the placeholder — I'll help reconcile.

---

## Step 4 — Run it locally (optional but recommended)

```bash
npm install -g @azure/static-web-apps-cli
cd app
swa start src --api-location api
# open http://localhost:4280
```

Click **Connect Spotify**, approve, play a song in Spotify, and the now-playing bar should populate. The deep-dive cards are served by the API stub for now (real content lands in Phase 2).

---

## What "done" looks like for Phase 1 (the Family Beta)

- [ ] GitHub repo created and scaffold pushed
- [ ] Spotify app created; Client ID in `config.js`; redirect URIs set
- [ ] Family added as test users (Maite, Lucas, Diego, Dagum, Pipe)
- [ ] Azure Static Web App deployed; site loads at its URL
- [ ] "Connect Spotify" works and the now-playing bar shows your current track

When those are ticked, type **`approve phase 2`** in chat (or use the dashboard) and we build the real knowledge pipeline. Ping me at any step — say `change phase 1: ...` or just ask. Remember the north star: this should be fun, and it should make life feel a little better.
