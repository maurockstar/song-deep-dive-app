// GET /api/trivia?title=&artist=&subject=song|artist&difficulty=Easy|Medium|Hard&count=N&cats=song,artist,era
// Generates a multiple-choice question set with Claude, lightly grounded in Wikipedia
// summaries so the facts are accurate. Never asks about / reproduces lyrics.
// Cached in-memory (per function instance) and, when configured, in shared Upstash Redis.
//
// Requires ANTHROPIC_API_KEY (same key as /api/deepdive). Without it, returns { questions: [] }.

const WIKI = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";

const VERSION = "1.0";
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SHARED_TTL = 60 * 60 * 24 * 30; // 30 days

const cache = new Map();
const CACHE_MAX = 300;
function capped(map) { if (map.size > CACHE_MAX) map.clear(); }

async function jget(url, headers, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 7000);
  try {
    const r = await fetch(url, { headers: headers || {}, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

async function redisCmd(cmd, ms) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 4000);
  try {
    const r = await fetch(REDIS_URL, {
      method: "POST",
      headers: { "Authorization": "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(cmd), signal: ctrl.signal
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && Object.prototype.hasOwnProperty.call(j, "result")) ? j.result : null;
  } catch (e) { return null; } finally { clearTimeout(timer); }
}
async function sharedGet(k) { const v = await redisCmd(["GET", k]); if (!v || typeof v !== "string") return null; try { return JSON.parse(v); } catch (e) { return null; } }
async function sharedSet(k, p) { try { await redisCmd(["SET", k, JSON.stringify(p), "EX", String(SHARED_TTL)]); } catch (e) {} }

async function wikiSummary(candidates) {
  for (const c of candidates) {
    const s = await jget(WIKI + encodeURIComponent(c), {});
    if (s && s.extract && s.type !== "disambiguation") return s.extract.trim();
  }
  return "";
}

async function generate(apiKey, q, context) {
  const subjectIsArtist = q.subject === "artist";
  const subjectLabel = subjectIsArtist ? q.artist : `“${q.title}” by ${q.artist || "the artist"}`;

  // Light grounding so Claude's facts are accurate.
  const songWiki = subjectIsArtist ? "" : await wikiSummary(q.artist ? [`${q.title} (${q.artist} song)`, `${q.title} (song)`, q.title] : [`${q.title} (song)`, q.title]);
  const artistWiki = q.artist ? await wikiSummary([q.artist, `${q.artist} (band)`, `${q.artist} (musician)`, `${q.artist} (singer)`]) : "";

  let background = "";
  if (songWiki) background += `Wikipedia (song): ${songWiki}\n`;
  if (artistWiki) background += `Wikipedia (artist): ${artistWiki}\n`;
  if (!background) background = "(Open-data lookup was thin — rely on well-established, widely-known facts only.)\n";

  const system =
    "You are a music trivia author. You write fair, accurate multiple-choice questions.\n" +
    "RULES:\n" +
    "- Each question has EXACTLY 4 options and EXACTLY one correct answer.\n" +
    "- Base every question on well-established, verifiable facts: release year, album, label, band members, writers/producers, genre, instruments, notable covers/samples, awards, and cultural milestones.\n" +
    "- Use the BACKGROUND block when relevant; you may also use widely-known music knowledge. If you are not confident a fact is correct, do NOT use it.\n" +
    "- NEVER ask about, quote, or reproduce song lyrics.\n" +
    "- Make distractors plausible but clearly wrong to someone who knows the answer. Avoid trick wording and avoid two defensible answers.\n" +
    "- Match the requested difficulty (Easy = famous basics; Hard = deeper-cut facts a superfan would know).\n" +
    "- Keep questions and options concise.\n" +
    "Output STRICT JSON only — no prose, no markdown fences.";
  const user =
    `Subject: ${subjectLabel}\nDifficulty: ${q.difficulty}\nFocus categories: ${q.cats || "any"}\n\n` +
    `BACKGROUND:\n${background}\n` +
    `Write ${q.count} questions as STRICT JSON in exactly this shape:\n` +
    `{"questions":[{"q":"question text","options":["A","B","C","D"],"correct":0,"note":"one short sentence explaining the correct answer"}]}\n` +
    `"correct" is the 0-based index of the right option. Vary which index is correct across questions.`;

  const body = { model: ANTHROPIC_MODEL, max_tokens: Math.min(2000, 360 + q.count * 130), system, messages: [{ role: "user", content: user }] };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 22000);
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
    return Array.isArray(parsed.questions) ? parsed.questions : null;
  } catch (e) { context.log("anthropic error", e.message); return null; } finally { clearTimeout(timer); }
}

function clean(questions, count) {
  const out = [];
  for (const x of (questions || [])) {
    if (!x || typeof x.q !== "string") continue;
    const opts = Array.isArray(x.options) ? x.options.filter(o => typeof o === "string" && o.trim()).slice(0, 4) : [];
    if (opts.length !== 4) continue;
    let c = Number(x.correct);
    if (!(c >= 0 && c <= 3)) c = 0;
    out.push({ q: x.q.trim(), options: opts, correct: c, note: typeof x.note === "string" ? x.note.trim() : "" });
    if (out.length >= count) break;
  }
  return out;
}

const A = require("../shared/auth");
module.exports = async function (context, req) {
  if (A.blockIfUnauthed(context, req)) return;
  const q = {
    title: ((req.query && req.query.title) || "").trim(),
    artist: ((req.query && req.query.artist) || "").trim(),
    subject: (req.query && req.query.subject) === "artist" ? "artist" : "song",
    difficulty: ((req.query && req.query.difficulty) || "Medium").trim(),
    cats: (req.query && req.query.cats) || "",
    count: Math.max(3, Math.min(15, parseInt((req.query && req.query.count) || "10", 10) || 10))
  };
  if (q.subject === "song" && !q.title) { context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: { error: "Provide ?title= (or ?subject=artist&artist=)" } }; return; }
  if (q.subject === "artist" && !q.artist) { context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: { error: "Provide ?artist= for an artist quiz" } }; return; }

  const keyBase = (q.subject + ":" + q.title + "|" + q.artist + "|" + q.difficulty + "|" + q.count).toLowerCase().replace(/\s+/g, "_");
  const skey = "sdd:trivia:" + VERSION + ":" + keyBase;

  if (cache.has(keyBase)) { context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }, body: cache.get(keyBase) }; return; }
  const shared = await sharedGet(skey);
  if (shared && shared.questions && shared.questions.length) { cache.set(keyBase, shared); context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }, body: shared }; return; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  let questions = [];
  if (apiKey) { const raw = await generate(apiKey, q, context); questions = clean(raw, q.count); }

  const payload = { subject: q.subject, title: q.title, artist: q.artist, difficulty: q.difficulty, questions, _meta: { source: questions.length ? "ai" : (apiKey ? "ai-empty" : "no-key"), version: VERSION, generatedAt: new Date().toISOString() } };
  if (questions.length) { capped(cache); cache.set(keyBase, payload); await sharedSet(skey, payload); }

  context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": questions.length ? "public, max-age=86400" : "no-store" }, body: payload };
};
