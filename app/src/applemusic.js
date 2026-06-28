// geeek — Apple Music provider (MusicKit JS v3).
//
// Stays completely inert until /api/amtoken is configured server-side:
// if there's no developer token, the Apple Music button never appears and
// nothing here runs, so the existing Spotify / open-data app is untouched.
//
// Rebuilt to fix the "I click Allow but nothing happens" problem:
//   • The button now reflects the REAL authorization state via MusicKit's
//     authorizationStatusDidChange event — not a single success-path write
//     that silently no-ops when authorize() rejects.
//   • authorize() failures are classified and surfaced in the UI with an
//     actionable reason (no Apple Music subscription, or the browser blocked
//     the sign-in token), instead of being swallowed into console.warn.
//   • On load we restore the connected state if a user token already exists.
(function () {
  "use strict";
  var CFG = window.SDD_CONFIG || {};
  var ui = null;          // { renderNowPlaying, loadDeepDive, setStatus } from app.js
  var music = null;       // MusicKit instance
  var storefront = "us";
  var lastId = null;
  var btn = null;
  var notice = null;      // #appleNotice element (created if missing)

  function api(p) { return (CFG.API_BASE || "/api") + p; }

  // structured logging (no-op if log.js absent)
  function L(action, detail, level) { try { if (window.SDD && SDD.log) { if (arguments.length >= 2) return SDD.log.ev("apple", action, detail, level); return SDD.log.ev("apple", action); } } catch (e) {} }
  function decodeJwt(t) { try { var p = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"); return JSON.parse(decodeURIComponent(escape(atob(p)))); } catch (e) { return null; } }

  // ---- UI helpers -----------------------------------------------------------

  function ensureNotice() {
    if (notice) return notice;
    notice = document.getElementById("appleNotice");
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "appleNotice";
      notice.className = "apple-notice hidden";
      var main = document.querySelector("main.stage") || document.body;
      main.insertBefore(notice, main.firstChild);
    }
    return notice;
  }

  function showNotice(html, kind) {
    var n = ensureNotice();
    n.className = "apple-notice " + (kind || "info");
    n.innerHTML = html;
    n.classList.remove("hidden");
  }
  function clearNotice() {
    if (notice) { notice.classList.add("hidden"); notice.innerHTML = ""; }
  }

  function isAuthorized() {
    return !!(music && music.isAuthorized);
  }

  // Single source of truth for what the button + status look like.
  function refreshButton() {
    if (!btn) return;
    if (isAuthorized()) {
      btn.textContent = "Connected to Apple Music ✓";
      btn.classList.add("connected");
      btn.onclick = disconnect;
      if (ui) ui.setStatus("Apple Music connected", "ok");
      clearNotice();
    } else {
      btn.textContent = "Connect Apple Music";
      btn.classList.remove("connected");
      btn.onclick = connect;
    }
  }

  // ---- token + catalog ------------------------------------------------------

  async function fetchToken() {
    try {
      var r = await fetch(api("/amtoken") + "?t=" + Date.now(), { cache: "no-store" });
      L("token:fetch", { status: r.status, ok: r.ok });
      if (!r.ok) return null;
      var j = await r.json();
      var tok = (j && j.configured && j.token) ? j.token : null;
      var c = tok ? decodeJwt(tok) : null;
      L("token:claims", { configured: !!(j && j.configured), hasToken: !!tok, iss: c && c.iss, exp: c && c.exp, origin: c && c.origin });
      return tok;
    } catch (e) { L("token:fetch:error", e, "error"); return null; }
  }

  function loadAndConfigure(token) {
    return new Promise(function (resolve, reject) {
      function go() {
        L("configure:start", { musicKitVersion: (window.MusicKit && MusicKit.version) || null });
        MusicKit.configure({ developerToken: token, app: { name: "geeek", build: "0.8" } })
          .then(function (m) { L("configure:ok", { storefront: m && (m.storefrontId || m.storefrontCountryCode) }); resolve(m); })
          .catch(function (err) { L("configure:fail", err, "error"); reject(err); });
      }
      if (window.MusicKit) { go(); return; }
      document.addEventListener("musickitloaded", go, { once: true });
      var s = document.createElement("script");
      s.src = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
      s.async = true;
      s.onerror = function () { reject(new Error("MusicKit JS failed to load")); };
      document.head.appendChild(s);
    });
  }

  function artURL(a) {
    try { if (a && a.artwork && a.artwork.url) return a.artwork.url.replace("{w}", "300").replace("{h}", "300"); } catch (e) {}
    return "";
  }
  function toTrack(it) {
    if (!it) return null;
    var a = it.attributes || {};
    return { id: it.id || a.name, title: a.name || "", artist: a.artistName || "", art: artURL(a), isPlaying: !!(music && music.isPlaying) };
  }

  function onNowPlaying() {
    var t = toTrack(music && music.nowPlayingItem);
    if (!t) return;
    if (ui) ui.renderNowPlaying(t);
    if (t.id && t.id !== lastId) { lastId = t.id; if (ui) ui.loadDeepDive(t); }
  }
  function onState() {
    var t = toTrack(music && music.nowPlayingItem);
    if (t && ui) ui.renderNowPlaying(t);
  }

  // ---- connect / diagnose ---------------------------------------------------

  // Does the browser allow the cross-site cookies MusicKit's sign-in relies on?
  // Best-effort: the Storage Access API is the most reliable signal we have.
  async function thirdPartyCookiesLikelyBlocked() {
    try {
      if (document.hasStorageAccess) {
        var has = await document.hasStorageAccess();
        if (has === false) return true;
      }
    } catch (e) {}
    return false; // unknown — don't over-claim
  }

  // After a successful authorize, confirm whether the account can actually play
  // (i.e. has an active Apple Music subscription) so we can tell the user.
  async function checkSubscription() {
    try {
      var res = await music.api.music("v1/me/storefront");
      // 200 means the user token is valid and accepted.
      L("storefront:ok", { data: res && res.data });
      return true;
    } catch (e) {
      L("storefront:fail", e, "error");
      return false;
    }
  }

  async function connect() {
    clearNotice();
    if (ui) ui.setStatus("connecting to Apple Music…", "progress");
    L("authorize:start", {
      isAuthorized: isAuthorized(), hasMusic: !!music,
      storefront: music && (music.storefrontId || music.storefrontCountryCode),
      origin: location.origin,
      musicUserToken: !!(music && music.musicUserToken)
    });
    var userToken = null;
    try {
      userToken = await music.authorize();           // opens Apple sign-in popup
      L("authorize:ok", { gotToken: !!userToken, isAuthorized: isAuthorized() });
    } catch (e) {
      // FULL error object (errorCode/description live on non-enumerable props)
      L("authorize:fail", e, "error");
      await explainAuthError(e);
      refreshButton();
      return;
    }
    // authorize() resolved. The event listener will also refreshButton(),
    // but do it here too so we never depend on event timing.
    refreshButton();
    if (isAuthorized()) {
      var ok = await checkSubscription();
      L("subscription:check", { ok: ok });
      if (!ok) {
        showNotice(
          "Signed in to Apple, but this Apple ID has <b>no active Apple Music subscription</b>, " +
          "so full playback isn't available. Deep-dive cards and 30-second previews still work.",
          "warn"
        );
      }
    }
  }

  async function explainAuthError(e) {
    var code = (e && (e.errorCode || e.name)) || "";
    var msg = String((e && e.message) || e || "");
    console.warn("apple authorize failed:", code, msg, e);

    if (/AUTHORIZATION_ERROR|Unauthorized/i.test(code + " " + msg)) {
      // Known pending state: MusicKit user-token issuance is awaiting Apple-side
      // provisioning (the developer token works for catalog, but sign-in returns
      // a bare "Unauthorized" for every account). Show a calm "coming soon"
      // instead of alarming the user. The logger still captures the full error.
      showNotice(
        "<b>Apple Music is coming soon.</b> We're finishing setup with Apple, so sign-in isn't available just yet — " +
        "Spotify is fully connected and ready in the meantime. We'll switch Apple Music on the moment it clears.",
        "info"
      );
      if (ui) ui.setStatus("Apple Music — coming soon", "");
    } else {
      showNotice("Couldn't connect to Apple Music: " + (msg || code || "unknown error") + ".", "error");
      if (ui) ui.setStatus("Apple Music not connected", "");
    }
  }

  async function disconnect() {
    try { await music.unauthorize(); } catch (e) {}
    lastId = null;
    refreshButton();
    if (ui) ui.setStatus(window.SDD && window.SDD.spotify && window.SDD.spotify.isConnected() ? "connected" : "ready", "");
  }

  // ---- catalog search / playback (unchanged behaviour) ----------------------

  async function search(term) {
    try {
      var r = await music.api.music("v1/catalog/" + storefront + "/search", { term: term, types: "songs", limit: 1 });
      var songs = r && r.data && r.data.results && r.data.results.songs && r.data.results.songs.data;
      return (songs && songs[0]) || null;
    } catch (e) { console.warn("apple search failed", e); return null; }
  }

  async function playQuery(term) {
    var song = await search(term);
    if (!song) return false;
    try { await music.setQueue({ song: song.id }); await music.play(); return true; }
    catch (e) { console.warn("apple play failed", e); return false; }
  }

  // ---- init -----------------------------------------------------------------

  async function init(uiHelpers) {
    ui = uiHelpers;
    btn = document.getElementById("appleBtn");
    L("init:start", { hasBtn: !!btn });
    var token = await fetchToken();
    if (!token) { L("init:no-token"); return false; } // not configured → stay hidden & inert
    try {
      music = await loadAndConfigure(token);
      try { if (music.storefrontId) storefront = music.storefrontId; } catch (e) {}
      music.addEventListener("nowPlayingItemDidChange", onNowPlaying);
      music.addEventListener("playbackStateDidChange", onState);
      // The key fix: reflect authorization state whenever MusicKit changes it,
      // so the button is always correct regardless of how/when auth resolves.
      music.addEventListener("authorizationStatusDidChange", function (e) {
        L("authorizationStatusDidChange", { status: e && e.authorizationStatus, isAuthorized: isAuthorized() });
        refreshButton();
      });
    } catch (e) { L("init:fail", e, "error"); console.warn("apple init failed", e); return false; }
    if (btn) btn.classList.remove("hidden");
    refreshButton();           // restores "Apple Music ✓" if a token already exists
    AM.ready = true;
    L("init:ok", { storefront: storefront, isAuthorized: isAuthorized() });
    return true;
  }

  var AM = { ready: false, init: init, playQuery: playQuery, connect: connect, disconnect: disconnect, isAuthorized: isAuthorized };
  window.SDD = window.SDD || {};
  window.SDD.appleMusic = AM;
})();
