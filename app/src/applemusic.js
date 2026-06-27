// Song Deep Dive — Apple Music provider (MusicKit JS v3).
// Stays completely inert until /api/amtoken is configured server-side:
// if there's no developer token, the Apple Music button never appears and
// nothing here runs, so the existing Spotify / open-data app is untouched.
(function () {
  "use strict";
  var CFG = window.SDD_CONFIG || {};
  var ui = null;          // { renderNowPlaying, loadDeepDive, setStatus } from app.js
  var music = null;       // MusicKit instance
  var storefront = "us";
  var lastId = null;
  var btn = null;

  function api(p) { return (CFG.API_BASE || "/api") + p; }

  async function fetchToken() {
    try {
      var r = await fetch(api("/amtoken"));
      if (!r.ok) return null;
      var j = await r.json();
      return (j && j.configured && j.token) ? j.token : null;
    } catch (e) { return null; }
  }

  // Load MusicKit JS from Apple's CDN (once) and configure it with our token.
  function loadAndConfigure(token) {
    return new Promise(function (resolve, reject) {
      function go() {
        MusicKit.configure({ developerToken: token, app: { name: "Song Deep Dive", build: "0.3" } })
          .then(resolve).catch(reject);
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

  async function connect() {
    try {
      await music.authorize();
      if (ui) ui.setStatus("Apple Music connected", "ok");
      if (btn) btn.textContent = "Apple Music ✓";
    } catch (e) { console.warn("apple authorize failed", e); }
  }

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

  async function init(uiHelpers) {
    ui = uiHelpers;
    btn = document.getElementById("appleBtn");
    var token = await fetchToken();
    if (!token) return false; // not configured → stay hidden & inert
    try {
      music = await loadAndConfigure(token);
      try { if (music.storefrontId) storefront = music.storefrontId; } catch (e) {}
      music.addEventListener("nowPlayingItemDidChange", onNowPlaying);
      music.addEventListener("playbackStateDidChange", onState);
    } catch (e) { console.warn("apple init failed", e); return false; }
    if (btn) { btn.classList.remove("hidden"); btn.onclick = connect; }
    AM.ready = true;
    return true;
  }

  var AM = { ready: false, init: init, playQuery: playQuery, isAuthorized: function () { return !!(music && music.isAuthorized); } };
  window.SDD = window.SDD || {};
  window.SDD.appleMusic = AM;
})();
