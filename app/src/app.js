// geeek — app bootstrap & UI wiring (v1.0)
(function () {
  "use strict";
  var CFG = window.SDD_CONFIG;
  var S = window.SDD.spotify;
  var P = window.SDD.player;
  var CTRL = (P && P.control) || {};
  var AM = window.SDD && window.SDD.appleMusic;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return (s == null ? "" : String(s)).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  var panel, hint, tabsEl;
  var cur = null;            // subject track {id,title,artist,art,album}
  var manualMode = false;
  var lastPlayingId = null;
  var pollTimer = null, loadSeq = 0;
  var curTab = "cards";
  var playing = false;
  var pstate = { progressMs: 0, durationMs: 0, playing: false, at: 0 };

  // ---------- now playing / hero ----------
  function fmtMs(ms) { if (!ms || ms < 0) ms = 0; var s = Math.floor(ms / 1000), m = Math.floor(s / 60), x = s % 60; return m + ":" + (x < 10 ? "0" : "") + x; }
  // Set the now-playing title and auto-scroll it horizontally when it's wider than the screen (marquee).
  function setTitleText(text) {
    var box = $("gk-title"); if (!box) return;
    var inner = box.querySelector(".np-title-in");
    if (!inner) { box.textContent = ""; inner = document.createElement("span"); inner.className = "np-title-in"; box.appendChild(inner); }
    inner.setAttribute("data-text", text || "");
    inner.textContent = text || "";
    applyTitleMarquee();
  }
  function applyTitleMarquee() {
    var box = $("gk-title"); if (!box) return;
    var inner = box.querySelector(".np-title-in"); if (!inner) return;
    var txt = inner.getAttribute("data-text") || inner.textContent || "";
    box.classList.remove("scroll");
    inner.textContent = txt;                                   // single copy for the overflow measurement
    var hero = document.querySelector(".hero");
    if (hero && hero.classList.contains("compact")) return; // compact bar keeps a simple ellipsis
    requestAnimationFrame(function () {
      if ((inner.scrollWidth - box.clientWidth) > 8) {
        // Seamless continuous marquee: two identical copies (with a gap); scroll left by EXACTLY one copy so
        // the second lands where the first began — the loop restart is invisible (no snap-back).
        inner.textContent = "";
        var s1 = document.createElement("span"); s1.className = "seg"; s1.textContent = txt;
        var s2 = document.createElement("span"); s2.className = "seg"; s2.textContent = txt; s2.setAttribute("aria-hidden", "true");
        inner.appendChild(s1); inner.appendChild(s2);
        var shift = s1.offsetWidth;                             // one copy incl. its trailing gap
        var dur = Math.max(8, Math.min(40, shift / 50));        // ~50px/s, steady
        inner.style.setProperty("--shift", (-shift) + "px");
        inner.style.setProperty("--dur", dur + "s");
        box.classList.add("scroll");
      }
    });
  }
  function setHero(t) {
    if (t) {
      setTitleText(t.title || "—");
      $("gk-artist").textContent = t.artist || "";
      $("gk-art").style.backgroundImage = t.art ? ('url("' + t.art + '")') : "";
    } else {
      setTitleText("Nothing playing");
      $("gk-artist").textContent = "Connect Spotify or search a song";
      $("gk-art").style.backgroundImage = "";
    }
  }
  function setPlayIcon(on) {
    var svg = on
      ? '<svg viewBox="0 0 24 24" width="26" height="26" fill="#1A0B05"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>'
      : '<svg viewBox="0 0 24 24" width="26" height="26" fill="#1A0B05"><path d="M8 5v14l11-7z"/></svg>';
    $("gk-playbtn").innerHTML = svg;
    var lb = $("gk-lb-play"); if (lb) lb.innerHTML = svg; // keep the full-screen cover's play/pause in sync
  }
  // Reflect Spotify's real shuffle/repeat state on the transport + full-screen buttons.
  function setModeButtons(shuffleOn, repeatState) {
    var son = !!shuffleOn;
    var ron = !!(repeatState && repeatState !== "off");
    ["gk-shuffle", "gk-lb-shuffle"].forEach(function (id) { var el = $(id); if (el) el.classList.toggle("on", son); });
    ["gk-repeat", "gk-lb-repeat"].forEach(function (id) { var el = $(id); if (el) { el.classList.toggle("on", ron); el.classList.toggle("one", repeatState === "track"); } });
  }
  // ---------- Liked Songs heart: save/remove the current Spotify track in the user's library ----------
  var likeState = { id: null, saved: false, busy: false };
  function likeEls() { return ["gk-like", "gk-lb-like"].map($).filter(Boolean); }
  function paintLike(saved) {
    likeEls().forEach(function (el) {
      el.classList.toggle("on", !!saved);
      el.setAttribute("aria-pressed", saved ? "true" : "false");
      el.setAttribute("aria-label", saved ? "Remove from Liked Songs" : "Save to Liked Songs");
    });
  }
  function showLike(show) { likeEls().forEach(function (el) { el.hidden = !show; }); }
  // Show the heart only for a real Spotify track id, when connected, and when the library scope
  // actually answered (null -> hide, so we never paint a wrong saved/unsaved state).
  async function refreshLike(id) {
    likeState.id = id || null;
    if (!id || !S || !S.isConnected || !S.isConnected()) { showLike(false); return; }
    var saved = await S.isSaved(id);
    if (likeState.id !== id) return;                 // track changed while awaiting
    if (saved === null) { showLike(false); return; } // no scope / error
    likeState.saved = saved; paintLike(saved); showLike(true);
  }
  // Toggle save <-> remove with optimistic UI + rollback if Spotify rejects it.
  async function toggleLike() {
    var id = likeState.id;
    if (!id || likeState.busy || !S) return;
    likeState.busy = true;
    var want = !likeState.saved;
    paintLike(want);
    if (want) likeEls().forEach(function (el) { el.classList.add("pop"); setTimeout(function () { el.classList.remove("pop"); }, 360); });
    var st = want ? await S.saveTrack(id) : await S.removeTrack(id);
    var ok = st >= 200 && st < 300;
    if (ok) { likeState.saved = want; flashPmsg(want ? "Added to your Spotify Liked Songs" : "Removed from Liked Songs"); }
    else if (st === 401) { paintLike(likeState.saved); flashPmsg("Please reconnect Spotify and try again."); }
    else { paintLike(likeState.saved); flashPmsg("Couldn't update Liked Songs right now. Please try again."); }
    likeState.busy = false;
  }

  function setProgress(progressMs, durationMs) {
    var pct = durationMs ? Math.min(100, progressMs / durationMs * 100) : 0;
    $("gk-fill").style.width = pct + "%";
    $("gk-handle").style.left = pct + "%";
    $("gk-elapsed").textContent = fmtMs(progressMs);
    $("gk-duration").textContent = fmtMs(durationMs);
  }
  function tickProgress() {
    if (!pstate.durationMs) { setProgress(0, 0); return; }
    var extra = pstate.playing ? (Date.now() - pstate.at) : 0;
    setProgress(Math.min(pstate.durationMs, pstate.progressMs + extra), pstate.durationMs);
  }
  setInterval(tickProgress, 1000);

  function updateShareLink(t) {
    if (!t) return;
    var url = location.origin + "/?t=" + encodeURIComponent(t.title || "") + "&a=" + encodeURIComponent(t.artist || "");
    var link = $("gk-link"); if (link) link.value = url;
  }

  // ---------- deep-dive cache ----------
  var CACHE_PREFIX = "sdd:cards:v" + ((CFG && CFG.VERSION) || "0") + ":";
  // Canonical key mirrors the server: same song -> same story, regardless of edition/feature noise.
  function ckNorm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
  function ckTitle(t) { return String(t || "").replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ").replace(/\s[-–—]\s.*$/, " "); }
  function ckArtist(a) { return String(a || "").split(/,|&|;|\/|feat\.?|featuring|\bwith\b|\bx\b|vs\.?/i)[0]; }
  function cacheKey(t) { return CACHE_PREFIX + (ckNorm(ckTitle(t.title)) + "|" + ckNorm(ckArtist(t.artist))).replace(/\s+/g, "_"); }
  function cacheGet(t) { try { var r = localStorage.getItem(cacheKey(t)); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
  function cacheSet(t, p) { try { localStorage.setItem(cacheKey(t), JSON.stringify(p)); } catch (e) {} }
  function isAi(p) { return !!(p && p._meta && typeof p._meta.source === "string" && p._meta.source.indexOf("ai") === 0); }

  // ---------- panels ----------
  function welcome() {
    if (hint && curTab === "cards") hint.textContent = "Connect a service or search a song to begin";
    panel.innerHTML = '<div style="background:linear-gradient(180deg,var(--card),var(--card2));border:1px dashed var(--border2);border-radius:16px;padding:34px 18px;text-align:center">'
      + '<div style="font-family:var(--round);font-weight:600;font-size:19px;color:var(--ink-hi);margin-bottom:6px">Nothing to dive into yet</div>'
      + '<div style="color:var(--dim);font-size:13px;line-height:1.5;max-width:32ch;margin:0 auto">Once a song is playing, its story, people, videos and trivia appear here.</div></div>';
  }
  function notePanel(text) { panel.innerHTML = '<div class="soon"><p>' + esc(text) + '</p></div>'; }
  function comingSoonHTML(title, desc) {
    return '<div class="soon"><span class="soon-badge">Coming soon</span><h3>' + esc(title) + '</h3><p>' + esc(desc) + '</p></div>';
  }
  function comingSoon(title, desc) { panel.innerHTML = comingSoonHTML(title, desc); }

  // ---------- deep dive: fun-fact pager ----------
  // The real /api/deepdive returns ~5 cards (story / people / connections / fun facts /
  // did you know). We present them one at a time as "fun facts" with a 5-segment pager;
  // "Dive deeper" reveals each card's deeper `extra` text (and the remaining cards).
  var DD = { cards: [], i: 0, deep: false };
  function factText(c) {
    // Prefer a short punchy line: the card body, else the title.
    return (c && (c.body || c.title)) || "";
  }
  function skeletonCards() {
    panel.innerHTML = '<article class="st-read">'
      + '<div class="st-kicker">The story</div>'
      + '<div class="st-headline skeleton" style="height:26px;max-width:80%;border-radius:8px">&nbsp;</div>'
      + '<div class="st-body"><p class="st-p skeleton">Reading the room and gathering the story…</p>'
      + '<p class="st-p skeleton">One moment.</p></div></article>';
  }
  function renderFunFact() {
    var cards = DD.cards;
    if (!cards.length) { notePanel("No deep dive for this one yet — try another song."); return; }
    if (DD.i >= cards.length) DD.i = 0;
    var c = cards[DD.i];
    var total = Math.min(5, cards.length);
    var pager = "";
    for (var i = 0; i < total; i++) pager += '<span class="' + (i === DD.i % total ? "lit" : "") + '"></span>';
    var extra = DD.deep ? (c.extra || c.title || "") : "";
    var deeperLabel = (DD.i < cards.length - 1) ? "Dive deeper" : (DD.deep ? "Dive deeper" : "Dive deeper");
    panel.innerHTML = '<div class="ff-card" id="ff-card">'
      + '<div class="ff-kicker">' + esc(c.kicker || "Fun fact") + '</div>'
      + '<div class="ff-fact">' + esc(factText(c)) + '</div>'
      + (DD.deep && extra && extra !== factText(c) ? '<div class="ff-extra">' + esc(extra) + '</div>' : '')
      + '<div class="ff-pager">' + pager + '</div></div>'
      + '<button class="ff-deeper" id="ff-deeper">' + deeperLabel + '</button>';
  }
  function diveDeeper() {
    // First press reveals the deeper text on the current card; subsequent presses
    // page forward through the remaining cards.
    if (!DD.deep) { DD.deep = true; renderFunFact(); return; }
    DD.i = (DD.i + 1) % DD.cards.length;
    DD.deep = false;
    renderFunFact();
  }
  // ---------- deep dive: editorial STORY long-read (ports the prototype's Story) ----------
  function storyBlocksHtml(blocks, seedTexts) {
    var h = "";
    var arr = blocks || [];
    var seen = {};
    // Seed with already-shown text (headline/dek) so a body block that repeats them is dropped.
    (seedTexts || []).forEach(function (s) { var k = nrmTxt(s); if (k) seen[k] = 1; });
    for (var i = 0; i < arr.length; i++) {
      var b = arr[i];
      if (!b || !b.text) continue;
      var k = nrmTxt(b.text);
      if (!k || seen[k]) continue;   // skip empty or duplicate paragraphs/quotes
      seen[k] = 1;
      if (b.type === "quote") h += '<blockquote class="st-quote">' + esc(b.text) + '</blockquote>';
      else h += '<p class="st-p">' + esc(b.text) + '</p>';
    }
    return h;
  }
  function deriveStory(payload) {
    if (payload && payload.story && payload.story.headline) return payload.story;
    var cards = (payload && payload.cards) || [];
    if (!cards.length) return null;
    var body = [];
    for (var i = 1; i < cards.length; i++) {
      var c = cards[i]; if (!c) continue;
      if (c.body) body.push({ type: (i % 3 === 2 ? "quote" : "p"), text: c.body });
      if (c.extra) body.push({ type: "p", text: c.extra });
    }
    return { headline: (cards[0] && cards[0].title) || ((cur && cur.title) || "The story"), dek: (cards[0] && cards[0].body) || "", body: body };
  }
  var curStoryKey = "";
  var shownStoryPhotos = {};              // photo URLs already used in the first story section (so "geeek deeper" uses different pics)
  var deeperState = { loaded: false, key: "" };
  var curStoryText = "";                  // the already-shown story text, sent to /api/deeper so it stays complementary
  function artBaseUrl(u) { return (u || "").replace(/\/[0-9]+x[0-9]+[^\/]*$/, ""); } // ignore iTunes size suffix
  function nrmTxt(x) { return (x || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
  function trackKey(t) { return t ? (nrmTxt(t.artist || "") + "|" + nrmTxt(t.title || "")) : ""; }
  // Album title reduced to a stable base so "Rain Tree Crow (Remastered 2019)" == "Rain Tree Crow".
  function baseAlbum(x) {
    return (x || "").toLowerCase()
      .replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ")   // (remastered 2019) / [deluxe]
      .replace(/\b(remaster(ed)?|deluxe|expanded|extended|edition|version|anniversary|mono|stereo|explicit|clean|bonus|reissue|single|ep|live|ost|soundtrack)\b/g, " ")
      .replace(/\b(19|20)\d{2}\b/g, " ")                        // stray years
      .replace(/[^a-z0-9]+/g, "");
  }
  // True when an iTunes album title is (fuzzily) the now-playing album — so we never show its cover.
  function isCurrentAlbum(title) {
    var a = baseAlbum(title), b = baseAlbum((cur && cur.album) || "");
    if (!a || !b) return false;
    if (a === b) return true;
    return a.length >= 4 && b.length >= 4 && (a.indexOf(b) > -1 || b.indexOf(a) > -1);
  }
  function enrichStoryMedia(payload) {
    // Show up to 3 distinct, HIGH-RES, clickable pictures per story — and never the album cover.
    var t = (payload && payload.track) || cur;
    if (!t || !t.artist) return;
    var key = trackKey(t);
    curStoryKey = key;
    try {
      fetch(CFG.API_BASE + "/media?" + new URLSearchParams({ artist: t.artist || "", title: t.title || "", album: t.album || (cur && cur.album) || "", year: t.albumYear || (cur && cur.albumYear) || "", v: "25" }).toString(), { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (key !== curStoryKey || curTab !== "cards") return;
          var items = (d && d.items) || [];
          var curArt = (cur && cur.art) || "";
          function artBase(u) { return (u || "").replace(/\/[0-9]+x[0-9]+[^\/]*$/, ""); } // ignore iTunes size suffix
          var curArtBase = artBase(curArt);
          var seen = {}, imgs = [];
          function add(it) {
            if (!it) return;
            var url = it.url || it.thumb; if (!url) return;
            if (it.type === "photo" && it.w && it.w < 600) return;                       // skip tiny (fair-use) photos — they look blurry full-width / full-screen
            var base = artBase(url);
            if (seen[base]) return;                                                      // same image at any size
            if (curArt && (url === curArt || base === curArtBase)) return;               // exact same file as the now-playing cover
            if (it.type === "album" && isCurrentAlbum(it.title)) return;                 // the current album's cover (fuzzy: ignores remaster/year suffixes)
            seen[base] = 1;
            imgs.push({ url: url, cap: it.title || t.artist || "", credit: it.credit || "" });
          }
          items.forEach(function (it) { if (it && it.type === "photo") add(it); }); // ONLY real, on-topic band/era photos — never album covers as inline editorial
          imgs = imgs.slice(0, 3);
          imgs.forEach(function (mm) { shownStoryPhotos[mm.url] = 1; }); // reserve these so "geeek deeper" shows different pics
          if (!imgs.length) return;
          imgs.forEach(function (mm, idx) {
            var el = new Image();
            el.className = "st-media-img";
            el.decoding = "async"; el.alt = mm.cap || "";  // NOTE: never set loading="lazy" here — the img is only inserted inside onload, so a lazy (detached) image would never load and never fire onload (deadlock).
            el.style.cursor = "zoom-in";
            el.addEventListener("click", function () { openStoryPhoto(mm.url, (mm.cap || "") + (mm.credit ? " — " + mm.credit : "")); });
            el.onerror = function () {};
            el.onload = function () {
              if (key !== curStoryKey || curTab !== "cards") return;
              // de-dupe: if this exact image is already placed (e.g. a racing enrichment), skip.
              var already = panel.querySelectorAll("img.st-media-img");
              for (var z = 0; z < already.length; z++) { if (already[z] !== el && already[z].src === el.src) return; }
              var fig = document.createElement("figure");
              fig.className = "st-media";
              fig.appendChild(el);
              var cap = document.createElement("figcaption");
              cap.textContent = mm.cap || "";
              if (mm.credit) { el.title = mm.credit; el.setAttribute("aria-label", (mm.cap || "") + " — " + mm.credit); } // charter v1.1: attribution kept on the image (tooltip) + full-screen view; removed from the visible caption
              fig.appendChild(cap);
              if (idx === 0) { var lead = panel.querySelector("#st-lead"); if (lead) { if (lead.querySelector(".st-media")) return; lead.appendChild(fig); return; } }
              var bodyEl = panel.querySelector(".st-body");
              if (!bodyEl) return;
              var blocks = bodyEl.querySelectorAll(".st-p, .st-quote");
              var afterIdx = (idx === 1) ? 1 : 3;
              if (blocks.length > afterIdx) { var ref = blocks[afterIdx]; if (ref.nextSibling) ref.parentNode.insertBefore(fig, ref.nextSibling); else ref.parentNode.appendChild(fig); }
              else { bodyEl.appendChild(fig); }
            };
            el.src = mm.url;
          });
        })
        .catch(function () {});
    } catch (e) {}
  }
  // Self-healing: the live player can change tracks mid-flight and cancel an in-flight
  // enrichment. Retry a few times while the SAME track stays displayed until pictures land.
  function enrichStoryRetry(payload, tries) {
    enrichStoryMedia(payload);
    if (tries > 0) {
      var myKey = trackKey((payload && payload.track) || cur);
      setTimeout(function () {
        if (curTab === "cards" && trackKey(cur) === myKey && !panel.querySelector(".st-media")) {
          enrichStoryRetry(payload, tries - 1);
        }
      }, 1400);
    }
  }
  function renderStory(payload) {
    var story = deriveStory(payload);
    if (!story) { notePanel("No deep dive for this one yet — try another song."); return; }
    // Drop the dek when it just repeats (a prefix/substring of) the opening paragraph \u2014 keep the fuller text.
    var dek = story.dek || "";
    var body0 = (story.body && story.body[0] && story.body[0].text) || "";
    var dN = nrmTxt(dek), bN = nrmTxt(body0);
    if (dN && bN && (dN === bN || dN.indexOf(bN) > -1 || bN.indexOf(dN) > -1)) dek = "";
    shownStoryPhotos = {};                       // fresh per song
    deeperState = { loaded: false, key: curStoryKey };
    curStoryText = [story.headline, dek].concat((story.body || []).map(function (b) { return b && b.text; })).filter(Boolean).join("\n"); // seed for complementary deeper
    panel.innerHTML = '<article class="st-read">'
      + '<div class="st-lead" id="st-lead"></div>'
      + '<div class="st-kicker">The story</div>'
      + '<h2 class="st-headline">' + esc(story.headline || "") + '</h2>'
      + (dek ? '<p class="st-dek">' + esc(dek) + '</p>' : '')
      + '<div class="st-body">' + storyBlocksHtml(story.body, [story.headline, dek]) + '</div>'
      + '<div class="st-deeper-wrap"><button class="st-deeper-btn" id="st-deeper-btn" type="button"><span class="lbl">geeek deeper</span><span class="chev" aria-hidden="true">▾</span></button></div>'
      + '<div class="st-deeper hidden" id="st-deeper"></div>'
      + '</article>';
    enrichStoryRetry(payload, 5);
  }
  function renderCards(payload) { renderStory(payload); }

  // ---------- "geeek deeper": a second, richer layer under the story ----------
  function deeperBlocksHtml(blocks) {
    var h = "", arr = blocks || [], seen = {};
    for (var i = 0; i < arr.length; i++) {
      var b = arr[i]; if (!b || !b.text) continue;
      if (b.type === "h") { h += '<h3 class="st-dh">' + esc(b.text) + '</h3>'; continue; }
      var k = nrmTxt(b.text); if (!k || seen[k]) continue; seen[k] = 1;
      if (b.type === "quote") h += '<blockquote class="st-quote">' + esc(b.text) + '</blockquote>';
      else h += '<p class="st-p">' + esc(b.text) + '</p>';
    }
    return h;
  }
  function toggleDeeper() {
    var wrap = panel.querySelector("#st-deeper");
    var btn = panel.querySelector("#st-deeper-btn");
    if (!wrap) return;
    if (deeperState.loaded && wrap.getAttribute("data-key") === curStoryKey) {
      var hidden = wrap.classList.toggle("hidden");
      if (btn) { btn.classList.toggle("open", !hidden); var l = btn.querySelector(".lbl"); if (l) l.textContent = hidden ? "geeek deeper" : "show less"; }
      return;
    }
    loadDeeper();
  }
  function loadDeeper() {
    var t = cur; if (!t || !t.title) return;
    var wrap = panel.querySelector("#st-deeper");
    var btn = panel.querySelector("#st-deeper-btn");
    if (!wrap) return;
    var myKey = trackKey(t);
    wrap.classList.remove("hidden");
    wrap.setAttribute("data-key", myKey);
    wrap.innerHTML = '<div class="st-deeper-note">Digging deeper…</div>';
    if (btn) btn.classList.add("loading");
    fetch(CFG.API_BASE + "/deeper", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: t.title || "", artist: t.artist || "", album: t.album || "", seed: curStoryText || "" })
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (curStoryKey !== myKey) return;
        var deeper = d && d.deeper;
        if (!deeper || !deeper.body || !deeper.body.length) {
          wrap.innerHTML = '<div class="st-deeper-note">More on this one is coming soon.</div>';
          if (btn) btn.classList.remove("loading");
          return;
        }
        wrap.innerHTML = deeperBlocksHtml(deeper.body);
        deeperState.loaded = true; deeperState.key = myKey;
        if (btn) { btn.classList.remove("loading"); btn.classList.add("open"); var l = btn.querySelector(".lbl"); if (l) l.textContent = "show less"; }
        enrichDeeperMedia(t, wrap);
        renderCovers(wrap, deeper.covers, deeper.original);   // "Covers", or "The original" + "Also covered by" when this track is itself a cover
        renderSimilarSongs(wrap, deeper.recos);   // "Similar songs" — 2 real Spotify links
        renderOfficialVideo(wrap, deeper.video);  // official YouTube/Vimeo video card at the very end
      })
      .catch(function () {
        wrap.innerHTML = '<div class="st-deeper-note">Couldn’t load the deeper story right now.</div>';
        if (btn) btn.classList.remove("loading");
      });
  }
  // "Similar songs" — two cross-artist picks, each opening in the user's Spotify app.
  // Clicking a recommended/cover track ADDS it to the user's Spotify queue (plays next) instead of
  // hijacking playback — so their current queue keeps going. Falls back to opening the track in Spotify
  // if there's no auth/active device. No-op (link opens normally) when Spotify isn't wired in.
  // Resolve deeper candidates (recos/covers) to REAL Spotify tracks; keep only exact matches, in order, up to `limit`.
  function resolveCandidates(cands, limit) {
    var S = window.SDD && window.SDD.spotify;
    if (!S || !S.resolveTrack) return Promise.resolve([]);
    return Promise.all((cands || []).map(function (c) {
      return S.resolveTrack(c.title, c.artist).then(function (t) { return { cand: c, track: t }; }, function () { return { cand: c, track: null }; });
    })).then(function (settled) {
      var out = [];
      for (var i = 0; i < settled.length; i++) { if (settled[i].track) { out.push(settled[i]); if (out.length >= (limit || 2)) break; } }
      return out;
    });
  }
  // Build one recommendation/cover button bound to an already-resolved Spotify track (tap = add to queue).
  function buildRecoButton(title, artist, why, track) {
    var spIcon = '<span class="reco-ic"><svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#1DB954"/><path d="M6.8 10.4c3.2-.9 6.9-.7 9.7 1M7.4 13.2c2.6-.7 5.6-.5 7.8.8M8 15.8c2-.5 4.2-.4 5.9.6" stroke="#08130c" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg></span>';
    var a = document.createElement("a");
    a.className = "reco-btn"; a.target = "_blank"; a.rel = "noopener";
    a.href = (track && track.url) || ("https://open.spotify.com/search/" + encodeURIComponent(((title || "") + " " + (artist || "")).trim()));
    a.innerHTML = spIcon
      + '<span class="reco-txt"><span class="reco-title">' + esc(title || "") + '</span>'
      + '<span class="reco-artist">' + esc(artist || "") + '</span>'
      + (why ? '<span class="reco-why">' + esc(why) + '</span>' : '')
      + '<span class="reco-status" aria-live="polite"></span></span>'
      + '<span class="reco-open" aria-hidden="true">▸</span>';
    attachQueueClick(a, track);
    return a;
  }
  // Tap a recommendation -> add the EXACT resolved track to the Spotify queue (plays next; never resets it).
  function attachQueueClick(a, track) {
    var S = window.SDD && window.SDD.spotify;
    var status = a.querySelector(".reco-status");
    function setStatus(m) { if (status) status.textContent = m; }
    a.addEventListener("click", function (ev) {
      ev.preventDefault();
      if (a.classList.contains("reco-queued") || a.classList.contains("reco-busy")) return;
      if (!(S && S.queueUri && track && track.uri)) { window.open(a.href, "_blank", "noopener"); return; }
      a.classList.add("reco-busy"); setStatus("Adding to your queue…");
      S.queueUri(track.uri).then(function (r) {
        a.classList.remove("reco-busy");
        if (r && r.ok) { a.classList.add("reco-queued"); setStatus("Added to your Spotify queue — plays next ✓"); }
        else if (r && r.reason === "no-device") { setStatus("Press play on Spotify first, then tap to queue."); }
        else { window.open(a.href, "_blank", "noopener"); setStatus("Opening in Spotify…"); }
      });
    });
  }
  // "Similar songs" — only tracks that resolve to a REAL Spotify match are shown (no dead links / churn).
  function renderSimilarSongs(wrap, recos) {
    if (!wrap || !recos || !recos.length) return;
    var sec = document.createElement("div"); sec.className = "st-recos"; wrap.appendChild(sec); // append now so the story photo can anchor above it
    resolveCandidates(recos, 2).then(function (matched) {
      if (!matched.length) { if (sec.parentNode) sec.parentNode.removeChild(sec); return; }
      var h = document.createElement("h3"); h.className = "st-dh st-recos-h"; h.textContent = "Similar songs"; sec.appendChild(h);
      var note = document.createElement("p"); note.className = "st-recos-note"; note.textContent = "Tap to add to your Spotify queue — plays next."; sec.appendChild(note);
      matched.forEach(function (m) { sec.appendChild(buildRecoButton(m.cand.title, m.cand.artist, m.cand.why, m.track)); });
    });
  }
  // "Covers" — up to 2 famous covers of THIS song: a short story then a Spotify button, per the user's flow.
  // "Covers" — same rule: show a cover only when it resolves to a real, playable Spotify track.
  // "Related songs": if the now-playing track IS the original, list the covers of it. If it is itself a cover,
  // say so and link to the original plus other covers. One section, heading "Related songs".
  function renderCovers(wrap, covers, original) {
    var isCover = !!(original && original.artist && original.title);
    var hasCovers = !!(covers && covers.length);
    if (!wrap || (!isCover && !hasCovers)) return;
    var sec = document.createElement("div"); sec.className = "st-recos st-covers"; wrap.appendChild(sec); // placeholder appended synchronously to keep section order
    function heading() { var h = document.createElement("h3"); h.className = "st-dh st-covers-h"; h.textContent = "Related songs"; sec.appendChild(h); }
    function subLabel(t) { var d = document.createElement("div"); d.className = "st-sublabel"; d.textContent = t; sec.appendChild(d); }
    function item(m) { if (m.cand.story) { var pp = document.createElement("p"); pp.className = "st-p"; pp.textContent = m.cand.story; sec.appendChild(pp); } sec.appendChild(buildRecoButton(m.cand.title, m.cand.artist, null, m.track)); }
    if (isCover) {
      Promise.all([resolveCandidates([original], 1), hasCovers ? resolveCandidates(covers, 2) : Promise.resolve([])]).then(function (res) {
        var oM = res[0], cM = res[1];
        if (!oM.length && !cM.length) { if (sec.parentNode) sec.parentNode.removeChild(sec); return; }
        heading();
        var note = document.createElement("p"); note.className = "st-p";
        note.textContent = "This version is a cover" + (oM.length ? " \u2014 here's the original" + (cM.length ? " and other renditions:" : ":") : ".");
        sec.appendChild(note);
        if (oM.length) { subLabel("The original"); item(oM[0]); }
        if (cM.length) { subLabel("Other covers"); cM.forEach(item); }
      });
    } else {
      resolveCandidates(covers, 2).then(function (matched) {
        if (!matched.length) { if (sec.parentNode) sec.parentNode.removeChild(sec); return; }
        heading();
        matched.forEach(item);
      });
    }
  }
  // Official video card at the very end of "geeek deeper": a clickable thumbnail with the platform logo
  // centered, opening a new tab (iOS opens the YouTube/Vimeo app via universal link, else the web client).
  function renderOfficialVideo(wrap, video) {
    if (!wrap || !video || !video.url) return;
    var isVimeo = video.platform === "vimeo";
    var sec = document.createElement("div");
    sec.className = "st-video";
    var h = document.createElement("h3"); h.className = "st-dh st-video-h"; h.textContent = "Official video"; sec.appendChild(h);
    var a = document.createElement("a");
    a.className = "video-card"; a.target = "_blank"; a.rel = "noopener"; a.href = video.url;
    if (video.thumb) a.style.backgroundImage = "url('" + video.thumb + "')";
    var ytLogo = '<svg width="64" height="45" viewBox="0 0 68 48" aria-hidden="true"><path fill="#ff0000" d="M66.5 7.7c-.8-2.9-3-5.1-5.9-5.9C55.3.5 34 .5 34 .5S12.7.5 7.4 1.8C4.5 2.6 2.3 4.8 1.5 7.7.2 13 .2 24 .2 24s0 11 1.3 16.3c.8 2.9 3 5.1 5.9 5.9C12.7 47.5 34 47.5 34 47.5s21.3 0 26.6-1.3c2.9-.8 5.1-3 5.9-5.9C67.8 35 67.8 24 67.8 24s0-11-1.3-16.3z"/><path fill="#fff" d="M27 34l18-10-18-10z"/></svg>';
    var vimLogo = '<svg width="54" height="54" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#1ab7ea"/><path fill="#fff" d="M18.5 8.6c-.06 1.3-.97 3.06-2.73 5.3-1.82 2.33-3.36 3.5-4.62 3.5-.78 0-1.44-.72-1.98-2.16l-1.08-3.96c-.4-1.44-.83-2.16-1.29-2.16-.1 0-.45.21-1.05.63l-.63-.81c.66-.58 1.31-1.16 1.95-1.74.88-.76 1.54-1.16 1.98-1.2 1.04-.1 1.68.61 1.92 2.13.26 1.64.44 2.66.54 3.06.3 1.36.63 2.04.99 2.04.28 0 .7-.44 1.26-1.32.56-.88.86-1.55.9-2.01.08-.76-.22-1.14-.9-1.14-.32 0-.65.07-.99.22.66-2.16 1.92-3.21 3.78-3.15 1.38.04 2.03.94 1.95 2.69z"/></svg>';
    a.innerHTML = '<span class="video-badge">' + (isVimeo ? vimLogo : ytLogo) + '</span>'
      + '<span class="video-label">Watch the official video on ' + (isVimeo ? "Vimeo" : "YouTube") + ' \u2197</span>';
    sec.appendChild(a);
    wrap.appendChild(sec);
  }
  // Deeper photos — deliberately DIFFERENT from the first section (shownStoryPhotos are excluded).
  function enrichDeeperMedia(t, wrap) {
    fetch(CFG.API_BASE + "/media?" + new URLSearchParams({ artist: t.artist || "", title: t.title || "", album: t.album || (cur && cur.album) || "", year: t.albumYear || (cur && cur.albumYear) || "", v: "25" }).toString(), { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (curStoryKey !== trackKey(t)) return;
        var items = (d && d.items) || [];
        var seen = {}, imgs = [];
        function add(it) {
          if (!it) return;
          var url = it.url || it.thumb; if (!url) return;
          if (it.type === "photo" && it.w && it.w < 600) return;
          if (shownStoryPhotos[url]) return;                 // not already shown up top
          var base = artBaseUrl(url); if (seen[base]) return; seen[base] = 1;
          imgs.push({ url: url, cap: it.title || t.artist || "", credit: it.credit || "" });
        }
        items.forEach(function (it) { if (it && it.type === "photo") add(it); }); // real band/era photos first
        // Album-era art fallback: photo-scarce eras (e.g. 70s Pink Floyd) can leave "geeek deeper" empty, so
        // fill the remaining slots with the era's album art — the surrounding discography covers — excluding
        // the now-playing album (already shown as the cover up top).
        if (imgs.length < 3) {
          var curAlbumName = (((cur && cur.album) || t.album || "")).toLowerCase().trim();
          items.forEach(function (it) {
            if (imgs.length >= 4) return;
            if (!it || it.type !== "album") return;
            var au = it.url || it.thumb; if (!au) return;
            if ((it.title || "").toLowerCase().trim() === curAlbumName) return; // skip the now-playing album cover
            var ab = artBaseUrl(au); if (seen[ab]) return; seen[ab] = 1;
            imgs.push({ url: au, cap: it.title || "", credit: it.credit || "" });
          });
        }
        imgs = imgs.slice(0, 4);
        if (!imgs.length) return;
        var heads = wrap.querySelectorAll("h3.st-dh:not(.st-recos-h):not(.st-covers-h):not(.st-video-h)");
        imgs.forEach(function (mm, idx) {
          var el = new Image();
          el.className = "st-media-img"; el.decoding = "async"; el.alt = mm.cap || ""; el.style.cursor = "zoom-in";
          el.addEventListener("click", function () { openStoryPhoto(mm.url, (mm.cap || "") + (mm.credit ? " — " + mm.credit : "")); });
          el.onerror = function () {};
          el.onload = function () {
            if (curStoryKey !== trackKey(t)) return;
            var existing = wrap.querySelectorAll("img.st-media-img");
            for (var z = 0; z < existing.length; z++) { if (existing[z] !== el && existing[z].src === el.src) return; }
            var fig = document.createElement("figure"); fig.className = "st-media"; fig.appendChild(el);
            var cap = document.createElement("figcaption"); cap.textContent = mm.cap || "";
            if (mm.credit) { el.title = mm.credit; el.setAttribute("aria-label", (mm.cap || "") + " — " + mm.credit); } // charter v1.1: attribution kept on the image (tooltip) + full-screen view; removed from the visible caption
            fig.appendChild(cap);
            var ref = heads[idx + 1] || null;                 // place before the next section heading when possible
            if (ref && ref.parentNode === wrap) wrap.insertBefore(fig, ref);
            else { var tail = wrap.querySelector(".st-covers, .st-recos"); if (tail) wrap.insertBefore(fig, tail); else wrap.appendChild(fig); } // stay ABOVE Covers / Similar songs
          };
          el.src = mm.url;
        });
      })
      .catch(function () {});
  }

  async function loadDeepDive(track) {
    if (!track) { welcome(); return; }
    var mine = ++loadSeq;
    var cached = cacheGet(track);
    if (cached && cached.cards && cached.cards.length) { if (curTab === "cards") renderCards(cached); return; }
    if (curTab === "cards") skeletonCards();
    var url = CFG.API_BASE + "/deepdive?" + new URLSearchParams({ id: track.id || "", title: track.title || "", artist: track.artist || "" }).toString();
    var attempt = async function () { var res = await fetch(url); if (!res.ok) throw new Error("api " + res.status); return await res.json(); };
    try {
      var data;
      try { data = await attempt(); }
      catch (e1) { await new Promise(function (r) { setTimeout(r, 1500); }); if (mine !== loadSeq) return; data = await attempt(); } // one retry: recover from transient AI/cold-start failures
      if (mine !== loadSeq) return;
      if (curTab === "cards") renderCards(data);
      if (isAi(data)) cacheSet(track, data);
    } catch (e) {
      if (mine !== loadSeq) return;
      if (curTab === "cards") notePanel("Couldn’t load the deep dive right now. Try again in a moment.");
    }
  }

  // ---------- artist media ----------
  async function loadMedia(track) {
    if (!track) { notePanel("Play or search a song first to see the artist’s media."); return; }
    panel.innerHTML = '<div class="soon"><p>Gathering photos and album art…</p></div>';
    try {
      var res = await fetch(CFG.API_BASE + "/media?" + new URLSearchParams({ artist: track.artist || "", title: track.title || "", album: track.album || "", year: track.albumYear || "", v: "25" }).toString(), { cache: "no-store" });
      if (!res.ok) throw 0;
      var d = await res.json();
      var items = (d && d.items) || [];
      if (!items.length) { notePanel("No media found for this artist yet."); return; }
      var discIcon = '<div class="micon"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="1.8"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.2" fill="rgba(255,255,255,.9)" stroke="none"/></svg></div>';
      var camIcon = '<div class="micon"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2.5"/><circle cx="12" cy="13.3" r="3.2"/><path d="M8 7l1.4-2.4h5.2L16 7"/></svg></div>';
      var playBadge = '<div class="mplay"><span><svg viewBox="0 0 24 24" width="14" height="14" fill="#fff"><path d="M8 5v14l11-7z"/></svg></span></div>';
      var grid = '<div class="media-grid">';
      items.forEach(function (it) {
        var isVideo = !!(it.kind === "video" || it.video || (it.type && /video/i.test(it.type)) || (it.url && /youtu|\.mp4|vimeo/i.test(it.url)));
        var hasImg = !!(it.thumb || it.url);
        var bg = hasImg ? ('background-image:url(\'' + esc(it.thumb || it.url) + '\')') : 'background:linear-gradient(160deg,var(--gold),var(--sun-500))';
        grid += '<div class="mtile" data-full="' + esc(it.url) + '" data-cap="' + esc((it.title || "") + (it.credit ? " — " + it.credit : "")) + '" style="' + bg + '">'
          + (hasImg ? "" : (isVideo ? camIcon : discIcon))
          + (isVideo ? playBadge : "")
          + '<div class="mcap">' + esc(it.title || "") + '</div></div>';
      });
      grid += '</div><div class="media-foot" id="media-foot">' + items.length + ' ITEMS · HI-RES</div>';
      panel.innerHTML = grid;
      // Belt-and-suspenders: a tile is a CSS background image, which can't report a 404, so a broken
      // URL would show as an empty box. Probe each tile's image and drop any that fail to load.
      Array.prototype.forEach.call(panel.querySelectorAll(".mtile"), function (tile) {
        var m = (tile.getAttribute("style") || "").match(/url\(['"]?([^'")]+)['"]?\)/);
        var src = (m && m[1]) || tile.getAttribute("data-full");
        if (!src) return;
        var probe = new Image();
        probe.onerror = function () {
          if (tile.parentNode) tile.parentNode.removeChild(tile);
          var foot = panel.querySelector("#media-foot"), left = panel.querySelectorAll(".mtile").length;
          if (foot) foot.textContent = left + " ITEMS · HI-RES";
        };
        probe.src = src;
      });
    } catch (e) { notePanel("Couldn’t load media right now."); }
  }

  // ---------- trivia ----------
  var trivia, TQ = { list: [], i: 0, score: 0, answered: false };
  function resetTrivia() { trivia = { mode: null, subject: "song", game: null, questions: 10, difficulty: "Easy", cats: { song: false, artist: true, era: false, lyrics: false, charts: false } }; }
  function subjLabel() { return trivia.subject === "artist" ? (cur && cur.artist) || "this artist" : (cur && cur.title) || "this song"; }
  function tvBack(to) { return '<button class="tv-back" data-to="' + to + '" style="background:none;border:none;color:#8A7668;cursor:pointer;font-family:inherit;font-size:14px;display:inline-flex;align-items:center;gap:6px;padding:0;margin-bottom:14px"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>Back</button>'; }
  function tvTitle(t) { return '<div style="font-family:var(--round);font-weight:600;font-size:20px;color:var(--faded);margin-bottom:14px">' + t + '</div>'; }
  function tvKicker(t) { return '<div style="font-family:var(--label);font-weight:600;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--sun);margin-bottom:8px">' + t + '</div>'; }
  // full-width mode row (icon · title · sub · arrow); optional LIVE badge
  function modeRow(mode, icon, title, sub, live) {
    return '<button class="tvc tv-mode" data-mode="' + mode + '" style="display:flex;align-items:center;gap:12px;width:100%;background:var(--card2);border:1px solid var(--border2);border-radius:14px;padding:13px 14px;cursor:pointer;text-align:left;color:var(--ink);font-family:inherit">'
      + '<span style="color:var(--sun);flex:none">' + icon + '</span>'
      + '<div style="flex:1"><div style="font-family:var(--round);font-weight:600;font-size:16px;color:var(--ink-hi)">' + title
      + (live ? ' <span style="font-family:var(--label);font-weight:700;font-size:8px;letter-spacing:.1em;color:#1A0B05;background:var(--sun-300);border-radius:999px;padding:2px 6px;vertical-align:middle">LIVE</span>' : '')
      + '</div><div style="color:var(--muted);font-size:12px;margin-top:1px">' + sub + '</div></div>'
      + '<span style="color:var(--dim);font-size:18px">→</span></button>';
  }
  function tvRow(cls, data, title, sub) {
    return '<button class="tvopt ' + cls + '" ' + data + ' style="display:flex;align-items:center;gap:12px;width:100%;background:var(--card2);border:1px solid var(--border2);border-radius:12px;padding:13px 14px;cursor:pointer;text-align:left;color:var(--ink);font-family:inherit;margin-bottom:10px"><div style="flex:1"><div style="font-weight:700;font-size:15px;color:var(--ink-hi)">' + title + '</div><div style="color:var(--muted);font-size:13px">' + sub + '</div></div><span style="color:var(--dim);font-size:18px">→</span></button>';
  }
  function tvWide(data, title, sub) {
    return '<button class="tvopt tv-game" ' + data + ' style="display:flex;align-items:center;gap:14px;width:100%;background:var(--card2);border:1px solid var(--border2);border-radius:14px;padding:15px 16px;cursor:pointer;text-align:left;color:var(--ink);font-family:inherit;margin-bottom:10px"><div style="flex:1"><div style="font-family:var(--round);font-weight:600;font-size:18px;color:var(--ink-hi)">' + title + '</div><div style="color:var(--muted);font-size:13px;line-height:1.45;margin-top:2px">' + sub + '</div></div><span style="color:var(--dim);font-size:20px">→</span></button>';
  }
  var personSvg = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7z"/></svg>';
  var peopleSvg = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><circle cx="9" cy="8" r="3.4"/><path d="M2.5 19.5c0-3.4 2.9-5.6 6.5-5.6s6.5 2.2 6.5 5.6z"/><circle cx="17.5" cy="8.5" r="2.7"/><path d="M16 13.9c.5-.1 1-.1 1.5-.1 3 0 5 2 5 4.9h-4"/></svg>';
  var globeSvg = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9.2"/><path d="M2.9 12h18.2"/><path d="M12 2.8c2.5 2.5 3.9 5.8 3.9 9.2s-1.4 6.7-3.9 9.2c-2.5-2.5-3.9-5.8-3.9-9.2S9.5 5.3 12 2.8z"/></svg>';

  function renderTrivia(step) {
    if (!cur) { notePanel("Play or search a song first, then quiz yourself on it."); return; }
    var h = "";
    if (step === "mode") {
      // three options as full-width rows; "Global contests" carries a LIVE badge (no orange frame)
      h = tvTitle("How do you want to play?")
        + '<div style="display:flex;flex-direction:column;gap:10px">'
        + modeRow("solo", personSvg, "Play solo", "Beat the clock on your own.")
        + modeRow("friends", peopleSvg, "Play with friends", "Share a room code — answer live.")
        + modeRow("contest", globeSvg, "Global contests", "Take on an artist’s superfans.", true)
        + '</div>';
    } else if (step === "subject") {
      h = tvBack("mode") + tvTitle("Pick a song or playlist")
        + tvRow("tv-subject", 'data-subj="song"', "Now playing", esc((cur.title || "") + " · " + (cur.artist || "")))
        + tvRow("tv-subject", 'data-subj="artist"', "This artist", esc((cur.artist || "this artist") + " — every era"))
        + '<div style="font-family:var(--label);font-weight:600;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:4px 0 10px">Or pick a playlist <span class="preview-chip">preview</span></div>'
        + tvRow("tv-pl", '', "70s Rock Classics", "48 songs")
        + tvRow("tv-pl", '', "Road Trip", "32 songs");
    } else if (step === "game") {
      // two box-border full-width buttons: Best score (filled), Advanced (outlined)
      h = tvBack("subject") + tvTitle("What kind of game?")
        + '<div style="display:flex;flex-direction:column;gap:12px">'
        + '<button class="tv-game" data-game="best" style="box-sizing:border-box;width:100%;padding:15px;border:none;border-radius:12px;text-align:center;background:linear-gradient(180deg,var(--sun-300),var(--sun-500));color:var(--on-accent);font-family:var(--sans);font-weight:700;font-size:17px;cursor:pointer">Best score</button>'
        + '<button class="tv-game" data-game="advanced" style="box-sizing:border-box;width:100%;padding:15px;border:1px solid var(--border2);border-radius:12px;text-align:center;background:none;color:var(--ink-hi);font-family:var(--sans);font-weight:700;font-size:17px;cursor:pointer">Advanced</button>'
        + '</div>';
    } else if (step === "advanced") {
      h = tvBack("game") + tvTitle("Advanced setup") + advControls() + '<button class="tv-start btn-primary">Start game</button>';
    } else if (step === "ready") {
      h = tvBack("game") + tvTitle("Ready?")
        + '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px">' + ["Solo", subjLabel(), trivia.questions + " questions · " + trivia.difficulty].map(function (c) { return '<span style="background:var(--card2);border:1px solid var(--border2);border-radius:999px;padding:7px 12px;font-size:11px;color:var(--ink);font-family:var(--label);font-weight:600">' + esc(c) + '</span>'; }).join("") + '</div>'
        + '<button class="tv-start btn-primary">Start game</button>';
    }
    panel.innerHTML = h;
    if (step === "advanced") { var r = $("tv-q-range"); if (r) r.addEventListener("input", function () { trivia.questions = +this.value; $("tv-q-out").textContent = this.value; }); }
  }
  function advControls() {
    var s = '<div style="margin-bottom:16px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span style="font-size:14px;color:var(--muted)">Number of questions</span><span id="tv-q-out" style="font-family:var(--label);color:var(--sun-300);font-weight:700">' + trivia.questions + '</span></div><input id="tv-q-range" type="range" min="5" max="15" step="1" value="' + trivia.questions + '" style="width:100%;accent-color:#FF8A4D"></div>';
    s += '<div style="margin-bottom:16px"><div style="font-size:14px;color:var(--muted);margin-bottom:8px">Difficulty</div><div style="display:flex;gap:8px">';
    ["Easy", "Medium", "Hard"].forEach(function (d) { var on = trivia.difficulty === d; s += '<button class="tv-diff" data-diff="' + d + '" style="flex:1;padding:10px;border-radius:10px;cursor:pointer;font-family:inherit;font-weight:600;font-size:14px;border:1px solid ' + (on ? "transparent" : "var(--border2)") + ';background:' + (on ? "linear-gradient(180deg,#FFB14D,#FF8A4D)" : "var(--card)") + ';color:' + (on ? "var(--on-accent)" : "var(--ink)") + '">' + d + '</button>'; });
    s += '</div></div><div style="margin-bottom:18px"><div style="font-size:14px;color:var(--muted);margin-bottom:8px">Categories</div><div style="display:flex;flex-wrap:wrap;gap:8px">';
    [["song", "The song"], ["artist", "The artist"], ["era", "The era"], ["lyrics", "Lyrics"], ["charts", "Chart history"]].forEach(function (c) { var on = trivia.cats[c[0]]; s += '<button class="tv-cat" data-cat="' + c[0] + '" style="padding:8px 13px;border-radius:999px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:600;border:1px solid ' + (on ? "transparent" : "var(--border2)") + ';background:' + (on ? "linear-gradient(180deg,#FFB14D,#FF8A4D)" : "var(--card)") + ';color:' + (on ? "var(--on-accent)" : "var(--muted)") + '">' + c[1] + '</button>'; });
    return s + '</div></div>';
  }
  // ---- trivia preview screens (contests / friends / leaderboard / live question) ----
  function previewChip() { return '<span class="preview-chip">preview</span>'; }
  function contestRow(artist, sub) {
    return '<button class="tv-contest" data-artist="' + esc(artist) + '" style="display:flex;align-items:center;gap:12px;width:100%;background:var(--card2);border:1px solid var(--border2);border-radius:12px;padding:12px 13px;margin-bottom:9px;cursor:pointer;text-align:left;color:var(--ink);font-family:inherit">'
      + '<span style="width:36px;height:36px;border-radius:9px;flex:none;background:linear-gradient(160deg,var(--gold),#FF7A3C)"></span>'
      + '<div style="flex:1"><div style="font-weight:700;font-size:14px;color:var(--ink-hi)">' + esc(artist) + '</div><div style="color:var(--muted);font-size:12px">' + esc(sub) + '</div></div>'
      + '<span style="font-family:var(--label);font-weight:700;font-size:8px;letter-spacing:.1em;color:#0c3a22;background:var(--live);border-radius:999px;padding:3px 7px">LIVE</span></button>';
  }
  function renderContestPick() {
    panel.innerHTML = tvBack("mode") + tvKicker("Worldwide contest " + previewChip())
      + contestRow("The Beatles", "12,480 fans competing")
      + contestRow("Rush", "3,210 fans competing")
      + contestRow("Pink Floyd", "7,940 fans competing")
      + contestRow("Grateful Dead", "5,070 fans competing")
      + '<div style="font-family:var(--label);font-weight:600;font-size:9px;letter-spacing:.1em;color:var(--faint);margin-top:4px">NEW ARTIST CONTESTS OPEN EVERY WEEK</div>';
  }
  function renderFriends() {
    panel.innerHTML = tvBack("mode") + tvTitle("Play with friends " + previewChip())
      + '<div class="soon" style="padding:18px 6px"><p>Live multiplayer rooms — share a code, everyone answers the same questions in real time. Coming in a later phase.</p></div>';
  }
  function lbRow(rank, name, pts, top) {
    var you = name === "You";
    return '<div class="lb-rank"><span class="rk' + (top ? " top" : "") + '">' + rank + '</span><span class="nm' + (you ? " you" : "") + '">' + esc(name) + '</span><span class="pt">' + esc(pts) + '</span></div>';
  }
  function renderLeaderboard(artist) {
    panel.innerHTML = tvBack("mode") + tvKicker("Worldwide contest · this week " + previewChip())
      + '<div style="font-family:var(--round);font-weight:600;font-size:22px;color:var(--ink-hi)">' + esc(artist) + ' superfans</div>'
      + '<div style="color:var(--muted);font-size:13px;margin:3px 0 14px">12,480 fans competing · 50 hard questions · resets weekly</div>'
      + '<div style="background:var(--card2);border:1px solid var(--border);border-radius:14px;padding:13px 15px;margin-bottom:14px">'
      + '<div style="font-family:var(--label);font-weight:600;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin-bottom:9px">Global leaderboard</div>'
      + lbRow("1", "vinyl_vagabond", "9,840", true)
      + lbRow("2", "strawberry_fields", "9,610", false)
      + lbRow("3", "tom_sawyer_2112", "9,420", false)
      + '<div style="border-top:1px dashed var(--border2);margin:8px 0"></div>'
      + lbRow("—", "You", "not entered", false)
      + '</div><button class="tv-enter btn-primary">Enter contest</button>';
  }
  function renderLiveQuestion() {
    // resting state of a live question — an answered round (one wrong red, correct green)
    function opt(t, state) {
      var bc = state === "ok" ? "#54C98A" : state === "no" ? "#FF5A4A" : "var(--border2)";
      var bg = state === "ok" ? "rgba(84,201,138,.18)" : state === "no" ? "rgba(255,90,74,.16)" : "var(--card)";
      var col = state === "ok" ? "#EAF7EF" : "var(--ink)";
      return '<div style="padding:12px 13px;border:1px solid ' + bc + ';border-radius:10px;background:' + bg + ';color:' + col + ';font-size:14px;text-align:left">' + esc(t) + '</div>';
    }
    panel.innerHTML = tvBack("mode")
      + '<div style="display:flex;justify-content:space-between;align-items:center;font-family:var(--label);font-weight:600;color:var(--dim);font-size:10px;letter-spacing:.08em;margin-bottom:12px"><span>QUESTION 1 / 10 · MEDIUM ' + previewChip() + '</span><span style="color:var(--sun-300)">SCORE 0</span></div>'
      + '<div style="font-weight:700;font-size:17px;color:var(--ink-hi);margin-bottom:14px;line-height:1.3">Which 1975 album features “Bohemian Rhapsody”?</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:9px">' + opt("A Night at the Opera", "ok") + opt("Sheer Heart Attack", "no") + opt("A Day at the Races", "") + opt("News of the World", "") + '</div>'
      + '<div style="text-align:center;margin-top:14px;font-family:var(--label);font-weight:600;color:var(--live);font-size:11px;letter-spacing:.1em">CORRECT · +100</div>';
  }

  function startTriviaGame() {
    panel.innerHTML = '<div class="soon"><h3>Writing your questions…</h3><p>geeek is building a set about ' + esc(subjLabel()) + '.</p></div>';
    var cats = Object.keys(trivia.cats).filter(function (k) { return trivia.cats[k]; }).join(",");
    var params = new URLSearchParams({ title: cur.title || "", artist: cur.artist || "", subject: trivia.subject, difficulty: trivia.difficulty, count: String(trivia.questions), cats: cats });
    fetch(CFG.API_BASE + "/trivia?" + params.toString()).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.questions || !d.questions.length) throw 0;
      TQ = { list: d.questions, i: 0, score: 0, answered: false };
      renderQuestion();
    }).catch(function () { panel.innerHTML = comingSoonHTML("Trivia", "Couldn’t generate questions right now — try again in a moment."); });
  }
  function renderQuestion() {
    var q = TQ.list[TQ.i];
    TQ.answered = false;
    var opts = q.options.map(function (t, i) { return '<button class="tq-opt" data-i="' + i + '" style="padding:12px 14px;border:1px solid var(--border2);border-radius:10px;background:var(--card);color:var(--ink);cursor:pointer;font-family:inherit;font-size:15px;text-align:left">' + esc(t) + '</button>'; }).join("");
    panel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;font-family:var(--label);font-weight:600;color:var(--dim);font-size:11px;letter-spacing:.08em;margin-bottom:12px"><span>QUESTION ' + (TQ.i + 1) + ' / ' + TQ.list.length + ' · ' + trivia.difficulty.toUpperCase() + '</span><span style="color:var(--sun-300)">SCORE ' + TQ.score + '</span></div>'
      + '<div style="font-weight:700;font-size:18px;color:var(--ink-hi);margin-bottom:14px">' + esc(q.q) + '</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' + opts + '</div>'
      + '<div id="tq-foot" style="margin-top:14px;min-height:24px"></div>';
  }
  function answerQuestion(idx) {
    if (TQ.answered) return; TQ.answered = true;
    var q = TQ.list[TQ.i];
    var btns = panel.querySelectorAll(".tq-opt");
    btns.forEach(function (b, i) {
      if (i === q.correct) { b.style.borderColor = "#54C98A"; b.style.background = "rgba(84,201,138,.16)"; }
      else if (i === idx) { b.style.borderColor = "#FF5A4A"; b.style.background = "rgba(255,90,74,.16)"; }
    });
    if (idx === q.correct) TQ.score++;
    var last = TQ.i >= TQ.list.length - 1;
    var note = q.note ? '<div style="color:var(--muted);font-size:13px;margin-bottom:10px;line-height:1.5">' + esc(q.note) + '</div>' : "";
    $("tq-foot").innerHTML = note + '<button class="tq-next btn-primary">' + (last ? "See score" : "Next question") + '</button>';
  }
  function triviaResults() {
    panel.innerHTML = '<div class="soon"><span class="soon-badge">' + TQ.score + ' / ' + TQ.list.length + '</span><h3>' + (TQ.score === TQ.list.length ? "Flawless!" : TQ.score >= TQ.list.length * 0.6 ? "Nicely done." : "Keep digging.") + '</h3><p>You scored ' + TQ.score + ' out of ' + TQ.list.length + ' on ' + esc(subjLabel()) + '.</p><button class="tv-again btn-primary" style="max-width:260px;margin-top:6px">Play again</button></div>';
  }

  // ---------- tabs ----------
  var HINTS = { cards: "The story behind what’s playing", songs: "Songs that share its DNA", artists: "Artists similar to the one playing", trivia: "", media: "Media", shazam: "Listen to discover what’s playing around you", karaoke: "" };
  function setActiveTab(name) {
    curTab = name;
    Array.prototype.forEach.call(tabsEl.querySelectorAll(".gk-tab"), function (b) { b.classList.toggle("active", b.getAttribute("data-tab") === name); });
    // karaoke is a full-screen lyrics experience — no hero on this screen
    if (name === "karaoke") { renderKaraoke(); return; }
    closeKaraoke();
    hint.textContent = HINTS[name] || "";
    renderTab(name);
  }

  // ---- demo list rows (songs / artists) ----
  function demoRow(grad, title, sub, action) {
    return '<div class="lrow"><div class="av" style="background:' + grad + '"></div>'
      + '<div style="flex:1;min-width:0"><div class="lt">' + esc(title) + '</div><div class="ls">' + esc(sub) + '</div></div>'
      + '<div class="la">' + action + '</div></div>';
  }
  function renderSongs() {
    panel.innerHTML = '<div style="text-align:right;margin:-6px 0 4px"><span class="preview-chip">preview</span></div>'
      + demoRow("linear-gradient(180deg,#FFC64B,#FF8A4D)", "Somebody to Love", "Queen · 1976", "Explore →")
      + demoRow("linear-gradient(180deg,#FF9F4D,#FF5A3C)", "November Rain", "Guns N’ Roses · 1991", "Explore →")
      + demoRow("linear-gradient(180deg,#FFB14D,#FF7A4D)", "Life on Mars?", "David Bowie · 1971", "Explore →");
  }
  function renderArtists() {
    panel.innerHTML = '<div style="text-align:right;margin:-6px 0 4px"><span class="preview-chip">preview</span></div>'
      + demoRow("linear-gradient(180deg,#FFC64B,#FF9F4D)", "David Bowie", "Glam · art rock", "Explore →")
      + demoRow("linear-gradient(180deg,#FF9F4D,#FF7A4D)", "Electric Light Orchestra", "Symphonic rock", "Explore →")
      + demoRow("linear-gradient(180deg,#FF6A6A,#FF3C5A)", "Elton John", "Piano rock", "Explore →");
  }

  // ---- shazam (demo) ----
  function renderShazam() {
    panel.innerHTML = '<div style="text-align:right;margin:-6px 0 2px"><span class="preview-chip">preview</span></div>'
      + '<div class="shz-wrap">'
      + '<button class="shz-btn" id="gk-shz-btn" aria-label="Tap to Shazam"><svg viewBox="0 0 24 24" width="46" height="46" fill="none" stroke="#9C8979" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14.2 8.4c-1.6-1-3.7-.7-4.8.8-.7 1-.4 2.2.7 2.9l2.3 1.4c1.1.7 1.4 1.9.7 2.9-1.1 1.5-3.2 1.8-4.8.8"/></svg></button>'
      + '<div class="shz-label" id="gk-shz-label">Tap to Shazam</div>'
      + '<div class="shz-sub">geeek listens for a few seconds, identifies the song playing around you, and dives straight in.</div>'
      + '<div id="gk-shz-result" style="width:100%;margin-top:4px"></div></div>';
  }
  function shazamDemo() {
    var label = $("gk-shz-label"); var result = $("gk-shz-result");
    if (!label) return;
    label.textContent = "Listening…";
    if (result) result.innerHTML = "";
    setTimeout(function () {
      if (curTab !== "shazam") return;
      label.textContent = "Found it";
      if (result) result.innerHTML = demoRow("linear-gradient(160deg,#FFC64B,#FF8A4D)", "Don’t Stop Me Now", "Queen · 1978", "Dive in →");
    }, 1600);
  }

  // ---- karaoke (full-screen auto-scrolling lyrics, demo) ----
  var KAR = { stage: null, i: 0, vocal: false, timer: null };
  var KAR_LINES = [
    "the needle drops and the room goes still",
    "a hush, then the first warm chord",
    "you feel it rising in your chest",
    "now the words arrive — sing them out",
    "every line glows as it comes",
    "the chorus opens up the sky",
    "hands in the air, voices as one",
    "the bridge pulls it all back home",
    "one last breath before the end",
    "let the final note ring out"
  ];
  function stopKar() { if (KAR.timer) { clearInterval(KAR.timer); KAR.timer = null; } }
  function closeKaraoke() { stopKar(); if (KAR.stage && KAR.stage.parentNode) { KAR.stage.parentNode.removeChild(KAR.stage); KAR.stage = null; } document.body.classList.remove("kar-on"); }
  function renderKaraoke() {
    closeKaraoke();
    document.body.classList.add("kar-on");
    KAR.i = 0;
    var micSvg = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"><rect x="9" y="2.5" width="6" height="11.5" rx="3" fill="currentColor" stroke="none"/><path d="M6 11a6 6 0 0 0 12 0"/><line x1="12" y1="17.5" x2="12" y2="21"/><line x1="8.5" y1="21" x2="15.5" y2="21"/></svg>';
    var stage = document.createElement("div");
    stage.className = "kar-stage";
    stage.innerHTML = '<div class="kar-top"><div class="kar-title"><button class="kar-back" id="kar-back" aria-label="Back to app"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg></button><span style="color:var(--sun)">' + micSvg + '</span><b>Karaoke</b><span class="preview-chip" style="margin-left:6px">preview</span></div>'
      + '<button class="kar-toggle" id="kar-toggle"><span class="ktxt">Go vocal-less</span><span class="kar-track"><span class="kar-knob"></span></span></button></div>'
      + '<div class="kar-lyrics" id="kar-lyrics"><div class="kar-scroll" id="kar-scroll"></div></div>';
    document.body.appendChild(stage);
    KAR.stage = stage;
    var kb = $("kar-back"); if (kb) kb.addEventListener("click", function () { setActiveTab("cards"); });
    buildLyrics();
    requestAnimationFrame(function () { requestAnimationFrame(highlightLyric); }); // center after layout
    KAR.timer = setInterval(advanceLyric, 2700);
    $("kar-toggle").addEventListener("click", function () {
      KAR.vocal = !KAR.vocal;
      this.classList.toggle("on", KAR.vocal);
      this.querySelector(".ktxt").textContent = KAR.vocal ? "Vocals off" : "Go vocal-less";
    });
  }
  function buildLyrics() {
    var scroll = $("kar-scroll"); if (!scroll) return;
    scroll.innerHTML = KAR_LINES.map(function (t) { return '<div class="kline">' + esc(t) + '</div>'; }).join("");
  }
  function highlightLyric() {
    var scroll = $("kar-scroll"); if (!scroll) return;
    var lines = scroll.children;
    for (var i = 0; i < lines.length; i++) lines[i].classList.toggle("on", i === KAR.i);
    var act = lines[KAR.i];
    if (act) scroll.style.transform = "translateY(" + (-(act.offsetTop + act.offsetHeight / 2)) + "px)";
  }
  function advanceLyric() { KAR.i = (KAR.i + 1) % KAR_LINES.length; highlightLyric(); }

  function renderTab(name) {
    if (name === "cards") { cur ? loadDeepDive(cur) : welcome(); }
    else if (name === "songs") { renderSongs(); }
    else if (name === "artists") { renderArtists(); }
    else if (name === "trivia") { resetTrivia(); renderTrivia("mode"); }
    else if (name === "media") { cur ? loadMedia(cur) : notePanel("Play or search a song first to see the artist’s media."); }
    else if (name === "shazam") { renderShazam(); }
  }

  // ---------- polling ----------
  async function poll() {
    try {
      var track = await P.getActivePlayer().getCurrentTrack();
      if (track && track.noActiveDevice) {
        // Spotify has no active device (playback paused/stopped, e.g. on the desktop app) — reflect PAUSED
        // in the button/icon without wiping the current song, so the app stays in sync with Spotify.
        if (playing) { playing = false; pstate.playing = false; pstate.at = Date.now(); setPlayIcon(false); }
        return;
      }
      if (track) setModeButtons(track.shuffle, track.repeat); // reflect real shuffle/repeat every poll
      if (track && track.id && track.id !== lastPlayingId) {
        lastPlayingId = track.id; manualMode = false; cur = track;
        refreshLike(track.id);
        try { window.scrollTo({ top: 0, behavior: "auto" }); } catch (e) { window.scrollTo(0, 0); } // new song -> back to the top (don't leave the reader on a stale/blank scroll)
        pstate = { progressMs: track.progressMs || 0, durationMs: track.durationMs || 0, playing: !!track.isPlaying, at: Date.now() };
        playing = !!track.isPlaying; setPlayIcon(playing); tickProgress();
        setHero(track); updateShareLink(track); updateLightboxLive(track);
        if (curTab === "cards") loadDeepDive(track);
        else if (curTab === "media") loadMedia(track);
      } else if (!manualMode) {
        if (track) {
          pstate = { progressMs: track.progressMs || 0, durationMs: track.durationMs || 0, playing: !!track.isPlaying, at: Date.now() };
          playing = !!track.isPlaying; setPlayIcon(playing); tickProgress(); setHero(track); updateShareLink(track); updateLightboxLive(track);
          if (!cur) cur = track;
        } else if (!cur) { setHero(null); pstate = { progressMs: 0, durationMs: 0, playing: false, at: Date.now() }; setProgress(0, 0); setPlayIcon(false); }
      }
    } catch (e) { console.warn("poll", e); }
  }
  function startPolling() { if (pollTimer) clearInterval(pollTimer); poll(); pollTimer = setInterval(poll, CFG.POLL_MS); }

  // ---------- manual search ----------
  function diveWith(title, artist, art) {
    title = (title || "").trim(); if (!title) return;
    hideSuggest(); closePanels();
    var AMm = window.SDD && window.SDD.appleMusic;
    if (AMm && AMm.isAuthorized && AMm.isAuthorized()) { try { AMm.playQuery(artist ? (title + " " + artist) : title); } catch (e) {} }
    manualMode = true;
    cur = { id: "", title: title, artist: artist || "", art: art || "" };
    refreshLike("");
    setHero(cur); updateShareLink(cur);
    pstate = { progressMs: 0, durationMs: 0, playing: false, at: Date.now() }; setProgress(0, 0); setPlayIcon(false);
    setActiveTab("cards");
  }
  var suggestTimer = null, suggestItems = [], activeIdx = -1, sIn, sList;
  function hideSuggest() { if (!sList) return; sList.classList.add("hidden"); sList.innerHTML = ""; suggestItems = []; activeIdx = -1; sIn.setAttribute("aria-expanded", "false"); }
  function renderSuggest(items) {
    suggestItems = items; activeIdx = -1;
    if (!items.length) { hideSuggest(); return; }
    sList.innerHTML = "";
    items.forEach(function (it) {
      var li = document.createElement("li"); li.setAttribute("role", "option");
      li.innerHTML = '<img alt=""><div><div class="st"></div><div class="sa"></div></div>';
      li.querySelector("img").src = it.art || ""; li.querySelector(".st").textContent = it.title; li.querySelector(".sa").textContent = it.artist;
      li.addEventListener("mousedown", function (e) { e.preventDefault(); sIn.value = it.title; diveWith(it.title, it.artist, it.art); });
      sList.appendChild(li);
    });
    sList.classList.remove("hidden"); sIn.setAttribute("aria-expanded", "true");
  }
  async function fetchSuggest(term) {
    try { var res = await fetch(CFG.API_BASE + "/suggest?term=" + encodeURIComponent(term)); if (!res.ok) return; var d = await res.json(); if ((sIn.value || "").trim() === term) renderSuggest((d && d.suggestions) || []); } catch (e) {}
  }
  function onSearchInput() { var term = (sIn.value || "").trim(); if (suggestTimer) clearTimeout(suggestTimer); if (term.length < 2) { hideSuggest(); return; } suggestTimer = setTimeout(function () { fetchSuggest(term); }, 250); }
  function onSearchKey(e) {
    var open = sList && !sList.classList.contains("hidden");
    if (!open) { if (e.key === "Enter") diveWith(sIn.value, "", ""); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, suggestItems.length - 1); hl(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); hl(); }
    else if (e.key === "Enter") { e.preventDefault(); if (activeIdx >= 0 && suggestItems[activeIdx]) { var it = suggestItems[activeIdx]; sIn.value = it.title; diveWith(it.title, it.artist, it.art); } else diveWith(sIn.value, "", ""); }
    else if (e.key === "Escape") hideSuggest();
  }
  function hl() { var lis = sList.querySelectorAll("li"); for (var i = 0; i < lis.length; i++) lis[i].classList.toggle("active", i === activeIdx); }

  // ---------- panels: search / share / setup ----------
  function closePanels() { $("gk-search").classList.remove("open"); $("gk-share").classList.remove("open"); var sc = $("gk-share-scrim"); if (sc) sc.classList.remove("open"); }
  function togglePanel(id) { var open = $(id).classList.contains("open"); closePanels(); if (!open) { $(id).classList.add("open"); if (id === "gk-share") { var sc = $("gk-share-scrim"); if (sc) sc.classList.add("open"); } if (id === "gk-search") setTimeout(function () { sIn && sIn.focus(); }, 30); } }
  function showSetup(on) { $("gk-main").classList.toggle("hidden", on); $("gk-setup").classList.toggle("hidden", !on); if (on) closePanels(); }

  function refreshSetup() {
    var sp = document.querySelector('.gk-connect[data-svc="spotify"]');
    if (sp) { var on = S.isConnected(); sp.querySelector(".lbl").textContent = on ? "Connected to Spotify ✓" : "Connect Spotify"; sp.style.borderColor = on ? "#54C98A" : "var(--border2)"; sp.querySelector(".chev").textContent = on ? "✓" : "→"; }
    var ap = document.querySelector('.gk-connect[data-svc="apple"]');
    if (ap) { var aon = AM && AM.isAuthorized && AM.isAuthorized(); ap.querySelector(".lbl").textContent = aon ? "Connected to Apple Music ✓" : "Connect Apple Music"; ap.style.borderColor = aon ? "#54C98A" : "var(--border2)"; ap.querySelector(".chev").textContent = aon ? "✓" : "→"; }
  }
  function onConnect(svc) {
    if (svc === "spotify") { if (S.isConnected()) { S.logout(); location.reload(); } else { S.login(); } }
    else if (svc === "apple") { if (AM && AM.connect) { AM.connect().then(refreshSetup); } else { $("gk-setup-note").textContent = "Apple Music sign-in is being finalized — check back soon."; } }
    else if (svc === "shazam") { $("gk-setup-note").textContent = "Shazam recognition is native-only and ships with the iOS app."; }
  }

  // ---------- lightbox ----------
  var stLb = null;
  function openStoryPhoto(url, caption) {
    if (!url) return;
    if (!stLb) {
      stLb = document.createElement("div");
      stLb.className = "st-lb";
      stLb.innerHTML = '<img alt=""><div class="cap"></div>';
      stLb.addEventListener("click", function () { stLb.classList.remove("open"); });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape" && stLb) stLb.classList.remove("open"); });
      document.body.appendChild(stLb);
    }
    stLb.querySelector("img").src = url;
    stLb.querySelector(".cap").textContent = caption || "";
    stLb.classList.add("open");
  }
  function openLightbox(url, title, sub) {
    $("gk-lb-img").style.backgroundImage = url ? ('url("' + url + '")') : "";
    $("gk-lb-title").textContent = title || (cur && cur.title) || "";
    $("gk-lb-sub").textContent = sub || (cur && cur.artist) || "";
    $("gk-lightbox").classList.add("open");
    setPlayIcon(playing); // reflect current play/pause state on open
  }
  function lightboxOpen() { var lb = $("gk-lightbox"); return !!(lb && lb.classList.contains("open")); }
  // Keep the open cover lightbox in sync with the live track (e.g. after next/prev).
  function updateLightboxLive(t) {
    if (!t || !lightboxOpen()) return;
    if (t.art) $("gk-lb-img").style.backgroundImage = 'url("' + t.art + '")';
    $("gk-lb-title").textContent = t.title || "";
    $("gk-lb-sub").textContent = t.artist || "";
  }

  // ---------- transport ----------
  function flashPmsg(t) { var e = $("gk-pmsg"); if (!e) return; e.textContent = t; e.classList.add("show"); clearTimeout(e._t); e._t = setTimeout(function () { e.classList.remove("show"); }, 4200); }
  async function transport(action) {
    if (!S.isConnected()) { showSetup(true); refreshSetup(); return; }
    var ok = false;
    try {
      if (action === "toggle") {
        // Read the REAL state first (local `playing` can be POLL_MS stale after an external pause), then flip
        // the icon optimistically so the tap feels instant, and reconcile if the command actually fails.
        var _t = await P.getActivePlayer().getCurrentTrack();
        var _isP = _t ? !!_t.isPlaying : playing;
        playing = !_isP; setPlayIcon(playing); pstate.playing = playing; pstate.at = Date.now();
        ok = await (_isP ? CTRL.pause() : CTRL.play());
        if (!ok) { playing = _isP; setPlayIcon(playing); pstate.playing = playing; }
      }
      else if (action === "next") { ok = await CTRL.next(); }
      else if (action === "prev") { ok = await CTRL.prev(); }
      else if (action === "shuffle") {
        var rs = CTRL.toggleShuffle ? await CTRL.toggleShuffle() : { ok: false };
        ok = rs.ok;
        if (ok) { var on = !!rs.state; $("gk-shuffle") && $("gk-shuffle").classList.toggle("on", on); var ls = $("gk-lb-shuffle"); ls && ls.classList.toggle("on", on); }
      }
      else if (action === "repeat") {
        var rr = CTRL.cycleRepeat ? await CTRL.cycleRepeat() : { ok: false };
        ok = rr.ok;
        if (ok) { var ron = !!(rr.state && rr.state !== "off"); ["gk-repeat", "gk-lb-repeat"].forEach(function (id) { var el = $(id); if (el) { el.classList.toggle("on", ron); el.classList.toggle("one", rr.state === "track"); } }); }
      }
    } catch (e) { ok = false; }
    // shuffle/repeat fail quietly (e.g. no active device); transport buttons surface the hint
    if (!ok && (action === "toggle" || action === "next" || action === "prev")) flashPmsg("Couldn’t reach Spotify playback — open the Spotify app on a device, then try again. (Control needs Spotify Premium.)");
    // Re-poll shortly after any control to reconcile the buttons with Spotify's real state.
    setTimeout(poll, 900);
  }

  function onMobileDevice() { return /iPhone|iPad|iPod|Android|Mobile/i.test((typeof navigator !== "undefined" && navigator.userAgent) || ""); }
  // Play/pause tap. On a phone, RESUMING plays on the phone: an idle iPhone isn't a controllable Spotify
  // device, so we open the current track in the Spotify app (it plays there and becomes the active device,
  // after which geeek controls it directly). Done synchronously from the tap so iOS doesn't block the launch.
  // Pausing, and everything on desktop, use the normal Web API transport.
  function playPause() {
    // A song found via SEARCH (manual mode) isn't playing yet -> START it on Spotify (in-app SDK device when
    // available, else the user's active Spotify device). This is what makes the play button work after a search.
    if (manualMode && cur && cur.title && S.playTrack) {
      if (S.activateSdk) S.activateSdk();                 // within this tap, for mobile autoplay
      playing = true; setPlayIcon(true); pstate.playing = true; pstate.at = Date.now(); // optimistic
      S.playTrack(cur.title, cur.artist).then(function (r) {
        if (r && r.ok) { manualMode = false; setTimeout(poll, 1200); } // now really playing -> let the poll sync it
        else {
          playing = false; setPlayIcon(false); pstate.playing = false;
          flashPmsg((r && r.reason === "no-device") ? "Open Spotify on any device, then press play again." : "Couldn't start that song on Spotify.");
        }
      });
      return;
    }
    // On a phone, RESUME the user's real queue AT POSITION right inside geeek, using geeek's own in-browser
    // Spotify player — no app switch, no restart, queue intact. (Premium + the "streaming" scope; reconnect once.)
    if (!playing && onMobileDevice() && S.sdkAvailable && S.sdkAvailable()) {
      var pr = S.playHere();                 // activateElement() fires within this tap (mobile autoplay policy)
      playing = true; setPlayIcon(true); pstate.playing = true; pstate.at = Date.now();   // optimistic
      pr.then(function (ok) {
        if (ok) { setTimeout(poll, 1200); }
        else { playing = false; setPlayIcon(false); pstate.playing = false; transport("toggle"); }
      });
      return;
    }
    // Phone, connected, but the in-app player needs the new scope — nudge the user to reconnect once.
    if (!playing && onMobileDevice() && S.isConnected() && S.sdkNeedsReconnect && S.sdkNeedsReconnect()) {
      flashPmsg("Reconnect Spotify in ⚙ Setup to play right here in the app.");
    }
    transport("toggle");
  }

  // ---------- init ----------
  function init() {
    panel = $("gk-panel"); hint = $("gk-hint"); tabsEl = $("gk-tabs");
    sIn = $("gk-search-input"); sList = $("gk-suggest");

    // tabs
    Array.prototype.forEach.call(tabsEl.querySelectorAll(".gk-tab"), function (b) { b.addEventListener("click", function () { setActiveTab(b.getAttribute("data-tab")); }); });

    // panel delegation (trivia + media tiles)
    panel.addEventListener("click", function (e) {
      var bk = e.target.closest(".tv-back"); if (bk) { renderTrivia(bk.getAttribute("data-to")); return; }
      var md = e.target.closest(".tv-mode"); if (md) { trivia.mode = md.getAttribute("data-mode"); if (trivia.mode === "solo") renderTrivia("subject"); else if (trivia.mode === "contest") renderContestPick(); else renderFriends(); return; }
      var cr = e.target.closest(".tv-contest"); if (cr) { renderLeaderboard(cr.getAttribute("data-artist") || "The Beatles"); return; }
      var en = e.target.closest(".tv-enter"); if (en) { renderLiveQuestion(); return; }
      var sj = e.target.closest(".tv-subject"); if (sj) { trivia.subject = sj.getAttribute("data-subj"); renderTrivia("game"); return; }
      var gm = e.target.closest(".tv-game"); if (gm) { trivia.game = gm.getAttribute("data-game"); renderTrivia(trivia.game === "advanced" ? "advanced" : "ready"); return; }
      var df = e.target.closest(".tv-diff"); if (df) { trivia.difficulty = df.getAttribute("data-diff"); renderTrivia("advanced"); return; }
      var ct = e.target.closest(".tv-cat"); if (ct) { var c = ct.getAttribute("data-cat"); trivia.cats[c] = !trivia.cats[c]; renderTrivia("advanced"); return; }
      var st = e.target.closest(".tv-start"); if (st) { startTriviaGame(); return; }
      var op = e.target.closest(".tq-opt"); if (op) { answerQuestion(+op.getAttribute("data-i")); return; }
      var nx = e.target.closest(".tq-next"); if (nx) { if (TQ.i >= TQ.list.length - 1) triviaResults(); else { TQ.i++; renderQuestion(); } return; }
      var ag = e.target.closest(".tv-again"); if (ag) { resetTrivia(); renderTrivia("mode"); return; }
      var mt = e.target.closest(".mtile"); if (mt) { openStoryPhoto(mt.getAttribute("data-full"), mt.getAttribute("data-cap")); return; } // plain image viewer — no playback, not overwritten by the poll
      var gdp = e.target.closest("#st-deeper-btn"); if (gdp) { toggleDeeper(); return; }
      var dd = e.target.closest("#ff-deeper"); if (dd) { diveDeeper(); return; }
      var sz = e.target.closest("#gk-shz-btn"); if (sz) { shazamDemo(); return; }
    });

    // header buttons
    $("gk-search-btn").addEventListener("click", function () { togglePanel("gk-search"); });
    $("gk-share-btn").addEventListener("click", function () { togglePanel("gk-share"); });
    $("gk-setup-btn").addEventListener("click", function () { showSetup($("gk-setup").classList.contains("hidden")); refreshSetup(); });
    $("gk-done").addEventListener("click", function () { showSetup(false); });
    Array.prototype.forEach.call(document.querySelectorAll(".gk-connect"), function (b) { b.addEventListener("click", function () { onConnect(b.getAttribute("data-svc")); }); });

    // search
    sIn.addEventListener("input", onSearchInput);
    sIn.addEventListener("keydown", onSearchKey);
    document.addEventListener("click", function (e) { if (sList && !sList.contains(e.target) && e.target !== sIn && !$("gk-search").contains(e.target) && e.target.closest("#gk-search-btn") === null) hideSuggest(); });

    // share: "Send to Maya" copies the real share link (keeps the copy logic accessible)
    $("gk-copy").addEventListener("click", function () {
      var b = this; try { navigator.clipboard && navigator.clipboard.writeText($("gk-link").value); } catch (e) {}
      b.textContent = "Link copied ✓";
      setTimeout(function () { b.textContent = "Send to Maya"; }, 1600);
    });
    // dim scrim closes the share sheet
    $("gk-share-scrim") && $("gk-share-scrim").addEventListener("click", closePanels);

    // transport
    $("gk-playbtn").addEventListener("click", function () { playPause(); this.blur(); });
    $("gk-prev").addEventListener("click", function () { transport("prev"); this.blur(); });
    $("gk-next").addEventListener("click", function () { transport("next"); this.blur(); });
    $("gk-shuffle") && $("gk-shuffle").addEventListener("click", function () { transport("shuffle"); this.blur(); });
    $("gk-repeat") && $("gk-repeat").addEventListener("click", function () { transport("repeat"); this.blur(); });
    $("gk-like") && $("gk-like").addEventListener("click", function () { toggleLike(); this.blur(); });

    // cover + lightbox
    $("gk-cover").addEventListener("click", function () { openLightbox(cur && cur.art, cur && cur.title, cur && cur.artist); });
    $("gk-lightbox").addEventListener("click", function () { $("gk-lightbox").classList.remove("open"); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") $("gk-lightbox").classList.remove("open"); });
    // lightbox playback controls (stop propagation so they don't close the lightbox)
    [["gk-lb-play", "toggle"], ["gk-lb-prev", "prev"], ["gk-lb-next", "next"], ["gk-lb-shuffle", "shuffle"], ["gk-lb-repeat", "repeat"]].forEach(function (p) {
      var el = $(p[0]); if (el) el.addEventListener("click", function (e) { e.stopPropagation(); if (p[1] === "toggle") playPause(); else transport(p[1]); });
    });
    $("gk-lb-like") && $("gk-lb-like").addEventListener("click", function (e) { e.stopPropagation(); toggleLike(); });

    // shared ui hooks for Apple Music provider
    window.SDD.ui = {
      renderNowPlaying: function (t) { if (!t) return; setHero(t); pstate = { progressMs: 0, durationMs: 0, playing: !!t.isPlaying, at: Date.now() }; playing = !!t.isPlaying; setPlayIcon(playing); },
      loadDeepDive: function (t) { manualMode = false; cur = t; updateShareLink(t); if (curTab === "cards") loadDeepDive(t); else if (curTab === "media") loadMedia(t); },
      setStatus: function () {}
    };

    setActiveTab("cards");
    setupStickyPlayer();

    // deep link ?t=&a=
    var qp = new URLSearchParams(location.search);
    var dt = qp.get("t");
    if (dt) { history.replaceState({}, document.title, location.origin + "/"); diveWith(dt, qp.get("a") || "", ""); }

    // spotify
    S.handleRedirect().then(function (ok) {
      if (S.isConnected()) startPolling();
      if (S.initSdkPlayer) S.initSdkPlayer();
      refreshSetup();
    });

    // apple (inert unless /api/amtoken configured)
    if (AM && AM.init) { try { AM.init(window.SDD.ui).then(refreshSetup); } catch (e) {} }
  }

  // Keep the top bar + now-playing controls pinned. The full player shows at the top; once the user scrolls,
  // the hero collapses to a slim bar (small cover + song/artist + prev/play/next + thin progress) locked below
  // the top bar, so playback is always visible & controllable. Works on mobile + desktop (window scroll).
  function setupStickyPlayer() {
    var topbar = document.querySelector(".topbar");
    var hero = document.querySelector(".hero");
    if (!hero) return;
    function setH() { if (topbar) document.documentElement.style.setProperty("--topbar-h", topbar.offsetHeight + "px"); }
    setH();
    window.addEventListener("resize", setH);
    window.addEventListener("resize", function () { if (typeof applyTitleMarquee === "function") applyTitleMarquee(); });
    var ticking = false;
    function onScroll() {
      if (ticking) return; ticking = true;
      requestAnimationFrame(function () {
        var y = window.scrollY || document.documentElement.scrollTop || 0;
        hero.classList.toggle("compact", y > 36);
        applyTitleMarquee();
        ticking = false;
      });
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }
  document.addEventListener("DOMContentLoaded", init);
})();
// build: geeek-deeper