// GET /api/media?artist=&title=
// Artist media from free public sources — no API key. Photos are VERIFIED to depict the artist:
//   • the artist's Wikipedia MUSIC article (gated by a band/musician description) — infobox photo (lead)
//   • the artist's Wikidata-linked Commons CATEGORY (P373) — curated files that ARE about this artist
//   • album / single artwork via the iTunes Search API (artist-name matched)
// We deliberately do NOT free-text search Commons: that matched e.g. "Part Time employees recognized
// for service" for a band named "Part Time". Deezer is only a last-resort lead (name-matched) when
// Wikipedia/Wikidata has nothing. Returns { items: [{ type, url, thumb, title }], _meta }.

const ITUNES = "https://itunes.apple.com/search";
const WIKI = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const WIKIDATA = "https://www.wikidata.org/w/api.php";
const COMMONS_FP = "https://commons.wikimedia.org/wiki/Special:FilePath/";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const DEEZER = "https://api.deezer.com/search/artist?limit=1&q=";

const cache = new Map();
const CACHE_MAX = 300;

function nrm(x) { return (x || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function primaryArtist(a) { return String(a || "").split(/,|&|;|\/|\bfeat\.?\b|\bfeaturing\b|\bwith\b|\bx\b|\bvs\.?\b/i)[0]; }
// Stable identity for an image so the SAME picture from different sources/sizes de-dupes.
function photoId(u) {
  if (!u) return "";
  let s = String(u).split("?")[0];
  const m = s.match(/Special:FilePath\/(.+)$/i);
  if (m) { try { return "wm:" + nrm(decodeURIComponent(m[1])); } catch (e) { return "wm:" + nrm(m[1]); } }
  s = s.replace(/\/\d+x\d+bb\.(jpg|png)$/i, "");   // iTunes: ignore the size segment
  return nrm(s);
}
// Collapse album editions: "King Animal (Deluxe Version)" == "King Animal".
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
  if (!url) return "";
  return url.replace(/\/\d+x\d+bb\.(jpg|png)/i, "/" + (size || 600) + "x" + (size || 600) + "bb.$1");
}
function commonsFilePath(file, width) { return COMMONS_FP + encodeURIComponent(file) + "?width=" + width; }
function wikiImg(origUrl, width) {
  if (!origUrl) return "";
  try {
    const mWiki = origUrl.match(/\/wikipedia\/([a-z]+)\//);
    const wiki = (mWiki && mWiki[1]) || "commons";
    const host = wiki === "commons" ? "commons.wikimedia.org" : (wiki + ".wikipedia.org");
    const parts = origUrl.split("?")[0].split("/");
    // Wikimedia serves scaled images as .../thumb/a/ab/RealName.jpg/1234px-RealName.jpg —
    // so for a /thumb/ URL the real file is the SECOND-to-last segment, NOT the last one
    // (the last one is "1234px-RealName.jpg", which does NOT exist as a Commons file → 404 → blank tile).
    let file = (origUrl.indexOf("/thumb/") > -1 && parts.length >= 2)
      ? parts[parts.length - 2]
      : parts[parts.length - 1];
    // Defensive: strip any leftover thumbnail-size prefix (e.g. "800px-", "lossy-page1-800px-").
    file = file.replace(/^(?:lossy-page\d+-)?\d+px-/, "");
    return "https://" + host + "/wiki/Special:FilePath/" + encodeURIComponent(file) + "?width=" + width;
  } catch (e) { return origUrl; }
}

// iTunes albums, restricted to the primary artist so a same-named different act can't leak in.
async function albums(artist) {
  if (!artist) return [];
  const pa = nrm(primaryArtist(artist));
  const d = await jget(ITUNES + "?term=" + encodeURIComponent(artist) + "&entity=album&media=music&limit=25", {});
  const results = (d && d.results) || [];
  const seen = {}, out = [];
  for (const r of results) {
    if (!r.artworkUrl100 || !r.collectionName) continue;
    const an = nrm(r.artistName || "");
    if (pa && an && an.indexOf(pa) === -1 && pa.indexOf(an) === -1) continue;   // artist-name match
    const key = baseAlbumKey(r.collectionName);
    if (!key || seen[key]) continue;
    seen[key] = 1;
    out.push({ type: "album", url: hi(r.artworkUrl100, 1400), thumb: hi(r.artworkUrl100, 200), title: r.collectionName });
    if (out.length >= 8) break;
  }
  return out;
}

async function songCover(title, artist) {
  if (!title) return null;
  const pa = nrm(primaryArtist(artist));
  const d = await jget(ITUNES + "?term=" + encodeURIComponent((artist ? artist + " " : "") + title) + "&entity=song&media=music&limit=3", {});
  const results = (d && d.results) || [];
  const r = results.find(function (x) { const an = nrm(x.artistName || ""); return !pa || !an || an.indexOf(pa) > -1 || pa.indexOf(an) > -1; }) || null;
  if (!r || !r.artworkUrl100) return null;
  return { type: "album", url: hi(r.artworkUrl100, 1400), thumb: hi(r.artworkUrl100, 200), title: r.collectionName || title };
}

async function deezerPhoto(artist) {
  if (!artist) return null;
  const d = await jget(DEEZER + encodeURIComponent(artist), {});
  const a = d && d.data && d.data[0];
  if (!a || !a.picture_xl) return null;
  if (a.picture_xl.indexOf("/artist//") > -1) return null; // Deezer placeholder
  return { type: "photo", url: a.picture_xl, thumb: a.picture_medium || a.picture_big || a.picture_xl, title: a.name || artist, w: 1000, h: 1000, src: "deezer" };
}

// Resolve to a VERIFIED Wikipedia MUSIC article (band/musician), returning { title, qid, image, w, h } or null.
// The description/extract must read like a musical act — this rejects disambiguations and non-music homographs
// (e.g. "Part-time" the employment term) so we never attach a random article's image to a song.
const MUSIC_RE = /\b(band|duo|trio|quartet|quintet|sextet|musician|singer|songwriter|rapper|record producer|producer|dj|group|musical|guitarist|drummer|bassist|vocalist|rock|pop|hip[\s-]?hop|metal|jazz|orchestra|ensemble|composer|indie|folk|punk|soul|reggae|electronic|country|blues|rnb|r&b|artist)\b/i;
async function musicWiki(artist) {
  if (!artist) return null;
  const cands = [artist, artist + " (band)", artist + " (musician)", artist + " (singer)", artist + " (rapper)", artist + " (musical group)"];
  for (const c of cands) {
    const s = await jget(WIKI + encodeURIComponent(c) + "?redirect=true", {});
    if (!s || s.type === "disambiguation") continue;
    if (!MUSIC_RE.test((s.description || "") + " " + (s.extract || ""))) continue;   // must be a musical act
    const oi = s.originalimage || {};
    return { title: s.title, qid: s.wikibase_item || null, image: oi.source || "", w: oi.width || 0, h: oi.height || 0 };
  }
  return null;
}

// A single Wikidata claim string (P373 = Commons category, P18 = image file).
async function wdClaim(qid, prop) {
  if (!qid) return null;
  const j = await jget(WIKIDATA + "?action=wbgetclaims&entity=" + encodeURIComponent(qid) + "&property=" + prop + "&format=json", {});
  const c = j && j.claims && j.claims[prop] && j.claims[prop][0];
  const v = c && c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value;
  return (typeof v === "string") ? v : null;
}

const BAD_FILE = /(logo|cover|album|poster|single|tracklist|setlist|ticket|autograph|signature|font|typeface|wordmark|vinyl|cassette|\bcd\b|artwork|sticker|flyer|\bmap\b|diagram|\bgraph\b|timeline|chart|discograph|\bmembers\b|line[\s_-]?up|infobox|\.svg|award|certificate|plaque|ceremony|tribute|convention|\bcamp\b|\bexpo\b|\bfair\b|exhibition|exhibit|ausstellung|\bmuseum\b|galerie|\bgallery\b|lounge|arkaden|booth|audience|\bcrowd\b|projector|\bscreen\b|\bslide\b|presentation|wikipedia|\bstatue\b|sculpture|\bbust\b|waxwork|\bwax\b|tussaud|\bmural\b|graffiti|replica|impersonator|cover[\s_-]?band|cosplay|fan[\s_-]?art|fanart|mosaic|monument|memorial|\bgrave\b|headstone|tombstone|crossing|\bzebra\b|billboard|\bbanner\b|\bstamp\b|banknote|\bbook\b|magazine|newspaper|\bcomic\b|painting|drawing|sketch|caricature|cartoon|figurine|\btoy\b|\bmug\b|t[\s_-]?shirt)/i;
// Verified photos = files in the artist's Wikidata Commons category (P373). Curated -> about THIS artist.
// We ALSO require the filename to reference the artist/category name, which drops the odd non-artist file
// that sits in the category (a venue, a plaque, a magazine) — so kept photos actually depict the artist.
async function categoryPhotos(cat, nameKeys, max) {
  if (!cat) return [];
  const keys = (nameKeys || []).filter(Boolean);
  const u = COMMONS_API + "?action=query&generator=categorymembers&gcmtitle=Category:" + encodeURIComponent(cat) +
    "&gcmtype=file&gcmlimit=50&prop=imageinfo&iiprop=url|size|mime&format=json&origin=*";
  const j = await jget(u, {});
  const pages = (j && j.query && j.query.pages) ? Object.values(j.query.pages) : [];
  const out = [];
  for (const p of pages) {
    const ii = (p.imageinfo && p.imageinfo[0]) || null;
    if (!ii || !/jpe?g/i.test(ii.mime || "")) continue;
    if (!(ii.width >= 600 && ii.height >= 400)) continue;
    if (Math.abs(ii.width - ii.height) <= Math.max(ii.width, ii.height) * 0.06) continue; // skip near-square (album covers / logos)
    const file = (p.title || "").replace(/^File:/, "");
    if (BAD_FILE.test(file)) continue;
    if (keys.length && !keys.some(function (k) { return nrm(file).indexOf(k) > -1; })) continue;  // must name the artist
    const cap = file.replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " ").replace(/\s*@\s*/g, " at ").replace(/\(\s*[\d ]+\s*\)/g, "").replace(/\s+/g, " ").trim();
    out.push({ type: "photo", url: commonsFilePath(file, 1200), thumb: commonsFilePath(file, 400), title: cap.slice(0, 60), w: ii.width, h: ii.height, src: "commons-cat" });
    if (out.length >= (max || 8)) break;
  }
  return out;
}

// Curated, on-topic photos from the artist's Wikipedia ARTICLE. Editors chose these images to depict the
// subject, so they are the most "official" source and far less likely to be an off-topic event/exhibition/
// slide/tribute file than the raw Commons category. jpeg + min-size + BAD_FILE + must reference the artist.
async function articlePhotos(articleTitle, nameKeys, max) {
  if (!articleTitle) return [];
  const keys = (nameKeys || []).filter(Boolean);
  const u = "https://en.wikipedia.org/w/api.php?action=query&generator=images&gimlimit=40&titles=" +
    encodeURIComponent(articleTitle) + "&prop=imageinfo&iiprop=url|size|mime&format=json&origin=*";
  const j = await jget(u, {});
  const pages = (j && j.query && j.query.pages) ? Object.values(j.query.pages) : [];
  const out = [];
  for (const p of pages) {
    const ii = (p.imageinfo && p.imageinfo[0]) || null;
    if (!ii || !/jpe?g/i.test(ii.mime || "")) continue;
    if (!(ii.width >= 600 && ii.height >= 400)) continue;
    if (Math.abs(ii.width - ii.height) <= Math.max(ii.width, ii.height) * 0.06) continue; // skip near-square (album covers / logos)
    const file = (p.title || "").replace(/^File:/, "");
    if (BAD_FILE.test(file)) continue;
    if (keys.length && !keys.some(function (k) { return nrm(file).indexOf(k) > -1; })) continue;
    const host = /\/wikipedia\/commons\//.test(ii.url || "") ? "commons.wikimedia.org" : "en.wikipedia.org";
    const base = "https://" + host + "/wiki/Special:FilePath/" + encodeURIComponent(file);
    const cap = file.replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " ").replace(/\s*@\s*/g, " at ").replace(/\(\s*[\d ]+\s*\)/g, "").replace(/\s+/g, " ").trim();
    out.push({ type: "photo", url: base + "?width=1200", thumb: base + "?width=400", title: cap.slice(0, 60), w: ii.width, h: ii.height, src: "wikipedia-article" });
    if (out.length >= (max || 8)) break;
  }
  return out;
}

