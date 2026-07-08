// geeek — client config
// Fill SPOTIFY_CLIENT_ID from your Spotify Developer dashboard (Step 2 in SETUP.md).
// No client secret is used — we authenticate with PKCE, which is safe for static sites.
window.SDD_CONFIG = {
  // Spotify app "geeek" (client ID is public — safe for PKCE in a static site):
  SPOTIFY_CLIENT_ID: "3ca604830a2049e78185f966c87e18ca",

  // Redirect URI must EXACTLY match one registered in the Spotify dashboard.
  // Auto-detects localhost vs production; override if your paths differ.
  REDIRECT_URI: window.location.origin + "/",

  // Scopes: read what you're listening to + control playback (play/pause/skip) from the player,
  // and save/remove tracks to the user's Spotify Liked Songs (the heart button).
  SCOPES: ["user-read-currently-playing", "user-read-playback-state", "user-modify-playback-state", "streaming", "user-library-read", "user-library-modify"],

  // How often (ms) to poll Spotify for the current track.
  POLL_MS: 4000,

  // API base for the deep-dive endpoint (Azure Functions; same origin in SWA).
  API_BASE: "/api",

  // App version — single source of truth (bumping it also invalidates the local card cache).
  // 2.2: removed the artist/album/year credit line under the story dek.
  // 2.3: fixed broken lead photo (Wikipedia /thumb/ filename) + hide media tiles whose image 404s.
  // 2.4: added the "geeek deeper" second-layer story (button + /api/deeper).
  // 2.5: deeper story is complementary to the top story + "Similar songs" (2 real Spotify links).
  // 2.6: single-source Spanish story (render ES from the verified English) + band-composition accuracy guardrails.
  // 2.7: native-Spanish voice (CEdO): warm LatAm es-419 UI strings + stories written natively (not mirrored from English); invalidates local card cache so old robotic-Spanish stories refresh.
  VERSION: "2.7"
};
