// GET /api/deeper?title=&artist=
// The "geeek deeper" long-read — a second, richer layer under the main Story.
// Sections: the song, the album, the era around the artist (responsible, non-sensational),
// the producer, the engineer, notable covers (only if real), and echoes/similar songs (only if real).
// Grounded in open data (MusicBrainz + Wikipedia) and written by Claude Haiku with strong
// anti-fabrication + no-sensationalism guardrails. Redis-cached (first-writer-wins), no lyrics.

const A = require("../shared/auth");
const MB_BASE = "https://musicbrainz.org/ws/2";
const MB_UA = "geeek/1.0 (https://geeek.fm)";
const WIKI = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

const VERSION = "1.0"; // bump to invalidate the deeper shared cache when this prompt changes
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SHARED_TTL = 60 * 60 * 24 * 90;

const cache = new Map();
const CACHE_MAX = 400;
function capped(map) { if (map.size > CACHE_MAX) map.clear(); }
function norm(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function primaryArtist(a) { return String(a || "").split(/,|&|;|\/|\bfeat\.?\b|\bfeaturing\b|\bwith\b|\bx\b|\bvs\.?\b/i)[0]; }
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

async function gatherDeepFacts(title, artist, context) {
  const f = { title, artist, year: "", mbArtist: "", album: "", producer: "", engineer: "", writers: "", wikiSong: "", wikiArtist: "", wikiAlbum: "" };
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
    // Earliest studio album title for context.
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

async function writeDeeperWithClaude(apiKey, f, context) {
  const system =
    "You are a careful, warm music writer creating a 'go deeper' long-read for a listener who already read a short story about this song and wants more depth. " +
    "Write with curiosity and respect for the music and the people who made it.\n\n" +
    "GROUNDING & RESPONSIBILITY RULES (critical):\n" +
    "- The FACTS block (MusicBrainz + Wikipedia) is your source of truth for names, dates, credits, album titles. Prefer it.\n" +
    "- You MAY add widely-known, well-established musical and cultural context from your own knowledge so it reads richly.\n" +
    "- NEVER fabricate specific names, dates, credits, chart positions, quotes, or lyrics. If you are unsure of a specific, stay general or omit it. Accuracy beats flourish.\n" +
    "- BE RESPONSIBLE and NON-SENSATIONAL, especially about the artist's life and era: focus on musical, artistic and cultural context. Do NOT dwell on gossip, scandal, addiction, tragedy, health, relationships, or private struggles. No tabloid tone. If a well-known hardship is genuinely essential context, mention it briefly, factually and with dignity — never for shock.\n" +
    "- Do NOT reproduce or paraphrase song lyrics.\n" +
    "- Only include the 'Covers' section if notable cover versions genuinely exist and you are confident. Only include the 'Echoes' (similar songs) section if there are real, well-known musical kinships. Otherwise omit those sections entirely.\n\n" +
    "Output STRICT JSON only — no prose, no markdown fences.";
  const user =
    `Facts:\n${factsBlock(f)}\n\n` +
    `Write a deeper long-read as STRICT JSON in exactly this shape. Use short paragraphs (1-3 sentences each). Ground names/dates/credits in the facts; add well-known context; never fabricate; never include lyrics; keep the artist's-life section respectful and non-sensational. Include a section ONLY if you have real substance for it (omit Covers and/or Echoes if none genuinely exist):\n` +
    `{"deeper":{"body":[` +
    `{"type":"h","text":"The song"},` +
    `{"type":"p","text":"deeper detail on the song itself — its making, sound, structure, or meaning (1-3 sentences)"},` +
    `{"type":"h","text":"The album"},` +
    `{"type":"p","text":"the album it lives on and how the song fits it (1-3 sentences)"},` +
    `{"type":"h","text":"The era"},` +
    `{"type":"p","text":"where the artist was in life and craft at this time, and the cultural moment — respectful, non-sensational (1-3 sentences)"},` +
    `{"type":"h","text":"Producer & engineer"},` +
    `{"type":"p","text":"who shaped the record in the studio and how (producer, engineer) — only what you are confident about (1-3 sentences)"},` +
    `{"type":"h","text":"Covers"},` +
    `{"type":"p","text":"notable cover versions and what they did with it — OMIT this whole section (both the heading and this paragraph) if none genuinely exist"},` +
    `{"type":"h","text":"Echoes"},` +
    `{"type":"p","text":"songs it clearly resembles, influenced, or was influenced by — OMIT this whole section if there is no real kinship"}` +
    `]}}`;
  const body = { model: ANTHROPIC_MODEL, max_tokens: 2000, system, messages: [{ role: "user", content: user }] };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 24000);
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
    // sanitize: keep only h/p/quote blocks with text; drop a heading that has no following paragraph.
    const clean = [];
    for (let i = 0; i < bodyArr.length; i++) {
      const b = bodyArr[i];
      if (!b || !b.text || typeof b.text !== "string") continue;
      const type = (b.type === "h" || b.type === "quote") ? b.type : "p";
      if (type === "h") {
        // look ahead for a paragraph before the next heading
        let hasBody = false;
        for (let j = i + 1; j < bodyArr.length; j++) {
          const n = bodyArr[j]; if (!n) continue;
          if (n.type === "h") break;
          if (n.text && String(n.text).trim()) { hasBody = true; break; }
        }
        if (!hasBody) continue;
      }
      clean.push({ type, text: b.text.trim() });
    }
    return clean.length ? { body: clean } : null;
  } catch (e) { context.log("anthropic error", e.message); return null; } finally { clearTimeout(timer); }
}

// Open-data fallback when there is no AI key (still useful, still responsible).
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
function templateDeeper(f) {
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
  return { body };
}

module.exports = async function (context, req) {
  if (A.blockIfUnauthed(context, req)) return;
  const q = {
    title: ((req.query && req.query.title) || "").trim(),
    artist: ((req.query && req.query.artist) || "").trim()
  };
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
  const facts = await gatherDeepFacts(q.title, q.artist, context);

  let ai = null;
  if (apiKey) ai = await writeDeeperWithClaude(apiKey, facts, context);
  const aiUsed = !!(ai && ai.body && ai.body.length);
  const deeper = aiUsed ? ai : templateDeeper(facts);

  let payload = {
    track: { title: q.title, artist: q.artist },
    deeper,
    _meta: { source: aiUsed ? "ai+open-data" : "open-data (add ANTHROPIC_API_KEY for AI)", year: facts.year || null, generatedAt: new Date().toISOString() }
  };

  capped(cache);
  if (aiUsed) {
    // One canonical deeper story per song: first finisher locks it; a racing loser adopts the winner's.
    const won = await sharedSetNX(skey, payload);
    if (!won) { const existing = await sharedGet(skey); if (existing && existing.deeper && existing.deeper.body && existing.deeper.body.length) payload = existing; }
    cache.set(key, payload);
  } else if (!apiKey) {
    cache.set(key, payload);
  }

  context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }, body: payload };
};
