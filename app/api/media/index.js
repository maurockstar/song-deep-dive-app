// GET /api/media?artist=&title=
// Artist media from free public sources — no API key:
//   • album / single artwork via the iTunes Search API (hi-res, upscaled)
//   • one artist photo via the Wikipedia REST summary (lead image)
// Returns { items: [{ type, url, thumb, title }], _meta }. Videos are a later phase.

const ITUNES = "https://itunes.apple.com/search";
const WIKI = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const DEEZER = "https://api.deezer.com/search/artist?limit=1&q=";

const cache = new Map();
const CACHE_MAX = 300;

async function jget(url, headers, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 7000);
  try {
    const r = await fetch(url, { headers: headers || {}, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

function hi(url, size) {
  // iTunes artwork urls look like .../100x100bb.jpg — swap for a larger square.
  if (!url) return "";
  return url.replace(/\/\d+x\d+bb\.(jpg|png)/i, "/" + (size || 600) + "x" + (size || 600) + "bb.$1");
}

async function albums(artist) {
  if (!artist) return [];
  const url = ITUNES + "?term=" + encodeURIComponent(artist) + "&entity=album&media=music&limit=14";
  const d = await jget(url, {});
  const results = (d && d.results) || [];
  const seen = {}, out = [];
  for (const r of results) {
    if (!r.artworkUrl100 || !r.collectionName) continue;
    const key = (r.collectionName || "").toLowerCase();
    if (seen[key]) continue;
    seen[key] = 1;
    out.push({ type: "album", url: hi(r.artworkUrl100, 1400), thumb: hi(r.artworkUrl100, 200), title: r.collectionName });
    if (out.length >= 8) break;
  }
  return out;
}

async function songCover(title, artist) {
  if (!title) return null;
  const url = ITUNES + "?term=" + encodeURIComponent((artist ? artist + " " : "") + title) + "&entity=song&media=music&limit=1";
  const d = await jget(url, {});
  const r = (d && d.results && d.results[0]) || null;
  if (!r || !r.artworkUrl100) return null;
  return { type: "album", url: hi(r.artworkUrl100, 1400), thumb: hi(r.artworkUrl100, 200), title: r.collectionName || title };
}

// High-res band/artist photo from Deezer (picture_xl = 1000x1000, no API key). Preferred lead image.
async function deezerPhoto(artist) {
  if (!artist) return null;
  const d = await jget(DEEZER + encodeURIComponent(artist), {});
  const a = d && d.data && d.data[0];
  if (!a || !a.picture_xl) return null;
  if (a.picture_xl.indexOf("/artist//") > -1) return null; // Deezer placeholder (artist has no photo)
  return {
    type: "photo",
    url: a.picture_xl,
    thumb: a.picture_medium || a.picture_big || a.picture_xl,
    title: a.name || artist,
    w: 1000, h: 1000,
    src: "deezer"
  };
}

// Rebuild a Wikimedia thumb URL at a chosen width (capped at the original) — crisp without pulling the multi-MB original.
function wikiSized(thumbUrl, origUrl, width) {
  if (thumbUrl && /\/\d+px-[^/]+$/.test(thumbUrl)) return thumbUrl.replace(/\/\d+px-([^/]+)$/, "/" + width + "px-$1");
  return origUrl || thumbUrl || "";
}
// Wikipedia/Commons infobox photo — encyclopedic, so it's a REAL band/artist photo (not a label logo).
async function artistPhoto(artist) {
  if (!artist) return null;
  const cands = [artist, artist + " (band)", artist + " (musician)", artist + " (singer)"];
  for (const c of cands) {
    const s = await jget(WIKI + encodeURIComponent(c), {});
    if (s && s.type !== "disambiguation" && s.originalimage && s.originalimage.source) {
      const orig = s.originalimage.source;
      const th = (s.thumbnail && s.thumbnail.source) || orig;
      return {
        type: "photo",
        url: wikiSized(th, orig, 1400),   // crisp lead + fullscreen, sane bandwidth
        thumb: wikiSized(th, orig, 400),
        title: artist,
        w: s.originalimage.width || 0,    // original width — used to prefer hi-res encyclopedic photos & gate tiny ones
        h: s.originalimage.height || 0,
        src: "wikipedia"
      };
    }
  }
  return null;
}

const A = require("../shared/auth");
module.exports = async function (context, req) {
  if (A.blockIfUnauthed(context, req)) return;
  const artist = ((req.query && req.query.artist) || "").trim();
  const title = ((req.query && req.query.title) || "").trim();
  if (!artist && !title) { context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: { error: "Provide ?artist= and/or ?title=" } }; return; }

  const key = (artist + "|" + title).toLowerCase().replace(/\s+/g, "_");
  if (cache.has(key)) { context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }, body: cache.get(key) }; return; }

  const [dzPhoto, wikiPhoto, cover, albs] = await Promise.all([deezerPhoto(artist), artistPhoto(artist), songCover(title, artist), albums(artist)]);

  const items = [];
  // A hi-res Wikipedia/Commons photo is a REAL band photo (never a logo) -> prefer it.
  // Otherwise use Deezer (usually a real photo, occasionally a logo), then a low-res Wikipedia as last resort.
  const photo = (wikiPhoto && wikiPhoto.w >= 600) ? wikiPhoto : (dzPhoto || wikiPhoto);
  if (photo) items.push(photo);
  if (cover) items.push(cover);
  for (const a of albs) {
    if (cover && a.title && cover.title && a.title.toLowerCase() === cover.title.toLowerCase()) continue;
    items.push(a);
  }

  const payload = { artist, title, items, _meta: { source: "itunes+wikipedia", generatedAt: new Date().toISOString() } };
  if (items.length) { if (cache.size > CACHE_MAX) cache.clear(); cache.set(key, payload); }
  context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }, body: payload };
};
