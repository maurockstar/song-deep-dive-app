// GET|POST /api/deeper?title=&artist=   (POST body may add { seed } = the already-shown story text)
// The "geeek deeper" long-read — a second, richer layer UNDER the main Story.
//   • It must be COMPLEMENTARY to the top story (new knowledge, not a repeat). The already-shown
//     story is passed in as `seed` so the writer can avoid restating it; we also drop near-duplicate
//     paragraphs server-side.
//   • Sections: The song, The album, The era (responsible, non-sensational), Producer & engineer,
//     Covers (only if real).
//   • Plus TWO cross-artist "similar songs" recommendations (recos) tuned to groove/era/beat/rhythm/
//     feel — gravitating to OTHER artists, never the same album. Candidates come from Last.fm's real
//     co-listening data when LASTFM_API_KEY is set; Claude curates the final two with a one-line why.
//     (Spotify's own /recommendations + /audio-features were deprecated 2024-11-27, so we don't use them.)
// Grounded in open data (MusicBrainz + Wikipedia) + Claude Haiku, with anti-fabrication + no-sensationalism
// + no-lyrics guardrails. Redis-cached (first-writer-wins), versioned. The CLIENT turns each reco into a
// real Spotify link via Spotify Search.

const A = require("../shared/auth");
const MB_BASE = "https://musicbrainz.org/ws/2";
const MB_UA = "geeek/1.0 (https://geeek.fm)";
const WIKI = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const LASTFM = "https://ws.audioscrobbler.com/2.0/";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

const VERSION = "1.4"; // bump to invalidate the deeper shared cache when this prompt/shape changes
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const LASTFM_KEY = process.env.LASTFM_API_KEY; // optional — free key enables real co-listening candidates
const SHARED_TTL = 60 * 60 * 24 * 90;

