// GET /api/deepdive?id=&title=&artist=
// Phase 2 — the real knowledge pipeline:
//   1) cache (in-memory)            -> instant on repeats
//   2) gather facts from open data  -> MusicBrainz + Wikipedia (free, no key)
//   3) AI writes the cards          -> Anthropic Claude Haiku, constrained to those facts
//   4) graceful fallback            -> plain open-data cards if no key / any failure
//
// To enable the AI step, add an Application Setting in Azure (Configuration):
//   ANTHROPIC_API_KEY = sk-ant-...
// Never commit the key to the repo. Until it's set, the app still works (open-data cards).

const MB_BASE = "https://musicbrainz.org/ws/2";
const MB_UA = "SongDeepDive/0.2 (https://zealous-pond-0200e1e10.7.azurestaticapps.net)"; // MusicBrainz requires a UA
const WIKI = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"; // change here if your account uses a different Haiku id

const cache = new Map();
const CACHE_MAX = 500;
function cacheKey(q) { return ("song:" + q.title + "|" + q.artist).toLowerCase().replace(/\s+/g, "_"); }

async function jget(url, headers, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 8000);
  try {
    const r = await fetch(url, { headers: headers || {}, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

async function gatherFacts(title, artist, context) {
  const facts = { title, artist, year: "", mbArtist: "", credits: [], wiki: "", wikiArtist: "" };
  // MusicBrainz: find the recording
  const query = encodeURIComponent(`recording:"${title}"` + (artist ? ` AND artist:"${artist}"` : ""));
  const search = await jget(`${MB_BASE}/recording?query=${query}&fmt=json&limit=1`, { "User-Agent": MB_UA });
  if (search && search.recordings && search.recordings[0]) {
    const rec = search.recordings[0];
    facts.mbArtist = (rec["artist-credit"] || []).map(a => a.name).join(", ");
    facts.year = (rec["first-release-date"] || "").slice(0, 4);
    const det = await jget(`${MB_BASE}/recording/${rec.id}?inc=artist-rels+work-rels&fmt=json`, { "User-Agent": MB_UA });
    if (det && Array.isArray(det.relations)) {
      for (const rel of det.relations) {
        if (rel.artist && rel.type) facts.credits.push(`${rel.type}: ${rel.artist.name}`);
      }
    }
  }
  // Wikipedia: short, sourced background for the song and the artist
  const w1 = await jget(WIKI + encodeURIComponent(title), {});
  if (w1 && w1.extract) facts.wiki = w1.extract;
  if (artist) {
    const w2 = await jget(WIKI + encodeURIComponent(artist), {});
    if (w2 && w2.extract) facts.wikiArtist = w2.extract;
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
  return s;
}

async function writeCardsWithClaude(apiKey, f, context) {
  const system = "You write short, warm, accurate music 'deep dive' cards for fans. Use ONLY the facts provided — never invent names, dates, collaborators, or claims. If the facts are thin, stay general and honest rather than guessing. Output STRICT JSON only — no prose, no markdown fences.";
  const user =
    `Facts:\n${factsBlock(f)}\n\n` +
    `Write four cards as STRICT JSON in exactly this shape:\n` +
    `{"cards":[` +
    `{"kicker":"The story","title":"max 6 words","body":"1-2 engaging sentences","extra":"1-2 sentence 'go deeper'"},` +
    `{"kicker":"The people","title":"...","body":"who made it","extra":"..."},` +
    `{"kicker":"Connections","title":"...","body":"how it connects to other music/artists","extra":"..."},` +
    `{"kicker":"Did you know","title":"...","body":"a surprising shareable fact","extra":"..."}` +
    `]}`;
  const body = { model: ANTHROPIC_MODEL, max_tokens: 1024, system, messages: [{ role: "user", content: user }] };
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
    { kicker: "Did you know", title: "A fact to share", body: f.wikiArtist ? f.wikiArtist.slice(0, 200) : `Tap to learn more about ${who}.`, extra: "Shareable cards arrive in Phase 3." }
  ];
}

module.exports = async function (context, req) {
  const q = {
    id: (req.query && req.query.id) || "",
    title: ((req.query && req.query.title) || "").trim(),
    artist: ((req.query && req.query.artist) || "").trim()
  };
  if (!q.title) {
    context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: { error: "Provide ?title=" } };
    return;
  }

  const key = cacheKey(q);
  if (cache.has(key)) {
    context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }, body: cache.get(key) };
    return;
  }

  const facts = await gatherFacts(q.title, q.artist, context);
  let cards = null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) cards = await writeCardsWithClaude(apiKey, facts, context);
  let aiUsed = !!(cards && cards.length);
  if (!aiUsed) cards = templateCards(facts);

  const payload = {
    track: { id: q.id, title: q.title, artist: q.artist },
    cards,
    _meta: { source: aiUsed ? "ai+open-data" : "open-data (add ANTHROPIC_API_KEY for AI)", year: facts.year || null, generatedAt: new Date().toISOString() }
  };
  if (cache.size > CACHE_MAX) cache.clear();
  cache.set(key, payload);

  context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }, body: payload };
};
