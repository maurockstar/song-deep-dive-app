// GET /api/deepdive?id=&title=&artist=[&fast=1]
// Phase 2 (AI-first, two-phase) — the knowledge pipeline:
//   1) cache (in-memory)            -> instant on repeats
//   2) gather facts from open data  -> MusicBrainz + Wikipedia (free, no key)
//   3) AI writes the cards          -> Anthropic Claude, grounded in those facts but
//                                      also allowed to use well-known music knowledge
//                                      (with anti-hallucination guardrails)
//   4) graceful fallback            -> plain open-data cards if no key / any failure
//
// Two-phase: ?fast=1 returns open-data cards instantly and (if a key is set) flags
// _meta.aiPending so the client fetches the AI-written version in a second call.
// Facts are cached between the two calls, so open data is only gathered once.
//
// To enable the AI step, add an Application Setting in Azure (Configuration):
//   ANTHROPIC_API_KEY = sk-ant-...

const MB_BASE = "https://musicbrainz.org/ws/2";
const MB_UA = "SongDeepDive/0.5 (https://zealous-pond-0200e1e10.7.azurestaticapps.net)"; // MusicBrainz requires a UA
const WIKI = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"; // change here if your account uses a different id

const cache = new Map();       // key -> finished payload (AI or open-data)
const factsCache = new Map();  // key -> gathered facts (shared by fast + full calls)
const CACHE_MAX = 500;
function cacheKey(q) { return ("song:" + q.title + "|" + q.artist).toLowerCase().replace(/\s+/g, "_"); }
function capped(map) { if (map.size > CACHE_MAX) map.clear(); }
function norm(s) { return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

async function jget(url, headers, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 8000);
  try {
    const r = await fetch(url, { headers: headers || {}, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

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
function flattenCredits(map) {
  const order = ["composer", "lyricist", "writer", "producer", "vocal", "performer", "instrument", "arranger", "engineer", "mix"];
  const keys = Array.from(map.keys()).sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  const out = [];
  for (const k of keys) {
    const names = Array.from(map.get(k)).slice(0, 4);
    if (names.length) out.push(`${k}: ${names.join(", ")}`);
  }
  return out;
}

async function wikiSummary(candidates) {
  for (const c of candidates) {
    const s = await jget(WIKI + encodeURIComponent(c), {});
    if (s && s.extract && s.type !== "disambiguation") return s.extract.trim();
  }
  return "";
}

async function gatherFacts(title, artist, context) {
  const facts = { title, artist, year: "", mbArtist: "", credits: [], wiki: "", wikiArtist: "" };
  const creditMap = new Map();

  const rec = await bestRecording(title, artist);
  if (rec) {
    facts.mbArtist = (rec["artist-credit"] || []).map(a => a.name).join(", ");
    facts.year = (rec["first-release-date"] || "").slice(0, 4);

    const det = await jget(`${MB_BASE}/recording/${rec.id}?inc=artist-rels+work-rels&fmt=json`, { "User-Agent": MB_UA });
    let workId = "";
    if (det && Array.isArray(det.relations)) {
      for (const rel of det.relations) {
        if (rel.artist && rel.type) addCredit(creditMap, rel.type, rel.artist.name);
        if (rel.work && rel.work.id && !workId) workId = rel.work.id;
      }
    }
    if (workId) {
      const work = await jget(`${MB_BASE}/work/${workId}?inc=artist-rels&fmt=json`, { "User-Agent": MB_UA });
      if (work && Array.isArray(work.relations)) {
        for (const rel of work.relations) {
          if (rel.artist && rel.type) addCredit(creditMap, rel.type, rel.artist.name);
        }
      }
    }
  }
  facts.credits = flattenCredits(creditMap);

  const songCands = artist
    ? [`${title} (${artist} song)`, `${title} (song)`, title]
    : [`${title} (song)`, title];
  facts.wiki = await wikiSummary(songCands);
  if (artist) {
    facts.wikiArtist = await wikiSummary([artist, `${artist} (band)`, `${artist} (musician)`, `${artist} (singer)`]);
  }
  return facts;
}

function factsBlock(f) {
  let s = `Song title: ${f.title}\nArtist (as queried): ${f.artist || "unknown"}\n`;
  if (f.mbArtist) s += `Artist credit (MusicBrainz): ${f.mbArtist}\n`;
  if (f.year) s += `First release year: ${f.year}\n`;
  if (f.credits.length) s += `Credits / relationships: ${f.credits.slice(0, 12).join("; ")}\n`;
  if (f.wiki) s += `Wikipedia (song): ${f.wiki}\n`;
  if (f.wikiArtist) s += `Wikipedia (artist): ${f.wikiArtist}\n`;
  if (!f.mbArtist && !f.wiki && !f.wikiArtist) s += `(Open-data lookup was thin for this one.)\n`;
  return s;
}

async function writeCardsWithClaude(apiKey, f, context) {
  const system =
    "You are a warm, knowledgeable music writer creating short 'deep dive' cards for someone who is listening to this song right now. " +
    "Your goal: spark curiosity and joy about the music they love, and — where it feels natural — gently remind them that the best thing to do next is to go live life: feel it, share it, get outside. Never force that nudge.\n\n" +
    "GROUNDING RULES (important):\n" +
    "- The FACTS block (from MusicBrainz + Wikipedia) is your source of truth. Prefer it for all names, dates, credits, and specific claims.\n" +
    "- You MAY enrich the cards with widely-known, well-established context about the song, artist, genre, era, and influences from your own knowledge — this is encouraged so the cards feel rich and alive.\n" +
    "- NEVER fabricate specific credits, collaborators, chart positions, dates, lyrics, or quotes you are not confident are correct. When unsure about a specific, stay general or leave it out. Accuracy beats flourish.\n" +
    "- If the facts are thin AND you genuinely do not recognize the song, be honest and keep it general rather than inventing details.\n" +
    "- Do not reproduce song lyrics.\n\n" +
    "Output STRICT JSON only — no prose, no markdown fences.";
  const user =
    `Facts:\n${factsBlock(f)}\n\n` +
    `Write four cards as STRICT JSON in exactly this shape (keep titles tight, bodies vivid):\n` +
    `{"cards":[` +
    `{"kicker":"The story","title":"max 6 words","body":"1-2 vivid sentences on what this song is and why it matters","extra":"2-3 sentences going deeper on its origin, era, or meaning"},` +
    `{"kicker":"The people","title":"max 6 words","body":"who made it — artist, key writers/producers","extra":"2-3 sentences on the people and how they shaped it"},` +
    `{"kicker":"Connections","title":"max 6 words","body":"how it connects to other music, artists, or scenes","extra":"2-3 sentences mapping influences, samples, or descendants"},` +
    `{"kicker":"Did you know","title":"max 6 words","body":"one surprising, shareable fact","extra":"2-3 sentences — and, if it fits, a warm nudge to go enjoy it out in the world"}` +
    `]}`;
  const body = { model: ANTHROPIC_MODEL, max_tokens: 1200, system, messages: [{ role: "user", content: user }] };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
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
    return Array.isArray(parsed.cards) ? parsed.cards : null;
  } catch (e) { context.log("anthropic error", e.message); return null; } finally { clearTimeout(timer); }
}

function templateCards(f) {
  const yr = f.year ? ` (${f.year})` : "";
  const who = f.mbArtist || f.artist || "the artist";
  const credits = f.credits.length ? f.credits.slice(0, 6).join(" · ") : "Producer/writer credits will fill in from open data.";
  const wiki = f.wiki || f.wikiArtist || "A short, sourced background will appear here.";
  return [
    { kicker: "The story", title: `About “${f.title}”${yr}`, body: wiki.slice(0, 240), extra: wiki.slice(240, 560) || "More background as we enrich the data." },
    { kicker: "The people", title: "Who made it", body: `Performed by ${who}.`, extra: credits },
    { kicker: "Connections", title: "How it connects", body: `Related artists and influences around ${who} map here.`, extra: "Built from open relationship data (MusicBrainz)." },
    { kicker: "Did you know", title: "A fact to share", body: f.wikiArtist ? f.wikiArtist.slice(0, 200) : `Tap to learn more about ${who}.`, extra: "Then go put the phone down and enjoy it out loud." }
  ];
}

async function getFacts(key, q, context) {
  let facts = factsCache.get(key);
  if (!facts) {
    facts = await gatherFacts(q.title, q.artist, context);
    capped(factsCache);
    factsCache.set(key, facts);
  }
  return facts;
}

module.exports = async function (context, req) {
  const q = {
    id: (req.query && req.query.id) || "",
    title: ((req.query && req.query.title) || "").trim(),
    artist: ((req.query && req.query.artist) || "").trim()
  };
  const fast = !!(req.query && (req.query.fast === "1" || req.query.fast === "true"));
  if (!q.title) {
    context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: { error: "Provide ?title=" } };
    return;
  }

  const key = cacheKey(q);
  // A finished (AI or final) payload always wins — instant.
  if (cache.has(key)) {
    context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }, body: cache.get(key) };
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const facts = await getFacts(key, q, context);

  // Phase 1 — instant open-data cards. If a key is set, tell the client an AI upgrade is coming.
  if (fast) {
    const payload = {
      track: { id: q.id, title: q.title, artist: q.artist },
      cards: templateCards(facts),
      _meta: {
        source: apiKey ? "open-data (AI pending)" : "open-data (add ANTHROPIC_API_KEY for AI)",
        aiPending: !!apiKey,
        year: facts.year || null,
        generatedAt: new Date().toISOString()
      }
    };
    // Not cached as final, so the follow-up full call still runs the AI.
    context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: payload };
    return;
  }

  // Phase 2 (or single-call) — AI cards if a key is set, else open-data.
  let cards = null;
  if (apiKey) cards = await writeCardsWithClaude(apiKey, facts, context);
  const aiUsed = !!(cards && cards.length);
  if (!aiUsed) cards = templateCards(facts);

  const payload = {
    track: { id: q.id, title: q.title, artist: q.artist },
    cards,
    _meta: { source: aiUsed ? "ai+open-data" : "open-data (add ANTHROPIC_API_KEY for AI)", year: facts.year || null, generatedAt: new Date().toISOString() }
  };
  capped(cache);
  cache.set(key, payload);

  context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }, body: payload };
};
