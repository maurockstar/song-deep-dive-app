// Song Deep Dive — client config
// Fill SPOTIFY_CLIENT_ID from your Spotify Developer dashboard (Step 2 in SETUP.md).
// No client secret is used — we authenticate with PKCE, which is safe for static sites.
window.SDD_CONFIG = {
  // Spotify app "Song Deep Dive" (client ID is public — safe for PKCE in a static site):
  SPOTIFY_CLIENT_ID: "3ca604830a2049e78185f966c87e18ca",

  // Redirect URI must EXACTLY match one registered in the Spotify dashboard.
  // Auto-detects localhost vs production; override if your paths differ.
  REDIRECT_URI: window.location.origin + "/",

  // Read-only scopes: what you're listening to. Nothing that changes your account.
  SCOPES: ["user-read-currently-playing", "user-read-playback-state"],

  // How often (ms) to poll Spotify for the current track.
  POLL_MS: 4000,

  // API base for the deep-dive endpoint (Azure Functions; same origin in SWA).
  API_BASE: "/api",

  // App version — single source of truth, shown in the footer.
  VERSION: "0.7"
};
