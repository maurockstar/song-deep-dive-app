// GET /api/suggest?term=
// Type-ahead song suggestions for the Dive box.
// Source: Apple's free, public iTunes Search API (no key, no auth).
// Proxied server-side so the browser never hits a CORS wall.

const ITUNES = "https://itunes.apple.com/search";
const cache = new Map();
const CACHE_MAX = 300;

async function jget(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 6000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

const A = require("../shared/auth");
module.exports = async function (context, req) {
  if (A.blockIfUnauthed(context, req)) return;
  const term = ((req.query && req.query.term) || "").trim();
  if (term.length < 2) {
    context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { suggestions: [] } };
    return;
  }

  const key = term.toLowerCase();
  if (cache.has(key)) {
    context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }, body: cache.get(key) };
    return;
  }

  const url = `${ITUNES}?term=${encodeURIComponent(term)}&entity=song&media=music&limit=6`;
  const data = await jget(url);

  const seen = new Set();
  const suggestions = [];
  if (data && Array.isArray(data.results)) {
    for (const r of data.results) {
      const title = r.trackName, artist = r.artistName;
      if (!title || !artist) continue;
      const dedupe = (title + "|" + artist).toLowerCase();
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      suggestions.push({
        title: title,
        artist: artist,
        art: (r.artworkUrl60 || r.artworkUrl100 || "").replace("60x60bb", "80x80bb")
      });
    }
  }

  const payload = { suggestions };
  if (cache.size > CACHE_MAX) cache.clear();
  cache.set(key, payload);

  context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }, body: payload };
};
