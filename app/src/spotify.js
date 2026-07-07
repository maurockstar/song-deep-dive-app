// geeek — Spotify auth (PKCE) + player abstraction
// PKCE = Proof Key for Code Exchange: secure OAuth for static apps with no secret.
(function () {
  "use strict";
  var CFG = window.SDD_CONFIG;
  var AUTH = "https://accounts.spotify.com/authorize";
  var TOKEN = "https://accounts.spotify.com/api/token";
  var API = "https://api.spotify.com/v1";
  var LS = "sdd_spotify_tokens";

  // ---------- PKCE helpers ----------
  function randString(len) {
    var arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return Array.from(arr, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }
  function base64url(buf) {
    return btoa(String.fromCharCode.apply(null, new Uint8Array(buf)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  async function challenge(verifier) {
    var data = new TextEncoder().encode(verifier);
    var digest = await crypto.subtle.digest("SHA-256", data);
    return base64url(digest);
  }

  // ---------- token storage ----------
  function saveTokens(t) {
    t.expires_at = Date.now() + (t.expires_in || 3600) * 1000 - 30000; // 30s safety margin
    localStorage.setItem(LS, JSON.stringify(t));
  }
  function readTokens() {
    try { return JSON.parse(localStorage.getItem(LS) || "null"); } catch (e) { return null; }
  }
  function clearTokens() { localStorage.removeItem(LS); }

  // ---------- auth flow ----------
  async function login() {
    if (!CFG.SPOTIFY_CLIENT_ID || CFG.SPOTIFY_CLIENT_ID.indexOf("PASTE") === 0) {
      alert("Add your Spotify Client ID in config.js first (see SETUP.md).");
      return;
    }
    var verifier = randString(64);
    sessionStorage.setItem("sdd_pkce_verifier", verifier);
    var params = new URLSearchParams({
      client_id: CFG.SPOTIFY_CLIENT_ID,
      response_type: "code",
      redirect_uri: CFG.REDIRECT_URI,
      code_challenge_method: "S256",
      code_challenge: await challenge(verifier),
      scope: CFG.SCOPES.join(" ")
    });
    window.location = AUTH + "?" + params.toString();
  }

  // Call on page load: completes the redirect if ?code= is present.
  async function handleRedirect() {
    var p = new URLSearchParams(window.location.search);
    var code = p.get("code");
    if (!code) return false;
    var verifier = sessionStorage.getItem("sdd_pkce_verifier");
    var body = new URLSearchParams({
      client_id: CFG.SPOTIFY_CLIENT_ID,
      grant_type: "authorization_code",
      code: code,
      redirect_uri: CFG.REDIRECT_URI,
      code_verifier: verifier || ""
    });
    var res = await fetch(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body });
    if (!res.ok) { console.error("token exchange failed", await res.text()); return false; }
    saveTokens(await res.json());
    sessionStorage.removeItem("sdd_pkce_verifier");
    history.replaceState({}, document.title, CFG.REDIRECT_URI); // clean ?code= from URL
    return true;
  }

  async function refresh() {
    var t = readTokens();
    if (!t || !t.refresh_token) return null;
    var body = new URLSearchParams({
      client_id: CFG.SPOTIFY_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: t.refresh_token
    });
    var res = await fetch(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body });
    if (!res.ok) { clearTokens(); return null; }
    var nt = await res.json();
    if (!nt.refresh_token) nt.refresh_token = t.refresh_token; // Spotify may omit on refresh
    saveTokens(nt);
    return nt.access_token;
  }

  async function getAccessToken() {
    var t = readTokens();
    if (!t) return null;
    if (Date.now() >= t.expires_at) return await refresh();
    return t.access_token;
  }

  function isConnected() { return !!readTokens(); }
  function logout() { clearTokens(); }

  // Resolve a "title / artist" to a real Spotify link the user can open in the Spotify app.
  // Uses Spotify Search (still supported; unlike the deprecated /recommendations). Falls back to a
  // Spotify search URL when the user isn't connected or no exact track is found — still opens the app.
  async function searchTrackUrl(title, artist) {
    var human = ((title || "") + (artist ? " " + artist : "")).trim();
    var fallback = "https://open.spotify.com/search/" + encodeURIComponent(human);
    try {
      var token = await getAccessToken();
      if (!token) return fallback;
      var q = 'track:"' + (title || "") + '"' + (artist ? ' artist:"' + artist + '"' : "");
      var res = await fetch(API + "/search?type=track&limit=1&q=" + encodeURIComponent(q), { headers: { Authorization: "Bearer " + token } });
      if (!res.ok) return fallback;
      var d = await res.json();
      var t = d && d.tracks && d.tracks.items && d.tracks.items[0];
      return (t && t.external_urls && t.external_urls.spotify) ? t.external_urls.spotify : fallback;
    } catch (e) { return fallback; }
  }

  // ---------- Spotify player adapter (implements the abstraction) ----------
  var spotifyPlayer = {
    name: "spotify",
    async getCurrentTrack() {
      var token = await getAccessToken();
      if (!token) return null;
      // /me/player (not /currently-playing) so we also get shuffle_state + repeat_state to mirror in the UI.
      var res = await fetch(API + "/me/player", { headers: { Authorization: "Bearer " + token } });
      if (res.status === 204 || res.status === 202) return null; // no active device
      if (!res.ok) { console.warn("player", res.status); return null; }
      var d = await res.json();
      if (!d || !d.item) return null;
      var it = d.item;
      // Keep the local shuffle/repeat mirrors honest so the next in-app toggle/cycle starts from reality.
      shuffleOn = !!d.shuffle_state;
      var ri = repeatModes.indexOf(d.repeat_state); if (ri >= 0) repeatIdx = ri;
      return {
        id: it.id,
        title: it.name,
        artist: (it.artists || []).map(function (a) { return a.name; }).join(", "),
        album: it.album ? it.album.name : "",
        albumYear: (it.album && it.album.release_date) ? String(it.album.release_date).slice(0, 4) : "",
        art: it.album && it.album.images && it.album.images[0] ? it.album.images[0].url : "",
        isPlaying: !!d.is_playing,
        progressMs: d.progress_ms || 0,
        durationMs: it.duration_ms || 0,
        shuffle: !!d.shuffle_state,
        repeat: d.repeat_state || "off",
        source: "spotify"
      };
    }
  };

  // ---------- transport control (best-effort; needs the user-modify-playback-state scope) ----------
  async function control(method, path) {
    var token = await getAccessToken();
    if (!token) return false;
    try {
      var res = await fetch(API + path, { method: method, headers: { Authorization: "Bearer " + token } });
      return res.ok || res.status === 204;
    } catch (e) { return false; }
  }
  // Local mirrors of shuffle/repeat so the UI can toggle/cycle without a state read.
  // Spotify repeat cycles: off -> context -> track -> off.
  var shuffleOn = false;
  var repeatModes = ["off", "context", "track"];
  var repeatIdx = 0;
  var playerControl = {
    play: function () { return control("PUT", "/me/player/play"); },
    pause: function () { return control("PUT", "/me/player/pause"); },
    next: function () { return control("POST", "/me/player/next"); },
    prev: function () { return control("POST", "/me/player/previous"); },
    // Returns { ok, state } so the UI can reflect the new value, or { ok:false } if it failed.
    toggleShuffle: async function () {
      var want = !shuffleOn;
      var ok = await control("PUT", "/me/player/shuffle?state=" + (want ? "true" : "false"));
      if (ok) shuffleOn = want;
      return { ok: ok, state: shuffleOn };
    },
    cycleRepeat: async function () {
      var nextIdx = (repeatIdx + 1) % repeatModes.length;
      var mode = repeatModes[nextIdx];
      var ok = await control("PUT", "/me/player/repeat?state=" + mode);
      if (ok) repeatIdx = nextIdx;
      return { ok: ok, state: repeatModes[repeatIdx] };
    }
  };

  // ---------- player abstraction registry ----------
  // The app polls the ACTIVE player. Swapping in a YouTube adapter later means
  // implementing { name, getCurrentTrack() } and calling setActivePlayer(it).
  var activePlayer = spotifyPlayer;
  function setActivePlayer(p) { activePlayer = p; }
  function getActivePlayer() { return activePlayer; }

  // ---------- add a track to the Spotify QUEUE (insert-next; never resets the user's queue) ----------
  // Resolve the recommended title/artist to a real track, then POST it to the play queue so it plays after
  // the current song WITHOUT clearing what the user already had lined up. Needs the user-modify-playback-state
  // scope + an active device. Returns { ok, name, url, reason } so the UI can confirm or fall back to opening.
  async function searchTrack(title, artist) {
    var token = await getAccessToken();
    if (!token) return null;
    var q = 'track:"' + (title || "") + '"' + (artist ? ' artist:"' + artist + '"' : "");
    try {
      var res = await fetch(API + "/search?type=track&limit=1&q=" + encodeURIComponent(q), { headers: { Authorization: "Bearer " + token } });
      if (!res.ok) return null;
      var d = await res.json();
      return (d && d.tracks && d.tracks.items && d.tracks.items[0]) || null;
    } catch (e) { return null; }
  }
  async function queueTrack(title, artist) {
    var token = await getAccessToken();
    if (!token) return { ok: false, reason: "no-auth" };
    var t = await searchTrack(title, artist);
    if (!t || !t.uri) return { ok: false, reason: "not-found" };
    var url = (t.external_urls && t.external_urls.spotify) || null;
    try {
      var res = await fetch(API + "/me/player/queue?uri=" + encodeURIComponent(t.uri), { method: "POST", headers: { Authorization: "Bearer " + token } });
      if (res.ok || res.status === 204) return { ok: true, name: t.name, url: url };
      if (res.status === 404) return { ok: false, reason: "no-device", name: t.name, url: url }; // nothing playing to queue onto
      return { ok: false, reason: "http-" + res.status, name: t.name, url: url };
    } catch (e) { return { ok: false, reason: "network", name: t.name, url: url }; }
  }

  // Normalize a title/artist for matching: lowercase, strip accents, drop parenthetical/bracket suffixes
  // ("(feat...)", "[Live]"), drop "- Remastered 2011"/"- Live" tails, collapse to words.
  function normName(x) {
    return String(x || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
      .replace(/\s[-–]\s.*$/, " ")
      .replace(/\bfeat\.?\b.*$/, " ").replace(/\bft\.?\b.*$/, " ")
      .replace(/[^a-z0-9]+/g, " ").trim();
  }
  // Resolve a recommended title/artist to a REAL Spotify track, but only return it on a confident EXACT
  // match (title matches AND one of the track's artists matches). Returns { uri, url, name, artist } or null,
  // so the app can show a recommendation ONLY when it is actually playable/queueable (no dead links -> no churn).
  async function resolveTrack(title, artist) {
    var token = await getAccessToken();
    if (!token) return null;
    var q = 'track:"' + (title || "") + '"' + (artist ? ' artist:"' + artist + '"' : "");
    try {
      var res = await fetch(API + "/search?type=track&limit=5&q=" + encodeURIComponent(q), { headers: { Authorization: "Bearer " + token } });
      if (!res.ok) return null;
      var d = await res.json();
      var items = (d.tracks && d.tracks.items) || [];
      var wantT = normName(title), wantA = normName(artist);
      for (var i = 0; i < items.length; i++) {
        var t = items[i];
        var gotT = normName(t.name);
        var arts = (t.artists || []).map(function (a) { return normName(a.name); });
        var titleOk = !!wantT && (gotT === wantT || (gotT && (gotT.indexOf(wantT) === 0 || wantT.indexOf(gotT) === 0)));
        var artistOk = !wantA || arts.some(function (a) { return a && (a === wantA || a.indexOf(wantA) > -1 || wantA.indexOf(a) > -1); });
        if (titleOk && artistOk) {
          return { uri: t.uri, url: (t.external_urls && t.external_urls.spotify) || null, name: t.name, artist: (t.artists || []).map(function (a) { return a.name; }).join(", ") };
        }
      }
      return null;
    } catch (e) { return null; }
  }
  // Queue an EXACT, already-resolved track URI (plays next, never resets the queue).
  async function queueUri(uri) {
    var token = await getAccessToken();
    if (!token) return { ok: false, reason: "no-auth" };
    try {
      var res = await fetch(API + "/me/player/queue?uri=" + encodeURIComponent(uri), { method: "POST", headers: { Authorization: "Bearer " + token } });
      if (res.ok || res.status === 204) return { ok: true };
      if (res.status === 404) return { ok: false, reason: "no-device" };
      return { ok: false, reason: "http-" + res.status };
    } catch (e) { return { ok: false, reason: "network" }; }
  }

  window.SDD = window.SDD || {};
  window.SDD.spotify = { login: login, handleRedirect: handleRedirect, getAccessToken: getAccessToken, isConnected: isConnected, logout: logout, searchTrackUrl: searchTrackUrl, queueTrack: queueTrack, resolveTrack: resolveTrack, queueUri: queueUri };
  window.SDD.player = { spotify: spotifyPlayer, setActivePlayer: setActivePlayer, getActivePlayer: getActivePlayer, control: playerControl };
})();