const cache = new Map();
const CACHE_MAX = 400;
function capped(map) { if (map.size > CACHE_MAX) map.clear(); }
function norm(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function primaryArtist(a) { return String(a || "").split(/,|&|;|\/|\bfeat\.?\b|\bfeaturing\b|\bwith\b|\bx\b|\bvs\.?\b/i)[0].trim(); }
function songTitleBase(t) { return String(t || "").replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ").replace(/\s[-–—]\s.*$/, " "); }
function cacheKey(q) { return ("song:" + norm(songTitleBase(q.title)) + "|" + norm(primaryArtist(q.artist))).replace(/\s+/g, "_"); }

async function jget(url, headers, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 8000);
  try {
    const r = await fetch(url, { headers: headers || {}, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

// ---- shared cache (Upstash Redis REST). No-op when env vars aren't set. ----
async function redisCmd(cmd, ms) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 4000);
  try {
    const r = await fetch(REDIS_URL, {
      method: "POST",
      headers: { "Authorization": "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
      signal: ctrl.signal
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && Object.prototype.hasOwnProperty.call(j, "result")) ? j.result : null;
  } catch (e) { return null; } finally { clearTimeout(timer); }
}
async function sharedGet(skey) {
  const v = await redisCmd(["GET", skey]);
  if (!v || typeof v !== "string") return null;
  try { return JSON.parse(v); } catch (e) { return null; }
}
async function sharedSetNX(skey, payload) {
  try { return (await redisCmd(["SET", skey, JSON.stringify(payload), "NX", "EX", String(SHARED_TTL)])) === "OK"; }
  catch (e) { return false; }
}

// ---- open-data facts (MusicBrainz + Wikipedia) ----
async function bestRecording(title, artist) {
  const query = encodeURIComponent(`recording:"${title}"` + (artist ? ` AND artist:"${artist}"` : ""));
  const search = await jget(`${MB_BASE}/recording?query=${query}&fmt=json&limit=8`, { "User-Agent": MB_UA });
  const recs = (search && search.recordings) || [];
  if (!recs.length) return null;
  const nt = norm(title), na = norm(artist);
  let best = null, bestScore = -1;
  for (const r of recs) {
    const credit = (r["artist-credit"] || []).map(a => a.name).join(", ");
    let score = (r.score || 0);
    if (norm(r.title) === nt) score += 30;
    if (na && norm(credit).includes(na)) score += 40;
    if ((r["first-release-date"] || "").slice(0, 4)) score += 5;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}
function addCredit(map, type, name) {
  if (!type || !name) return;
  const t = String(type).toLowerCase();
  if (!map.has(t)) map.set(t, new Set());
  map.get(t).add(name);
}
function pickCredit(map, types) {
  for (const t of types) { if (map.has(t)) { const a = Array.from(map.get(t)); if (a.length) return a.slice(0, 3).join(", "); } }
  return "";
}
async function wikiSummary(candidates) {
  for (const c of candidates) {
    const s = await jget(WIKI + encodeURIComponent(c), {});
    if (s && s.extract && s.type !== "disambiguation") return s.extract.trim();
  }
  return "";
}

// Real co-listening candidates (cross-artist) from Last.fm — only when LASTFM_API_KEY is set.
async function lastfmSimilar(title, artist) {
  if (!LASTFM_KEY || !title) return [];
  const url = LASTFM + "?method=track.getsimilar&autocorrect=1&limit=14&format=json"
    + "&api_key=" + encodeURIComponent(LASTFM_KEY)
    + "&track=" + encodeURIComponent(title)
    + (artist ? "&artist=" + encodeURIComponent(artist) : "");
  const j = await jget(url, {});
  const arr = (j && j.similartracks && j.similartracks.track) || [];
  const pa = norm(primaryArtist(artist));
  const out = [], seen = {};
  for (const t of arr) {
    const tArtist = t.artist && (t.artist.name || t.artist["#text"] || t.artist);
    if (!t.name || !tArtist) continue;
    const na = norm(tArtist);
    if (pa && (na === pa)) continue;                 // gravitate to OTHER artists
    const k = na + "|" + norm(t.name);
    if (seen[k]) continue; seen[k] = 1;
    out.push({ title: t.name, artist: String(tArtist), match: t.match ? +t.match : null });
    if (out.length >= 12) break;
  }
  return out;
}

async function gatherDeepFacts(title, artist, context) {
  const f = { title, artist, year: "", mbArtist: "", album: "", producer: "", engineer: "", writers: "", tags: "", wikiSong: "", wikiArtist: "", wikiAlbum: "" };
  const creditMap = new Map();

  const rec = await bestRecording(title, artist);
  if (rec) {
    f.mbArtist = (rec["artist-credit"] || []).map(a => a.name).join(", ");
    f.year = (rec["first-release-date"] || "").slice(0, 4);

    const det = await jget(`${MB_BASE}/recording/${rec.id}?inc=artist-rels+work-rels+releases&fmt=json`, { "User-Agent": MB_UA });
    let workId = "";
    if (det && Array.isArray(det.relations)) {
      for (const rel of det.relations) {
        if (rel.artist && rel.type) addCredit(creditMap, rel.type, rel.artist.name);
        if (rel.work && rel.work.id && !workId) workId = rel.work.id;
      }
    }
    if (det && Array.isArray(det.releases) && det.releases.length) {
      const rels = det.releases.slice().sort((a, b) => String(a.date || "9999").localeCompare(String(b.date || "9999")));
      f.album = (rels[0] && rels[0].title) || "";
    }
    if (workId) {
      const work = await jget(`${MB_BASE}/work/${workId}?inc=artist-rels&fmt=json`, { "User-Agent": MB_UA });
      if (work && Array.isArray(work.relations)) {
        for (const rel of work.relations) { if (rel.artist && rel.type) addCredit(creditMap, rel.type, rel.artist.name); }
      }
    }
  }
  f.producer = pickCredit(creditMap, ["producer"]);
  f.engineer = pickCredit(creditMap, ["engineer", "recording", "mix", "mastering"]);
  f.writers = pickCredit(creditMap, ["composer", "writer", "lyricist"]);

  const songCands = artist ? [`${title} (${artist} song)`, `${title} (song)`, title] : [`${title} (song)`, title];
  f.wikiSong = await wikiSummary(songCands);
  if (artist) f.wikiArtist = await wikiSummary([artist, `${artist} (band)`, `${artist} (musician)`, `${artist} (singer)`]);
  if (f.album) f.wikiAlbum = await wikiSummary([`${f.album} (${artist} album)`, `${f.album} (album)`, f.album]);
  return f;
}

function factsBlock(f) {
  let s = `Song title: ${f.title}\nArtist (as queried): ${f.artist || "unknown"}\n`;
  if (f.mbArtist) s += `Artist credit (MusicBrainz): ${f.mbArtist}\n`;
  if (f.year) s += `First release year: ${f.year}\n`;
  if (f.album) s += `Appears on album: ${f.album}\n`;
  if (f.writers) s += `Writer(s): ${f.writers}\n`;
  if (f.producer) s += `Producer(s): ${f.producer}\n`;
  if (f.engineer) s += `Engineer(s): ${f.engineer}\n`;
  if (f.wikiSong) s += `Wikipedia (song): ${f.wikiSong}\n`;
  if (f.wikiAlbum) s += `Wikipedia (album): ${f.wikiAlbum}\n`;
  if (f.wikiArtist) s += `Wikipedia (artist): ${f.wikiArtist}\n`;
  if (!f.mbArtist && !f.wikiSong && !f.wikiArtist) s += `(Open-data lookup was thin for this one.)\n`;
  return s;
}

// significant-word set for de-dup / complementarity checks
function wordSet(s) {
  const stop = { the: 1, a: 1, an: 1, and: 1, or: 1, of: 1, to: 1, in: 1, on: 1, for: 1, with: 1, that: 1, this: 1, it: 1, its: 1, is: 1, was: 1, as: 1, at: 1, by: 1, from: 1, but: 1, into: 1, out: 1, "s": 1 };
  const set = {};
  norm(s).split(" ").forEach(w => { if (w && w.length > 2 && !stop[w]) set[w] = 1; });
  return set;
}
// True when a paragraph mostly re-covers the seed story (so we drop it to stay complementary).
function tooSimilarToSeed(text, seedSet, seedSize) {
  if (!seedSize) return false;
  const ws = Object.keys(wordSet(text));
  if (ws.length < 5) return false;
  let hit = 0; for (const w of ws) if (seedSet[w]) hit++;
  return (hit / ws.length) >= 0.72; // most of the paragraph's meaningful words already appeared up top
}

async function writeDeeperWithClaude(apiKey, f, seed, similarPool, context) {
  const poolTxt = (similarPool && similarPool.length)
    ? similarPool.slice(0, 12).map(s => `- ${s.title} — ${s.artist}`).join("\n")
    : "(none provided — use your own well-established music knowledge)";
  const system =
    "You are a careful, warm music writer creating a 'go deeper' long-read for a listener who ALREADY read a short story about this song and wants genuinely new depth.\n\n" +
    "GROUNDING & RESPONSIBILITY RULES (critical):\n" +
    "- The FACTS block (MusicBrainz + Wikipedia) is your source of truth for names, dates, credits, album titles. Prefer it.\n" +
    "- You MAY add widely-known, well-established musical and cultural context from your own knowledge so it reads richly.\n" +
    "- NEVER fabricate specific names, dates, credits, chart positions, quotes, or lyrics. If unsure of a specific, stay general or omit it. Accuracy beats flourish.\n" +
    "- BE RESPONSIBLE and NON-SENSATIONAL, especially about the artist's life/era: focus on musical, artistic and cultural context. No gossip, scandal, addiction, tragedy, health or private struggles for shock. If a well-known hardship is essential context, mention it briefly, factually, with dignity.\n" +
    "- Do NOT reproduce or paraphrase song lyrics.\n\n" +
    "COMPLEMENTARITY (critical): The reader has ALREADY read the short story provided as ALREADY-TOLD. Your job is to ADD NEW knowledge and angles they have NOT read yet. Do NOT restate the facts, phrasing, or anecdotes in ALREADY-TOLD. You may briefly reference something from it ONLY if strictly necessary as a bridge. Going deeper means new information, not a re-tell.\n\n" +
    "HEADINGS: Use ONLY these section headings, verbatim: The song, The album, The era, Producer & engineer, and optionally Covers (only if real cover versions exist). Do NOT invent other headings. Never address data, sources, lookups, uncertainty or discrepancies — if unsure, silently omit.\n\n" +
    "SIMILAR SONGS (recos): Also pick THREE candidate songs for discovery (the app shows the best two). Rules: (1) EVERY pick is by a DIFFERENT artist than this song's artist AND different from each other — no repeats; (2) NOT from the same album; (3) gravitate to OTHER artists to help the listener discover new acts; (4) each must genuinely match this song's vibe — groove, era, tempo/beat, rhythm, energy and overall feel; (5) each needs a short complete one-line 'why' (<= 16 words) naming the shared musical quality. If a CANDIDATES list is given (real co-listening data), STRONGLY prefer picks from it. CRITICAL: only recommend songs you are highly confident actually exist and are correctly credited to that EXACT artist — never invent a song or mis-attribute a title to the wrong artist. When unsure, choose a more famous, safely-attributed song by a fitting artist that a listener can definitely find on Spotify.\n\n" +
    "Output STRICT JSON only — no prose, no markdown fences.";
  const user =
    `Facts:\n${factsBlock(f)}\n\n` +
    `ALREADY-TOLD (do NOT repeat this):\n${(seed || "(not provided)").slice(0, 1600)}\n\n` +
    `CANDIDATES for similar songs (real co-listening data; may be empty):\n${poolTxt}\n\n` +
    `Write STRICT JSON in exactly this shape. Short paragraphs (1-3 sentences). Ground names/dates/credits in the facts; add well-known context; never fabricate; never include lyrics; keep the era section respectful. Include a section ONLY if you have real substance (omit Covers if none genuinely exist):\n` +
    `{"deeper":{"body":[` +
    `{"type":"h","text":"The song"},` +
    `{"type":"p","text":"NEW deeper detail on the song's making, sound, structure or meaning — not already told (1-3 sentences)"},` +
    `{"type":"h","text":"The album"},` +
    `{"type":"p","text":"the album it lives on and how the song fits it (1-3 sentences)"},` +
    `{"type":"h","text":"The era"},` +
    `{"type":"p","text":"where the artist was in life and craft then, and the cultural moment — respectful, non-sensational (1-3 sentences)"},` +
    `{"type":"h","text":"Producer & engineer"},` +
    `{"type":"p","text":"who shaped the record in the studio and how — only what you are confident about (1-3 sentences)"},` +
    `{"type":"h","text":"Covers"},` +
    `{"type":"p","text":"notable cover versions — OMIT this whole section if none genuinely exist"}` +
    `],` +
    `"recos":[` +
    `{"title":"song title","artist":"a DIFFERENT artist","why":"short complete line: the shared groove/era/beat/feel"},` +
    `{"title":"song title","artist":"another DIFFERENT artist","why":"short complete line: the shared quality"},` +
    `{"title":"song title","artist":"a third DIFFERENT artist","why":"short complete line: the shared quality"}` +
    `]}}`;
  const body = { model: ANTHROPIC_MODEL, max_tokens: 2000, system, messages: [{ role: "user", content: user }] };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify(body), signal: ctrl.signal
    });
    if (!r.ok) { context.log("anthropic http", r.status); return null; }
    const data = await r.json();
    const text = (data.content && data.content[0] && data.content[0].text) || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const bodyArr = parsed && parsed.deeper && Array.isArray(parsed.deeper.body) ? parsed.deeper.body : null;
    if (!bodyArr || !bodyArr.length) return null;

    const seedSet = wordSet(seed || "");
    const seedSize = Object.keys(seedSet).length;
    const okHead = /(the song|the album|the era|producer|engineer|studio|covers?)/i;
    const clean = [];
    let skipping = false;
    for (let i = 0; i < bodyArr.length; i++) {
      const b = bodyArr[i];
      if (!b || !b.text || typeof b.text !== "string") continue;
      const type = (b.type === "h" || b.type === "quote") ? b.type : "p";
      if (type === "h") {
        if (!okHead.test(b.text)) { skipping = true; continue; }
        skipping = false;
        let hasBody = false;
        for (let j = i + 1; j < bodyArr.length; j++) {
          const n = bodyArr[j]; if (!n) continue;
          if (n.type === "h") break;
          if (n.text && String(n.text).trim()) { hasBody = true; break; }
        }
        if (!hasBody) continue;
        clean.push({ type, text: b.text.trim() });
        continue;
      }
      if (skipping) continue;
      if (tooSimilarToSeed(b.text, seedSet, seedSize)) continue; // stay complementary
      clean.push({ type, text: b.text.trim() });
    }
    // remove a heading left with no paragraph after the dedup, and a leading preamble
    const pruned = [];
    for (let i = 0; i < clean.length; i++) {
      if (clean[i].type === "h") {
        const next = clean[i + 1];
        if (!next || next.type === "h") continue;
      }
      pruned.push(clean[i]);
    }
    while (pruned.length && pruned[0].type !== "h") pruned.shift();

    const recos = cleanRecos(parsed.deeper.recos, f.artist);
    if (!pruned.length && !recos.length) return null;
    return { body: pruned, recos };
  } catch (e) { context.log("anthropic error", e.message); return null; } finally { clearTimeout(timer); }
}

// Trim a reco's "why" to a whole word (never mid-word).
function clipWhy(w) {
  var s = (w ? String(w) : "").replace(/\s+/g, " ").trim();
  if (s.length <= 140) return s;
  var cut = s.slice(0, 140), sp = cut.lastIndexOf(" ");
  return (sp > 60 ? cut.slice(0, sp) : cut).replace(/[,;:.\-\s]+$/, "") + "…";
}
// Validate recommendations: 2 max, different artists, not the song's artist, not the same title.
function cleanRecos(arr, songArtist) {
  const pa = norm(primaryArtist(songArtist));
  const out = [], seen = {};
  (Array.isArray(arr) ? arr : []).forEach(function (r) {
    if (!r || !r.title || !r.artist) return;
    const na = norm(r.artist), nt = norm(r.title);
    if (!na || !nt) return;
    if (pa && na === pa) return;                       // not the same artist
    const k = na + "|" + nt;
    if (seen[k] || seen["artist:" + na]) return;       // dedupe + one per artist
    seen[k] = 1; seen["artist:" + na] = 1;
    out.push({ title: String(r.title).trim(), artist: String(r.artist).trim(), why: clipWhy(r.why) });
  });
  return out.slice(0, 2);
}

function clip(text, maxChars) {
  if (!text) return "";
  const t = String(text).replace(/\s+/g, " ").trim();
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (end > maxChars * 0.5) return cut.slice(0, end + 1).trim();
  const sp = cut.lastIndexOf(" ");
  return (sp > 0 ? cut.slice(0, sp) : cut).replace(/[,;:.\-\s]+$/, "").trim() + "…";
}
function templateDeeper(f, similarPool) {
  const body = [];
  body.push({ type: "h", text: "The song" });
  body.push({ type: "p", text: f.wikiSong ? clip(f.wikiSong, 480) : ("“" + f.title + "”" + (f.mbArtist ? " by " + f.mbArtist : "") + (f.year ? ", first released in " + f.year : "") + ".") });
  if (f.album) { body.push({ type: "h", text: "The album" }); body.push({ type: "p", text: f.wikiAlbum ? clip(f.wikiAlbum, 420) : ("It appears on the album " + f.album + ".") }); }
  if (f.wikiArtist) { body.push({ type: "h", text: "The era" }); body.push({ type: "p", text: clip(f.wikiArtist, 460) }); }
  if (f.producer || f.engineer) {
    body.push({ type: "h", text: "Producer & engineer" });
    const parts = [];
    if (f.producer) parts.push("Produced by " + f.producer + ".");
    if (f.engineer) parts.push("Engineering: " + f.engineer + ".");
    body.push({ type: "p", text: parts.join(" ") });
  }
  const recos = cleanRecos((similarPool || []).slice(0, 2).map(s => ({ title: s.title, artist: s.artist, why: "Loved by listeners of this song." })), f.artist);
  return { body, recos };
}

module.exports = async function (context, req) {
  if (A.blockIfUnauthed(context, req)) return;
  const q = {
    title: ((req.query && req.query.title) || (req.body && req.body.title) || "").trim(),
    artist: ((req.query && req.query.artist) || (req.body && req.body.artist) || "").trim()
  };
  const seed = String((req.body && req.body.seed) || (req.query && req.query.seed) || "").slice(0, 2000);
  if (!q.title) { context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: { error: "Provide ?title=" } }; return; }

  const key = cacheKey(q);
  const skey = "sdd:deep:" + VERSION + ":" + key;

  if (cache.has(key)) {
    context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }, body: cache.get(key) };
    return;
  }
  const shared = await sharedGet(skey);
  if (shared && shared.deeper && shared.deeper.body && shared.deeper.body.length) {
    cache.set(key, shared);
    context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }, body: shared };
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const [facts, similarPool] = await Promise.all([
    gatherDeepFacts(q.title, q.artist, context),
    lastfmSimilar(songTitleBase(q.title).trim(), primaryArtist(q.artist))
  ]);

  let ai = null;
  if (apiKey) ai = await writeDeeperWithClaude(apiKey, facts, seed, similarPool, context);
  const aiUsed = !!(ai && ai.body && ai.body.length);
  const deeper = aiUsed ? ai : templateDeeper(facts, similarPool);

  let payload = {
    track: { title: q.title, artist: q.artist },
    deeper,
    _meta: { source: aiUsed ? "ai+open-data" : "open-data (add ANTHROPIC_API_KEY for AI)", candidates: (similarPool || []).length, year: facts.year || null, generatedAt: new Date().toISOString() }
  };

  capped(cache);
  if (aiUsed) {
    const won = await sharedSetNX(skey, payload);
    if (!won) { const existing = await sharedGet(skey); if (existing && existing.deeper && existing.deeper.body && existing.deeper.body.length) payload = existing; }
    cache.set(key, payload);
  } else if (!apiKey) {
    cache.set(key, payload);
  }

  context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }, body: payload };
};
