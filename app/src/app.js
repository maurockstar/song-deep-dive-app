// geeek — app bootstrap & UI wiring (v0.8 redesign)
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
  function setHero(t) {
    if (t) {
      $("gk-title").textContent = t.title || "—";
      $("gk-artist").textContent = t.artist || "";
      $("gk-art").style.backgroundImage = t.art ? ('url("' + t.art + '")') : "";
    } else {
      $("gk-title").textContent = "Nothing playing";
      $("gk-artist").textContent = "Connect Spotify or search a song";
      $("gk-art").style.backgroundImage = "";
    }
  }
  function setPlayIcon(on) {
    $("gk-playbtn").innerHTML = on
      ? '<svg viewBox="0 0 24 24" width="26" height="26" fill="#1A0B05"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>'
      : '<svg viewBox="0 0 24 24" width="26" height="26" fill="#1A0B05"><path d="M8 5v14l11-7z"/></svg>';
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
    var st = $("gk-share-title"); if (st) st.textContent = "Send “" + (t.title || "this song") + "” to a friend";
  }

  // ---------- deep-dive cache ----------
  var CACHE_PREFIX = "sdd:cards:v" + ((CFG && CFG.VERSION) || "0") + ":";
  function cacheKey(t) { return CACHE_PREFIX + ((t.title || "") + "|" + (t.artist || "")).toLowerCase().replace(/\s+/g, "_"); }
  function cacheGet(t) { try { var r = localStorage.getItem(cacheKey(t)); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
  function cacheSet(t, p) { try { localStorage.setItem(cacheKey(t), JSON.stringify(p)); } catch (e) {} }
  function isAi(p) { return !!(p && p._meta && typeof p._meta.source === "string" && p._meta.source.indexOf("ai") === 0); }

  // ---------- panels ----------
  function welcome() {
    panel.innerHTML = '<div class="soon"><h3>Geek out about the music you love.</h3><p>Connect Spotify (or search a song) and we’ll surface the story behind it, who made it, and how it connects to everything else — then go live your life.</p></div>';
  }
  function notePanel(text) { panel.innerHTML = '<div class="soon"><p>' + esc(text) + '</p></div>'; }
  function comingSoonHTML(title, desc) {
    return '<div class="soon"><span class="soon-badge">Coming soon</span><h3>' + esc(title) + '</h3><p>' + esc(desc) + '</p></div>';
  }
  function comingSoon(title, desc) { panel.innerHTML = comingSoonHTML(title, desc); }

  function ddCard(c) {
    return '<div class="dd-card"><div class="dd-kicker">' + esc(c.kicker || "") + '</div><div class="dd-title">' + esc(c.title || "") + '</div>'
      + '<div class="dd-scroll"><p class="dd-body">' + esc(c.body || "") + '</p>'
      + (c.extra ? '<div class="dd-extra">' + esc(c.extra) + '</div>' : '') + '</div></div>';
  }
  function skeletonCards(n) {
    var h = '<div class="cards">';
    for (var i = 0; i < n; i++) h += '<div class="dd-card skeleton"><div class="dd-kicker">loading</div><div class="dd-title">Reading the room…</div><div class="dd-scroll"><p class="dd-body">geeek is digging up the story.</p></div></div>';
    panel.innerHTML = h + '</div>';
  }
  function renderCards(payload) {
    var cards = (payload && payload.cards) || [];
    if (!cards.length) { notePanel("No deep dive for this one yet — try another song."); return; }
    panel.innerHTML = '<div class="cards">' + cards.map(ddCard).join("") + '</div>';
  }
  async function loadDeepDive(track) {
    if (!track) { welcome(); return; }
    var mine = ++loadSeq;
    var cached = cacheGet(track);
    if (cached && cached.cards && cached.cards.length) { if (curTab === "cards") renderCards(cached); return; }
    if (curTab === "cards") skeletonCards(4);
    var url = CFG.API_BASE + "/deepdive?" + new URLSearchParams({ id: track.id || "", title: track.title || "", artist: track.artist || "" }).toString();
    try {
      var res = await fetch(url);
      if (!res.ok) throw new Error("api " + res.status);
      var data = await res.json();
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
      var res = await fetch(CFG.API_BASE + "/media?" + new URLSearchParams({ artist: track.artist || "", title: track.title || "" }).toString());
      if (!res.ok) throw 0;
      var d = await res.json();
      var items = (d && d.items) || [];
      if (!items.length) { notePanel("No media found for this artist yet."); return; }
      var grid = '<div class="media-grid">';
      items.forEach(function (it) {
        grid += '<div class="mtile" data-full="' + esc(it.url) + '" data-cap="' + esc(it.title || "") + '" style="background-image:url(\'' + esc(it.thumb || it.url) + '\')"><div class="mcap">' + esc(it.title || "") + '</div></div>';
      });
      grid += '</div><div style="font-family:var(--mono);color:var(--dim);font-size:11px;letter-spacing:.06em;margin-top:14px">' + items.length + ' ITEMS · TAP TO VIEW FULL SCREEN</div>'
        + '<div style="font-family:var(--mono);color:var(--faint);font-size:10px;letter-spacing:.06em;margin-top:6px">VIDEOS COMING WITH THE NEXT PHASE</div>';
      panel.innerHTML = grid;
    } catch (e) { notePanel("Couldn’t load media right now."); }
  }

  // ---------- trivia ----------
  var trivia, TQ = { list: [], i: 0, score: 0, answered: false };
  function resetTrivia() { trivia = { mode: null, subject: "song", game: null, questions: 10, difficulty: "Medium", cats: { song: true, artist: true, era: true, lyrics: false, charts: false } }; }
  function subjLabel() { return trivia.subject === "artist" ? (cur && cur.artist) || "this artist" : (cur && cur.title) || "this song"; }
  function tvBack(to) { return '<button class="tv-back" data-to="' + to + '" style="background:none;border:none;color:#8A7668;cursor:pointer;font-family:inherit;font-size:14px;display:inline-flex;align-items:center;gap:6px;padding:0;margin-bottom:14px"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>Back</button>'; }
  function tvTitle(t) { return '<div style="font-family:var(--round);font-weight:600;font-size:22px;color:var(--ink-hi);margin-bottom:14px">' + t + '</div>'; }
  function tvKicker(t) { return '<div style="font-family:var(--mono);font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--sun);margin-bottom:8px">' + t + '</div>'; }
  function modeCard(mode, icon, title, sub) {
    return '<button class="tvc tv-mode" data-mode="' + mode + '" style="flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:8px;background:var(--card2);border:1px solid var(--border2);border-radius:14px;padding:16px;cursor:pointer;text-align:left;color:var(--ink);font-family:inherit"><span style="color:var(--sun)">' + icon + '</span><span style="font-family:var(--round);font-weight:600;font-size:18px;color:var(--ink-hi)">' + title + '</span><span style="color:var(--muted);font-size:13px;line-height:1.4">' + sub + '</span></button>';
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
      h = tvKicker("Music trivia") + tvTitle("How do you want to play?")
        + '<div style="display:flex;gap:10px">' + modeCard("solo", personSvg, "Play solo", "Beat your own high score against the clock.") + modeCard("friends", peopleSvg, "Play with friends", "Share a room code; everyone answers live.") + '</div>'
        + '<button class="tv-mode" data-mode="contest" style="display:flex;align-items:center;gap:14px;width:100%;margin-top:10px;background:var(--card2);border:2px solid var(--sun-500);border-radius:14px;padding:15px 16px;cursor:pointer;text-align:left;color:var(--ink);font-family:inherit"><span style="color:var(--sun)">' + globeSvg + '</span><div style="flex:1"><div style="font-family:var(--round);font-weight:600;font-size:18px;color:var(--ink-hi)">Worldwide contest</div><div style="color:var(--muted);font-size:13px;margin-top:2px">Compete with an artist’s biggest superfans for the global #1 spot.</div></div><span style="color:var(--dim);font-size:20px">→</span></button>';
    } else if (step === "subject") {
      h = tvBack("mode") + tvTitle("What should the questions be about?")
        + tvRow("tv-subject", 'data-subj="song"', "This song", esc((cur.title || "") + " · " + (cur.artist || "")))
        + tvRow("tv-subject", 'data-subj="artist"', "This artist", esc(cur.artist || ""))
        + '<div style="font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin-top:4px">Playlists arrive with the music-graph engine</div>';
    } else if (step === "game") {
      h = tvBack("subject") + tvKicker("Solo · " + subjLabel()) + tvTitle("What kind of game?")
        + tvWide('data-game="best"', "Best score", "Answer a set of questions about " + esc(subjLabel()) + ". Race the clock for a high score.")
        + tvWide('data-game="advanced"', "Advanced", "Fine-tune length, difficulty and categories.");
    } else if (step === "advanced") {
      h = tvBack("game") + tvTitle("Advanced setup") + advControls() + '<button class="tv-start btn-primary">Start game</button>';
    } else if (step === "ready") {
      h = tvBack("game") + tvTitle("Ready?")
        + '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px">' + ["Solo", subjLabel(), trivia.questions + " questions", trivia.difficulty].map(function (c) { return '<span style="background:var(--card2);border:1px solid var(--border2);border-radius:999px;padding:7px 13px;font-size:12px;color:var(--ink);font-family:var(--mono)">' + esc(c) + '</span>'; }).join("") + '</div>'
        + '<button class="tv-start btn-primary">Start game</button>';
    }
    panel.innerHTML = h;
    if (step === "advanced") { var r = $("tv-q-range"); if (r) r.addEventListener("input", function () { trivia.questions = +this.value; $("tv-q-out").textContent = this.value; }); }
  }
  function advControls() {
    var s = '<div style="margin-bottom:16px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><span style="font-size:14px;color:var(--muted)">Number of questions</span><span id="tv-q-out" style="font-family:var(--mono);color:var(--sun-300);font-weight:700">' + trivia.questions + '</span></div><input id="tv-q-range" type="range" min="5" max="15" step="1" value="' + trivia.questions + '" style="width:100%;accent-color:#FF8A4D"></div>';
    s += '<div style="margin-bottom:16px"><div style="font-size:14px;color:var(--muted);margin-bottom:8px">Difficulty</div><div style="display:flex;gap:8px">';
    ["Easy", "Medium", "Hard"].forEach(function (d) { var on = trivia.difficulty === d; s += '<button class="tv-diff" data-diff="' + d + '" style="flex:1;padding:10px;border-radius:10px;cursor:pointer;font-family:inherit;font-weight:600;font-size:14px;border:1px solid ' + (on ? "transparent" : "var(--border2)") + ';background:' + (on ? "linear-gradient(180deg,#FFB14D,#FF8A4D)" : "var(--card)") + ';color:' + (on ? "var(--on-accent)" : "var(--ink)") + '">' + d + '</button>'; });
    s += '</div></div><div style="margin-bottom:18px"><div style="font-size:14px;color:var(--muted);margin-bottom:8px">Categories</div><div style="display:flex;flex-wrap:wrap;gap:8px">';
    [["song", "The song"], ["artist", "The artist"], ["era", "The era"], ["lyrics", "Lyrics"], ["charts", "Chart history"]].forEach(function (c) { var on = trivia.cats[c[0]]; s += '<button class="tv-cat" data-cat="' + c[0] + '" style="padding:8px 13px;border-radius:999px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:600;border:1px solid ' + (on ? "transparent" : "var(--border2)") + ';background:' + (on ? "linear-gradient(180deg,#FFB14D,#FF8A4D)" : "var(--card)") + ';color:' + (on ? "var(--on-accent)" : "var(--muted)") + '">' + c[1] + '</button>'; });
    return s + '</div></div>';
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
    panel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;font-family:var(--mono);color:var(--dim);font-size:11px;letter-spacing:.08em;margin-bottom:12px"><span>QUESTION ' + (TQ.i + 1) + ' / ' + TQ.list.length + ' · ' + trivia.difficulty.toUpperCase() + '</span><span style="color:var(--sun-300)">SCORE ' + TQ.score + '</span></div>'
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
  var HINTS = { cards: "The deep-dive on what’s playing", songs: "Songs that share its DNA", artists: "Artists similar to the one playing", trivia: "Test your music knowledge", media: "Photos and album art", shazam: "Listen to discover", karaoke: "Sing along" };
  function setActiveTab(name) {
    curTab = name;
    Array.prototype.forEach.call(tabsEl.querySelectorAll(".gk-tab"), function (b) { b.classList.toggle("active", b.getAttribute("data-tab") === name); });
    hint.textContent = HINTS[name] || "";
    renderTab(name);
  }
  function renderTab(name) {
    if (name === "cards") { cur ? loadDeepDive(cur) : welcome(); }
    else if (name === "songs") { comingSoon("Songs with same DNA", "Recommendations matched to this song’s sonic fingerprint arrive with the music-graph engine."); }
    else if (name === "artists") { comingSoon("Similar artists", "Artist-to-artist recommendations land with the taste engine (Phase 5)."); }
    else if (name === "trivia") { resetTrivia(); renderTrivia("mode"); }
    else if (name === "media") { cur ? loadMedia(cur) : notePanel("Play or search a song first to see the artist’s media."); }
    else if (name === "shazam") { comingSoon("Listen to discover", "Point your phone at any song playing nearby and geeek identifies it instantly. Shazam recognition is native-only — it ships with the iOS app."); }
    else if (name === "karaoke") { comingSoon("Karaoke", "Drop the lead vocals with AI and sing to time-synced lyrics. Coming once stem-separation and licensed lyrics are wired in."); }
  }

  // ---------- polling ----------
  async function poll() {
    try {
      var track = await P.getActivePlayer().getCurrentTrack();
      if (track && track.id && track.id !== lastPlayingId) {
        lastPlayingId = track.id; manualMode = false; cur = track;
        pstate = { progressMs: track.progressMs || 0, durationMs: track.durationMs || 0, playing: !!track.isPlaying, at: Date.now() };
        playing = !!track.isPlaying; setPlayIcon(playing); tickProgress();
        setHero(track); updateShareLink(track);
        if (curTab === "cards") loadDeepDive(track);
        else if (curTab === "media") loadMedia(track);
      } else if (!manualMode) {
        if (track) {
          pstate = { progressMs: track.progressMs || 0, durationMs: track.durationMs || 0, playing: !!track.isPlaying, at: Date.now() };
          playing = !!track.isPlaying; setPlayIcon(playing); tickProgress(); setHero(track); updateShareLink(track);
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
  function closePanels() { $("gk-search").classList.remove("open"); $("gk-share").classList.remove("open"); }
  function togglePanel(id) { var open = $(id).classList.contains("open"); closePanels(); if (!open) { $(id).classList.add("open"); if (id === "gk-search") setTimeout(function () { sIn && sIn.focus(); }, 30); } }
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
  function openLightbox(url, title, sub) {
    $("gk-lb-img").style.backgroundImage = url ? ('url("' + url + '")') : "";
    $("gk-lb-title").textContent = title || (cur && cur.title) || "";
    $("gk-lb-sub").textContent = sub || (cur && cur.artist) || "";
    $("gk-lightbox").classList.add("open");
  }

  // ---------- transport ----------
  function flashPmsg(t) { var e = $("gk-pmsg"); if (!e) return; e.textContent = t; e.classList.add("show"); clearTimeout(e._t); e._t = setTimeout(function () { e.classList.remove("show"); }, 4200); }
  async function transport(action) {
    if (!S.isConnected()) { showSetup(true); refreshSetup(); return; }
    var ok = false;
    try {
      if (action === "toggle") { ok = await (playing ? CTRL.pause() : CTRL.play()); if (ok) { playing = !playing; setPlayIcon(playing); pstate.playing = playing; pstate.at = Date.now(); } }
      else if (action === "next") { ok = await CTRL.next(); }
      else if (action === "prev") { ok = await CTRL.prev(); }
    } catch (e) { ok = false; }
    if (!ok) flashPmsg("Reconnect Spotify in ⚙ Setup to control playback (requires Spotify Premium).");
    setTimeout(poll, 900);
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
      var md = e.target.closest(".tv-mode"); if (md) { trivia.mode = md.getAttribute("data-mode"); if (trivia.mode === "solo") renderTrivia("subject"); else if (trivia.mode === "contest") comingSoon("Worldwide contest", "Global, ranked superfan contests (Beatles, Rush, and more) need accounts and a live leaderboard — they’re coming in a later phase."); else comingSoon("Play with friends", "Live multiplayer rooms with shared questions are coming in a later phase."); return; }
      var sj = e.target.closest(".tv-subject"); if (sj) { trivia.subject = sj.getAttribute("data-subj"); renderTrivia("game"); return; }
      var gm = e.target.closest(".tv-game"); if (gm) { trivia.game = gm.getAttribute("data-game"); renderTrivia(trivia.game === "advanced" ? "advanced" : "ready"); return; }
      var df = e.target.closest(".tv-diff"); if (df) { trivia.difficulty = df.getAttribute("data-diff"); renderTrivia("advanced"); return; }
      var ct = e.target.closest(".tv-cat"); if (ct) { var c = ct.getAttribute("data-cat"); trivia.cats[c] = !trivia.cats[c]; renderTrivia("advanced"); return; }
      var st = e.target.closest(".tv-start"); if (st) { startTriviaGame(); return; }
      var op = e.target.closest(".tq-opt"); if (op) { answerQuestion(+op.getAttribute("data-i")); return; }
      var nx = e.target.closest(".tq-next"); if (nx) { if (TQ.i >= TQ.list.length - 1) triviaResults(); else { TQ.i++; renderQuestion(); } return; }
      var ag = e.target.closest(".tv-again"); if (ag) { resetTrivia(); renderTrivia("mode"); return; }
      var mt = e.target.closest(".mtile"); if (mt) { openLightbox(mt.getAttribute("data-full"), mt.getAttribute("data-cap"), cur && cur.artist); return; }
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

    // share copy
    $("gk-copy").addEventListener("click", function () {
      var b = this; try { navigator.clipboard && navigator.clipboard.writeText($("gk-link").value); } catch (e) {}
      b.textContent = "Copied ✓"; b.style.background = "linear-gradient(180deg,#FFB14D,#FF8A4D)"; b.style.color = "#1A0B05"; b.style.borderColor = "transparent";
      setTimeout(function () { b.textContent = "Copy"; b.style.background = "var(--card)"; b.style.color = "var(--ink)"; b.style.borderColor = "var(--border2)"; }, 1600);
    });

    // transport
    $("gk-playbtn").addEventListener("click", function () { transport("toggle"); });
    $("gk-prev").addEventListener("click", function () { transport("prev"); });
    $("gk-next").addEventListener("click", function () { transport("next"); });

    // cover + lightbox
    $("gk-cover").addEventListener("click", function () { openLightbox(cur && cur.art, cur && cur.title, cur && cur.artist); });
    $("gk-lightbox").addEventListener("click", function () { $("gk-lightbox").classList.remove("open"); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") $("gk-lightbox").classList.remove("open"); });

    // shared ui hooks for Apple Music provider
    window.SDD.ui = {
      renderNowPlaying: function (t) { if (!t) return; setHero(t); pstate = { progressMs: 0, durationMs: 0, playing: !!t.isPlaying, at: Date.now() }; playing = !!t.isPlaying; setPlayIcon(playing); },
      loadDeepDive: function (t) { manualMode = false; cur = t; updateShareLink(t); if (curTab === "cards") loadDeepDive(t); else if (curTab === "media") loadMedia(t); },
      setStatus: function () {}
    };

    setActiveTab("cards");

    // deep link ?t=&a=
    var qp = new URLSearchParams(location.search);
    var dt = qp.get("t");
    if (dt) { history.replaceState({}, document.title, location.origin + "/"); diveWith(dt, qp.get("a") || "", ""); }

    // spotify
    S.handleRedirect().then(function (ok) {
      if (S.isConnected()) startPolling();
      refreshSetup();
    });

    // apple (inert unless /api/amtoken configured)
    if (AM && AM.init) { try { AM.init(window.SDD.ui).then(refreshSetup); } catch (e) {} }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