const A = require("../shared/auth");
module.exports = async function (context, req) {
  if (A.blockIfUnauthed(context, req)) return;
  const artist = ((req.query && req.query.artist) || "").trim();
  const title = ((req.query && req.query.title) || "").trim();
  if (!artist && !title) { context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: { error: "Provide ?artist= and/or ?title=" } }; return; }

  const key = (artist + "|" + title).toLowerCase().replace(/\s+/g, "_");
  if (cache.has(key)) { context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }, body: cache.get(key) }; return; }

  const [mw, dzPhoto, cover, albs] = await Promise.all([
    musicWiki(artist), deezerPhoto(artist), songCover(title, artist), albums(artist)
  ]);

  // Verified photos, most-official first: article infobox (lead) -> curated Wikipedia ARTICLE images ->
  // the artist's Wikidata Commons category (now heavily context-filtered).
  let leadPhoto = null, artPhotos = [], catPhotos = [];
  if (mw) {
    if (mw.image && mw.w >= 600) {
      leadPhoto = { type: "photo", url: wikiImg(mw.image, 1400), thumb: wikiImg(mw.image, 400), title: artist, w: mw.w, h: mw.h, src: "wikipedia" };
    }
    artPhotos = await articlePhotos(mw.title, [nrm(primaryArtist(artist)), nrm(mw.title)], 10);
    if (mw.qid) {
      const [cat, p18] = await Promise.all([wdClaim(mw.qid, "P373"), leadPhoto ? Promise.resolve(null) : wdClaim(mw.qid, "P18")]);
      if (!leadPhoto && p18) leadPhoto = { type: "photo", url: commonsFilePath(p18, 1400), thumb: commonsFilePath(p18, 400), title: artist, w: 1000, h: 1000, src: "wikidata-p18" };
      if (cat) catPhotos = await categoryPhotos(cat, [nrm(cat), nrm(primaryArtist(artist))], 8);
    }
  }
  // Deezer only when we found NO verified photo AND the Deezer artist name matches (avoid a same-named act).
  if (!leadPhoto && !catPhotos.length && dzPhoto) {
    const pa = nrm(primaryArtist(artist));
    if (pa && (nrm(dzPhoto.title).indexOf(pa) > -1 || pa.indexOf(nrm(dzPhoto.title)) > -1)) leadPhoto = dzPhoto;
  }

  const items = [];
  const seenUrl = {};
  function add(it) { if (!it) return; var k = photoId(it.url || ""); if (!k || seenUrl[k]) return; seenUrl[k] = 1; items.push(it); }

  add(leadPhoto);              // 1) verified lead band photo (article infobox)
  artPhotos.forEach(add);      // 2) curated OFFICIAL photos from the artist's Wikipedia article
  catPhotos.forEach(add);      // 3) context-filtered photos from the artist's Commons category
  add(cover);                  // 3) the now-playing album cover
  const coverKey = cover ? baseAlbumKey(cover.title) : "";
  for (const a of albs) {      // 4) other album covers (artist-matched, edition-deduped)
    if (coverKey && baseAlbumKey(a.title) === coverKey) continue;
    add(a);
  }

  const payload = { artist, title, items, _meta: { source: "wikipedia+wikidata-commons+itunes", artistArticle: mw && mw.title, generatedAt: new Date().toISOString() } };
  if (items.length) { if (cache.size > CACHE_MAX) cache.clear(); cache.set(key, payload); }
  context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" }, body: payload };
};
