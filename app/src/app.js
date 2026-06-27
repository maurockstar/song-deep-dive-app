// Song Deep Dive — app bootstrap & UI wiring
// v0.5
(function () {
  "use strict";
  var CFG = window.SDD_CONFIG;
  var S = window.SDD.spotify;
  var P = window.SDD.player;

  var els = {
    connect: document.getElementById("connectBtn"),
    now: document.getElementById("nowPlaying"),
    art: document.getElementById("npArt"),
    title: document.getElementById("npTitle"),
    artist: document.getElementById("npArtist"),
    state: document.getElementById("npState"),
    deep: document.getElementById("deepDive"),
    empty: document.getElementById("emptyState"),
    manualInput: document.getElementById("manualInput"),
    manualBtn: document.getElementById("manualBtn"),
    suggest: document.getElementById("suggestList"),
    status: document.getElementById("status"),
    tpl: document.getElementById("cardTpl")
  };

  var lastPlayingId = null;   // last Spotify track id the poller has seen (for change detection)
  var manualMode = false;     // true after a manual search, so polling won't hijack the cards
  var pollTimer = null;
  var loadSeq = 0; // bumps on every new deep dive so stale responses can't overwrite fresh ones

  function setStatus(text, cls) {
    els.status.textContent = text;
    els.status.className = "status" + (cls ? " " + cls : "");
  }

  function refreshConnectButton() {
    if (S.isConnected()) {
      els.connect.textContent = "Connected ✓";
      els.connect.onclick = function () { S.logout(); location.reload(); };
      setStatus("connected", "ok");
    } else {
      els.connect.textContent = "Connect Spotify";
      els.connect.onclick = function () { S.login(); };
      setStatus("not connected");
    }
  }

  function renderNowPlaying(track) {
    if (!track) {
      els.now.classList.add("hidden");
      return;
    }
    els.now.classList.remove("hidden");
    els.art.src = track.art || "";
    els.title.textContent = track.title;
    els.artist.textContent = track.artist;
    els.state.textContent = track.isPlaying ? "▶ playing" : "❚❚ paused";
  }

  function skeletonCards(n) {
    els.empty && els.empty.classList.add("hidden");
    els.deep.innerHTML = "";
    for (var i = 0; i < n; i++) {
      var d = document.createElement("div");
      d.className = "card skeleton";
      d.innerHTML = '<div class="card-kicker">loading</div><h2 class="card-title">Gathering the story…</h2><p class="card-body">one moment</p>';
      els.deep.appendChild(d);
    }
  }

  function setEnriching(on) {
    if (on) setStatus("enriching with AI…", "progress");
    else setStatus(S.isConnected() ? "connected" : "ready", S.isConnected() ? "ok" : "");
  }

  function renderCards(payload, animate) {
    els.deep.innerHTML = "";
    var cards = (payload && payload.cards) || [];
    if (!cards.length) {
      els.deep.innerHTML = '<div class="empty"><h1>No deep dive yet</h1><p>We couldn\'t assemble this one. Try another song.</p></div>';
      return;
    }
    cards.forEach(function (c) {
      var node = els.tpl.content.cloneNode(true);
      node.querySelector(".card-kicker").textContent = c.kicker || "";
      node.querySelector(".card-title").textContent = c.title || "";
      node.querySelector(".card-body").textContent = c.body || "";
      var extra = node.querySelector(".card-extra");
      if (c.extra) { extra.textContent = c.extra; }
      else if (extra) { extra.remove(); }
      els.deep.appendChild(node);
    });
    if (animate) {
      els.deep.style.opacity = "0";
      els.deep.style.transition = "opacity .35s ease";
      requestAnimationFrame(function () { els.deep.style.opacity = "1"; });
    } else {
      els.deep.style.opacity = "1";
    }
  }

  async function loadDeepDive(track) {
    var mine = ++loadSeq; // anything older than this is stale once the track changes
    skeletonCards(4);
    var q = new URLSearchParams({
      id: track.id || "",
      title: track.title || "",
      artist: track.artist || ""
    });
    var base = CFG.API_BASE + "/deepdive?" + q.toString();
    try {
      // Phase 1 — open-data cards, returned instantly (no waiting on the AI).
      var fastRes = await fetch(base + "&fast=1");
      if (!fastRes.ok) throw new Error("api " + fastRes.status);
      var fast = await fastRes.json();
      if (mine !== loadSeq) return;          // user already moved to another song
      renderCards(fast);

      // Phase 2 — if an AI upgrade is coming, fetch it and swap it in.
      if (fast._meta && fast._meta.aiPending) {
        setEnriching(true);
        try {
          var fullRes = await fetch(base);
          if (fullRes.ok) {
            var full = await fullRes.json();
            if (mine !== loadSeq) return;
            if (full && full.cards && full.cards.length) renderCards(full, true);
          }
        } catch (e2) { /* keep the open-data cards on any AI failure */ }
        if (mine === loadSeq) setEnriching(false);
      }
    } catch (e) {
      if (mine !== loadSeq) return;
      console.error("deepdive failed", e);
      els.deep.innerHTML = '<div class="empty"><h1>Hmm.</h1><p>Couldn\'t reach the deep-dive service. The API stub runs under <code>swa start</code> or once deployed to Azure.</p></div>';
    }
  }

  async function poll() {
    try {
      var track = await P.getActivePlayer().getCurrentTrack();
      if (track && track.id && track.id !== lastPlayingId) {
        // a new song is playing — follow it (and leave manual search mode)
        lastPlayingId = track.id;
        manualMode = false;
        renderNowPlaying(track);
        loadDeepDive(track);
      } else if (!manualMode) {
        // same song still playing — just refresh the now-playing strip (play/pause, art)
        renderNowPlaying(track);
      }
    } catch (e) { console.warn("poll error", e); }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    poll();
    pollTimer = setInterval(poll, CFG.POLL_MS);
  }

  // Manual fallback: dive into a song (typed, or chosen from suggestions)
  function diveWith(title, artist, art) {
    title = (title || "").trim();
    if (!title) return;
    hideSuggest();
    // If Apple Music is connected, actually play the song too (then show its deep dive).
    var AM = window.SDD && window.SDD.appleMusic;
    var playTerm = artist ? (title + " " + artist) : title;
    if (AM && AM.ready && AM.isAuthorized && AM.isAuthorized()) {
      try { AM.playQuery(playTerm); } catch (e) { /* fall through to cards-only */ }
    }
    manualMode = true; // pin the cards to this search until a new song starts playing
    renderNowPlaying({ title: title, artist: artist || "manual search", art: art || "", isPlaying: false });
    loadDeepDive({ id: "", title: title, artist: artist || "" });
  }
  function manualDive() { diveWith(els.manualInput.value, "", ""); }

  // ---- Type-ahead suggestions (free iTunes Search via /api/suggest) ----
  var suggestTimer = null, suggestItems = [], activeIdx = -1;

  function hideSuggest() {
    if (!els.suggest) return;
    els.suggest.classList.add("hidden");
    els.suggest.innerHTML = "";
    suggestItems = []; activeIdx = -1;
    els.manualInput.setAttribute("aria-expanded", "false");
  }
  function renderSuggest(items) {
    suggestItems = items; activeIdx = -1;
    if (!items.length) { hideSuggest(); return; }
    els.suggest.innerHTML = "";
    items.forEach(function (it) {
      var li = document.createElement("li");
      li.setAttribute("role", "option");
      li.innerHTML = '<img alt="" /><div class="s-meta"><div class="s-title"></div><div class="s-artist"></div></div>';
      li.querySelector("img").src = it.art || "";
      li.querySelector(".s-title").textContent = it.title;
      li.querySelector(".s-artist").textContent = it.artist;
      li.addEventListener("mousedown", function (e) {
        e.preventDefault();
        els.manualInput.value = it.title;
        diveWith(it.title, it.artist, it.art);
      });
      els.suggest.appendChild(li);
    });
    els.suggest.classList.remove("hidden");
    els.manualInput.setAttribute("aria-expanded", "true");
  }
  function highlight(idx) {
    var lis = els.suggest.querySelectorAll("li");
    for (var i = 0; i < lis.length; i++) lis[i].classList.toggle("active", i === idx);
  }
  async function fetchSuggest(term) {
    try {
      var res = await fetch(CFG.API_BASE + "/suggest?term=" + encodeURIComponent(term));
      if (!res.ok) return;
      var data = await res.json();
      if ((els.manualInput.value || "").trim() === term) renderSuggest((data && data.suggestions) || []);
    } catch (e) { /* silent — typing keeps working without suggestions */ }
  }
  function onManualInput() {
    var term = (els.manualInput.value || "").trim();
    if (suggestTimer) clearTimeout(suggestTimer);
    if (term.length < 2) { hideSuggest(); return; }
    suggestTimer = setTimeout(function () { fetchSuggest(term); }, 250);
  }
  function onManualKey(e) {
    var open = els.suggest && !els.suggest.classList.contains("hidden");
    if (!open) { if (e.key === "Enter") manualDive(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, suggestItems.length - 1); highlight(activeIdx); }
    else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); highlight(activeIdx); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIdx >= 0 && suggestItems[activeIdx]) {
        var it = suggestItems[activeIdx];
        els.manualInput.value = it.title;
        diveWith(it.title, it.artist, it.art);
      } else { manualDive(); }
    } else if (e.key === "Escape") { hideSuggest(); }
  }

  async function init() {
    refreshConnectButton();
    var verEl = document.getElementById("appVersion");
    if (verEl && CFG.VERSION) verEl.textContent = "Song Deep Dive · v" + CFG.VERSION;
    els.manualBtn.onclick = manualDive;
    els.manualInput.addEventListener("input", onManualInput);
    els.manualInput.addEventListener("keydown", onManualKey);
    document.addEventListener("click", function (e) {
      if (els.suggest && !els.suggest.contains(e.target) && e.target !== els.manualInput) hideSuggest();
    });

    var didLogin = await S.handleRedirect();
    if (didLogin) refreshConnectButton();
    if (S.isConnected()) startPolling();

    // Apple Music — inert unless /api/amtoken is configured (server-side MusicKit key).
    window.SDD = window.SDD || {};
    window.SDD.ui = { renderNowPlaying: renderNowPlaying, loadDeepDive: loadDeepDive, setStatus: setStatus };
    if (window.SDD.appleMusic && window.SDD.appleMusic.init) {
      try { await window.SDD.appleMusic.init(window.SDD.ui); } catch (e) { console.warn("apple init", e); }
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
