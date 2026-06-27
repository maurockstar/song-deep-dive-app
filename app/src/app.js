// Song Deep Dive — app bootstrap & UI wiring
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
    status: document.getElementById("status"),
    tpl: document.getElementById("cardTpl")
  };

  var lastTrackId = null;
  var pollTimer = null;

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

  function renderCards(payload) {
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
      var more = node.querySelector(".card-more");
      var extra = node.querySelector(".card-extra");
      if (c.extra) {
        extra.textContent = c.extra;
        more.onclick = function () {
          extra.classList.toggle("hidden");
          more.textContent = extra.classList.contains("hidden") ? "Go deeper ↓" : "Show less ↑";
        };
      } else {
        more.remove();
      }
      els.deep.appendChild(node);
    });
  }

  async function loadDeepDive(track) {
    skeletonCards(4);
    var q = new URLSearchParams({
      id: track.id || "",
      title: track.title || "",
      artist: track.artist || ""
    });
    try {
      var res = await fetch(CFG.API_BASE + "/deepdive?" + q.toString());
      if (!res.ok) throw new Error("api " + res.status);
      renderCards(await res.json());
    } catch (e) {
      console.error("deepdive failed", e);
      els.deep.innerHTML = '<div class="empty"><h1>Hmm.</h1><p>Couldn\'t reach the deep-dive service. The API stub runs under <code>swa start</code> or once deployed to Azure.</p></div>';
    }
  }

  async function poll() {
    try {
      var track = await P.getActivePlayer().getCurrentTrack();
      renderNowPlaying(track);
      if (track && track.id && track.id !== lastTrackId) {
        lastTrackId = track.id;
        loadDeepDive(track);
      }
    } catch (e) { console.warn("poll error", e); }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    poll();
    pollTimer = setInterval(poll, CFG.POLL_MS);
  }

  // Manual fallback: dive into a typed song (no player needed)
  function manualDive() {
    var q = (els.manualInput.value || "").trim();
    if (!q) return;
    lastTrackId = "manual:" + q;
    renderNowPlaying({ title: q, artist: "manual search", art: "", isPlaying: false });
    loadDeepDive({ id: "", title: q, artist: "" });
  }

  async function init() {
    refreshConnectButton();
    els.manualBtn.onclick = manualDive;
    els.manualInput.addEventListener("keydown", function (e) { if (e.key === "Enter") manualDive(); });

    var didLogin = await S.handleRedirect();
    if (didLogin) refreshConnectButton();
    if (S.isConnected()) startPolling();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
