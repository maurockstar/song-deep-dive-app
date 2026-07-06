// GET /api/media?artist=&title=
// Artist media from free public sources — no API key:
//   • album / single artwork via the iTunes Search API (hi-res, upscaled)
//   • one artist photo via the Wikipedia REST summary (lead image)
// Returns { items: [{ type, url, thumb, title }], _meta }. Videos are a later phase.

const ITUNES = "https://itunes.apple.com/search";
const WIKI = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const DEEZER = "https://api.deezer.com/search/artist?limit=1&q=";
const COMMONS = "https://commons.wikimedia.org/w/api.php";

const cache = new Map();
const CACHE_MAX = 300;

function nrm(x) { return (x || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
// Stable identity for an image so the SAME picture from different sources/sizes de-dupes.
// (Wikimedia Special:FilePath with underscores vs %20 and different ?width= are the SAME file.)
function photoId(u) {
  if (!u) return "";
  let s = String(u).split("?")[0];
  const m = s.match(/Special:FilePath\/(.+)$/i);
  if (m) { try { return "wm:" + nrm(decodeURIComponent(m[1])); } catch (e) { return "wm:" + nrm(m[1]); } }
  s = s.replace(/\/\d+x\d+bb\.(jpg|png)$/i, "");   // iTunes: ignore the size segment
  return nrm(s);
}
// Collapse album editions: "King Animal (Deluxe Version)" == "King Animal"; "Superunknown (20th Anniversary)" == "Superunknown (Deluxe Edition)".
function baseAlbumKey(x) {
  return (x || "").toLowerCase()
    .replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(remaster(ed)?|deluxe|expanded|extended|edition|version|anniversary|mono|stereo|explicit|clean|bonus|reissue|reissued|single|ep|live|ost|soundtrack|special|collector'?s?|super)\b/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

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
    const key = baseAlbumKey(r.collectionName);   // fuzzy: one cover per album, ignoring edition/remaster/year
    if (!key || seen[key]) continue;
    seen[key] = 1;
    out.push({ type: "album", url: hi(r.artworkUrl100, 1400), thumb: hi(r.artworkUrl100, 200), title: r.collectionName });
    if (out.length >= 8) break;
  }
  return out;
}

// Real band/concert/candid photos from Wikimedia Commons (free, no key). Great for variety beyond album art.
function commonsFilePath(file, width) {
  return "https://commons.wikimedia.org/wiki/Special:FilePath/" + encodeURIComponent(file) + "?width=" + width;
}
async function commonsPhotos(artist, max) {
  if (!artist) return [];
  const url = COMMONS + "?action=query&generator=search&gsrsearch=" + encodeURIComponent(artist) +
    "&gsrnamespace=6&gsrlimit=30&prop=imageinfo&iiprop=url|size|mime&format=json&origin=*";
  const j = await jget(url, {});
  const pages = (j && j.query && j.query.pages) ? Object.values(j.query.pages) : [];
  const bad = /(logo|cover|album|poster|single|tracklist|setlist|ticket|autograph|signature|font|typeface|wordmark|vinyl|cd|cassette|artwork|sticker|flyer|map|diagram|graph|timeline|chart|discograph|members|line[\s-]?up|tour dates|schedule|infobox|svg)/i;
  const artKey = nrm(artist);
  const seen = {}, out = [];
  for (const p of pages) {
    const ii = (p.imageinfo && p.imageinfo[0]) || null;
    if (!ii || !/jpe?g/i.test(ii.mime || "")) continue;            // photos only (logos are png/svg)
    if (!(ii.width >= 600 && ii.height >= 400)) continue;          // decent resolution
    const file = (p.title || "").replace(/^File:/, "");
    if (bad.test(file)) continue;                                  // skip logos/covers/merch
    if (nrm(file).indexOf(artKey) === -1) continue;                // must actually be about this artist
    const key = nrm(file);
    if (seen[key]) continue; seen[key] = 1;
    const cap = file.replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " ").replace(/\s*@\s*/g, " at ").replace(/\(\s*[\d ]+\s*\)/g, "").replace(/\s+/g, " ").trim();
    out.push({
      type: "photo",
      url: commonsFilePath(file, 1200),
      thumb: commonsFilePath(file, 400),
      title: cap.slice(0, 60) || artist,
      w: ii.width, h: ii.height,
      src: "commons"
    });
    if (out.length >= (max || 6)) break;
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

// Build a reliably-sized Wikimedia image URL via Special:FilePath (the /thumb/NNNpx- URLs 404 when hotlinked).
function wikiImg(origUrl, width) {
  if (!origUrl) return "";
  try {
    const mWiki = origUrl.match(/\/wikipedia\/([a-z]+)\//);
    const wiki = (mWiki && mWiki[1]) || "commons";
    const host = wiki === "commons" ? "commons.wikimedia.org" : (wiki + ".wikipedia.org");
    const file = origUrl.split("/").pop().split("?")[0];   // already URL-encoded in the source
    return "https://" + host + "/wiki/Special:FilePath/" + file + "?width=" + width;
  } catch (e) { return origUrl; }
}
// Wikipedia/Commons infobox photo — encyclopedic, so it's a REAL band/artist photo (not a label logo).
async function artistPhoto(artist) {
  if (!artist) return null;
  const cands = [artist, artist + " (band)", artist + " (musician)", artist + " (singer)"];
  for (const c of cands) {
    const s = await jget(WIKI + encodeURIComponent(c), {});
    if (s && s.type !== "disambiguation" && s.originalimage && s.originalimage.source) {
      const orig = s.originalimage.source;
      return {
        type: "photo",
        url: wikiImg(orig, 1400),   // crisp lead + fullscreen, sane bandwidth
        thumb: wikiImg(orig, 400),
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

  const [dzPhoto, wikiPhoto, commons, cover, albs] = await Promise.all([
    deezerPhoto(artist), artistPhoto(artist), commonsPhotos(artist, 8), songCover(title, artist), albums(artist)
  ]);

  const items = [];
  const seenUrl = {};
  function add(it) { if (!it) return; var k = photoId(it.url || ""); if (!k || seenUrl[k]) return; seenUrl[k] = 1; items.push(it); }

  // 1) Lead band photo — prefer a hi-res Wikipedia/Commons photo (real, never a logo), else Deezer.
  const lead = (wikiPhoto && wikiPhoto.w >= 600) ? wikiPhoto : (dzPhoto || wikiPhoto);
  add(lead);
  // 2) Real band/concert/candid photos from Commons — variety beyond album art.
  commons.forEach(add);
  // 3) Deezer photo ONLY as a fallback when we found no real photos (it's often just the band's logo).
  if (!items.length && dzPhoto) add(dzPhoto);
  // 4) Album art — the now-playing cover, then other albums (fuzzy-deduped, current album excluded).
  add(cover);
  const coverKey = cover ? baseAlbumKey(cover.title) : "";
  for (const a of albs) {
    if (coverKey && baseAlbumKey(a.title) === coverKey) continue;
    add(a);
  }

  const payload = { artist, title, items, _meta: { source: "itunes+wikipedia+commons", generatedAt: new Date().toISOString() } };
  if (items.length) { if (cache.size > CACHE_MAX) cache.clear(); cache.set(key, payload); }
  context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }, body: payload };
};
