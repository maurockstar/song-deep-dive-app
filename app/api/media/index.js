// GET /api/media?artist=&title=[&album=&year=]
// Artist media from free public sources — no API key. Photos are VERIFIED to depict the artist AND
// ERA-ALIGNED to the album: the FIRST photo reflects the album's era (a 1966 psychedelic-era record shows
// 1966 band photos, not early-60s ones). Sources, most-official first:
//   • the album's Wikipedia ARTICLE images (curated + era-correct by construction)
//   • the artist's Wikipedia MUSIC article (infobox lead + article images)
//   • the artist's Wikidata-linked Commons CATEGORY (P373), heavily context-filtered
//   • album / single artwork via iTunes (gallery only)
// Photos are ranked by closeness to the album's year, and the cache is keyed by ALBUM, so each record is a
// unique combination (same combo only for the same album/artist). We reject wrong-context files (events,
// exhibitions, tributes, statues, slides, merch, documents) and never free-text search Commons.

const ITUNES = "https://itunes.apple.com/search";
const WIKI = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WIKIDATA = "https://www.wikidata.org/w/api.php";
const COMMONS_FP = "https://commons.wikimedia.org/wiki/Special:FilePath/";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const DEEZER = "https://api.deezer.com/search/artist?limit=1&q=";
const MB_BASE = "https://musicbrainz.org/ws/2";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const PURGE_TOKEN = "gk_purge_7Qm2Xr9Lp4Vt";  // server-side only (not shipped to the browser); gates cache re-curation
const CAP_TTL = 60 * 60 * 24 * 90;

const cache = new Map();
const CACHE_MAX = 300;

function nrm(x) { return (x || "").toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function primaryArtist(a) { return String(a || "").split(/,|;|\/|\bfeat\.?\b|\bfeaturing\b|\bwith\b|\bx\b|\bvs\.?\b/i)[0]; }
// A word-boundary regex of the artist's DISTINCTIVE words (drops "the/and/of...") so a file named
// "Beatles and George Martin in studio 1966" matches "The Beatles" (glued "thebeatles" would not).
function artistNameRe(artist) {
  const stop = { the: 1, a: 1, an: 1, and: 1, of: 1, feat: 1, featuring: 1, with: 1, los: 1, las: 1, les: 1, die: 1, der: 1, das: 1, la: 1, le: 1, el: 1 };
  const words = String(artist || "").toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w && !stop[w]; });
  if (!words.length) return null;
  const esc = function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); };
  return new RegExp("\\b(" + words.map(esc).join("|") + ")\\b", "i");
}
// First plausible year in a caption/filename (1850s..2099).
function photoYear(s) { const m = String(s || "").match(/\b(18[5-9]\d|19\d\d|20\d\d)\b/); return m ? +m[1] : null; }
function fileCaption(file) {
  return file.replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " ").replace(/\s*@\s*/g, " at ").replace(/\(\s*[\d ]+\s*\)/g, "").replace(/\s+/g, " ").trim();
}
// Stable identity for an image so the SAME picture from different sources/sizes de-dupes.
function photoId(u) {
  if (!u) return "";
  let s = String(u).split("?")[0];
  const m = s.match(/Special:FilePath\/(.+)$/i);
  if (m) { try { return "wm:" + nrm(decodeURIComponent(m[1])); } catch (e) { return "wm:" + nrm(m[1]); } }
  s = s.replace(/\/\d+x\d+bb\.(jpg|png)$/i, "");
  return nrm(s);
}
function baseAlbumKey(x) {
  return (x || "").toLowerCase()
    .replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(remaster(ed)?|deluxe|expanded|extended|edition|version|anniversary|mono|stereo|explicit|clean|bonus|reissue|reissued|single|ep|live|ost|soundtrack|special|collector'?s?|super)\b/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");
}

const HTTP_UA = "geeek/1.0 (https://geeek.fm; media)"; // Wikipedia/Commons require a descriptive UA
async function jget(url, headers, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 10000);
  try {
    const h = Object.assign({ "User-Agent": HTTP_UA, "Accept": "application/json" }, headers || {});
    const r = await fetch(url, { headers: h, signal: ctrl.signal });
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
    let file = (origUrl.indexOf("/thumb/") > -1 && parts.length >= 2) ? parts[parts.length - 2] : parts[parts.length - 1];
    file = file.replace(/^(?:lossy-page\d+-)?\d+px-/, "");
    return "https://" + host + "/wiki/Special:FilePath/" + encodeURIComponent(file) + "?width=" + width;
  } catch (e) { return origUrl; }
}

// iTunes albums, restricted to the primary artist (gallery only).
async function albums(artist) {
  if (!artist) return [];
  const pa = nrm(primaryArtist(artist));
  const d = await jget(ITUNES + "?term=" + encodeURIComponent(artist) + "&entity=album&media=music&limit=25", {});
  const results = (d && d.results) || [];
  const seen = {}, out = [];
  for (const r of results) {
    if (!r.artworkUrl100 || !r.collectionName) continue;
    const an = nrm(r.artistName || "");
    if (pa && an && an.indexOf(pa) === -1 && pa.indexOf(an) === -1) continue;
    const key = baseAlbumKey(r.collectionName);
    if (!key || seen[key]) continue;
    seen[key] = 1;
    out.push({ type: "album", url: hi(r.artworkUrl100, 1400), thumb: hi(r.artworkUrl100, 200), title: r.collectionName, credit: "Apple Music" });
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
  return { type: "album", url: hi(r.artworkUrl100, 1400), thumb: hi(r.artworkUrl100, 200), title: r.collectionName || title, credit: "Apple Music" };
}

async function deezerPhoto(artist) {
  if (!artist) return null;
  const d = await jget(DEEZER + encodeURIComponent(artist), {});
  const a = d && d.data && d.data[0];
  if (!a || !a.picture_xl) return null;
  if (a.picture_xl.indexOf("/artist//") > -1) return null;
  return { type: "photo", url: a.picture_xl, thumb: a.picture_medium || a.picture_big || a.picture_xl, title: a.name || artist, w: 1000, h: 1000, yr: null, src: "deezer", credit: "Deezer" };
}

const MUSIC_RE = /\b(band|duo|trio|quartet|quintet|sextet|musician|singer|songwriter|rapper|record producer|producer|dj|group|musical|guitarist|drummer|bassist|vocalist|rock|pop|hip[\s-]?hop|metal|jazz|orchestra|ensemble|composer|indie|folk|punk|soul|reggae|electronic|country|blues|rnb|r&b|artist)\b/i;
async function musicWiki(artist) {
  if (!artist) return null;
  const cands = [artist, artist + " (band)", artist + " (musician)", artist + " (singer)", artist + " (rapper)", artist + " (musical group)"];
  for (const c of cands) {
    const s = await jget(WIKI + encodeURIComponent(c) + "?redirect=true", {});
    if (!s || s.type === "disambiguation") continue;
    if (!MUSIC_RE.test((s.description || "") + " " + (s.extract || ""))) continue;
    const oi = s.originalimage || {};
    return { title: s.title, qid: s.wikibase_item || null, image: oi.source || "", w: oi.width || 0, h: oi.height || 0 };
  }
  return null;
}

async function wdClaim(qid, prop) {
  if (!qid) return null;
  const j = await jget(WIKIDATA + "?action=wbgetclaims&entity=" + encodeURIComponent(qid) + "&property=" + prop + "&format=json", {});
  const c = j && j.claims && j.claims[prop] && j.claims[prop][0];
  const v = c && c.mainsnak && c.mainsnak.datavalue && c.mainsnak.datavalue.value;
  return (typeof v === "string") ? v : null;
}

const BAD_FILE = /(logo|cover|album|poster|single|tracklist|setlist|ticket|autograph|signature|font|typeface|wordmark|vinyl|cassette|\bcd\b|artwork|sticker|flyer|\bmap\b|diagram|\bgraph\b|timeline|chart|discograph|\bmembers\b|line[\s_-]?up|infobox|\.svg|award|certificate|plaque|ceremony|tribute|convention|\bcamp\b|\bexpo\b|\bfair\b|exhibition|exhibit|ausstellung|\bmuseum\b|galerie|\bgallery\b|lounge|arkaden|booth|audience|\bcrowd\b|\bfans?\b|microphone|amplifier|projector|\bscreen\b|\bslide\b|presentation|wikipedia|statues?|sculpture|\bbust\b|waxwork|\bwax\b|tussaud|\bmural\b|graffiti|replica|impersonator|cover[\s_-]?band|cosplay|fan[\s_-]?art|fanart|mosaic|monument|memorial|\bgrave\b|headstone|tombstone|crossing|\bzebra\b|billboard|\bbanner\b|\bstamp\b|banknote|\bbook\b|magazine|newspaper|\bcomic\b|painting|drawing|sketch|caricature|cartoon|figurine|\btoy\b|\bmug\b|t[\s_-]?shirt|telegram|\bletter\b|document|manuscript|postcard|envelope|handwritten|typescript|\bmemo\b|receipt|invoice|contract|facsimile|\bfax\b|lyric[\s_-]?sheet)/i;
const OBJECT_RE = /(compressor|amplifier|\bamp\b|preamp|mixing[\s_-]?(?:desk|board|console)|\bmixer\b|\bconsole\b|equali[sz]er|synthesi[sz]er|\bsynth\b|fairchild|\bneve\b|\bssl\b|turntable|loudspeaker|rack[\s_-]?mount|beardsley|\bsleeve\b|floor[\s_-]?plan|blueprint|schematic|\bmap\b)/i; // studio gear / objects / artwork (not a photo of the people)
// Content Charter v1.1 (2026-07-07, CEO-approved) — "apolitical by design": no politicians, ceremonies,
// award galas, or state events in song galleries, regardless of who is pictured. An image is editorial:
// it must serve the song's feeling, and a Kennedy Center gala is not the blues.
const POLITICS_RE = /\b(president|vice[\s_-]?president|senator|congress|parliament|prime[\s_-]?minister|chancellor|governor|mayor|white[\s_-]?house|kennedy[\s_-]?center|state[\s_-]?dinner|state[\s_-]?visit|inauguration|election|campaign|politician|political|embassy|summit|nobel|grammy|grammys|brit[\s_-]?awards?|vmas?|hall[\s_-]?of[\s_-]?fame|induction|honou?rs|gala|red[\s_-]?carpet|premiere|press[\s_-]?conference|medal)\b/i;
// Charter v1.1 "essence-first": live/organic music-making imagery (stage, studio, rehearsal) outranks
// posed/context shots — the FIRST photo should feel like the music being made.
const LIVE_RE = /\b(live|concert|konzert|tour|touring|gig|festival|on[\s_-]?stage|stage|perform(?:s|ing|ance|ances)?|in[\s_-]?concert|unplugged|soundcheck|rehearsal|backstage|studio|recording[\s_-]?session)\b/i;
// "Magic moments" (CEO editorial direction, 2026-07-07): every band had venues/festivals/moments where
// everything clicked — Woodstock, Glastonbury, the Fillmore, Budokan. Photos from those iconic places
// outrank even generic live shots; era distance still applies after, so the moment matches the song's era.
const MAGIC_RE = /\b(woodstock|glastonbury|coachella|lollapalooza|ozzfest|monterey[\s_-]?pop|isle[\s_-]?of[\s_-]?wight|live[\s_-]?aid|us[\s_-]?festival|reading[\s_-]?festival|leeds[\s_-]?festival|newport[\s_-]?(?:folk|jazz)|montreux|roskilde|pinkpop|rock[\s_-]?am[\s_-]?ring|download[\s_-]?festival|donington|bonnaroo|austin[\s_-]?city[\s_-]?limits|fillmore|winterland|whisky[\s_-]?a[\s_-]?go[\s_-]?go|cbgb|marquee[\s_-]?club|cavern[\s_-]?club|royal[\s_-]?albert[\s_-]?hall|madison[\s_-]?square[\s_-]?garden|wembley|red[\s_-]?rocks|budokan|hollywood[\s_-]?bowl|apollo[\s_-]?theater|grand[\s_-]?ole[\s_-]?opry|ryman|troubadour|knebworth|hyde[\s_-]?park|rockpalast|paradiso|tivoli|abbey[\s_-]?road|sun[\s_-]?studio|muscle[\s_-]?shoals|electric[\s_-]?lady|capitol[\s_-]?studios|headley[\s_-]?grange)\b/i;
// Charter v1.1 license compliance: CC BY / CC BY-SA images legally require visible attribution.
// Build "Author · License" from Commons extmetadata (HTML-stripped); null when unknown.
function licenseOf(ii) {
  const em = (ii && ii.extmetadata) || {};
  const strip = function (h) { return String(h || "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim(); };
  const credit = strip(em.Artist && em.Artist.value).slice(0, 60);
  const lic = strip(em.LicenseShortName && em.LicenseShortName.value).slice(0, 30);
  if (!credit && !lic) return null;
  return (credit || "Wikimedia Commons") + (lic ? " · " + lic : "");
}
// Fetch attribution for a single Commons/Wikipedia file (used for the infobox lead / Wikidata P18,
// which arrive without extmetadata). Accepts a bare filename or a full upload.wikimedia.org URL.
async function commonsCredit(fileOrUrl) {
  try {
    let file = String(fileOrUrl || ""), host = "commons.wikimedia.org";
    if (!file) return null;
    if (/^https?:/i.test(file)) {
      const mWiki = file.match(/\/wikipedia\/([a-z]+)\//);
      const wiki = (mWiki && mWiki[1]) || "commons";
      host = wiki === "commons" ? "commons.wikimedia.org" : (wiki + ".wikipedia.org");
      const parts = file.split("?")[0].split("/");
      file = (file.indexOf("/thumb/") > -1 && parts.length >= 2) ? parts[parts.length - 2] : parts[parts.length - 1];
      file = file.replace(/^(?:lossy-page\d+-)?\d+px-/, "");
      try { file = decodeURIComponent(file); } catch (e) {}
    }
    const j = await jget("https://" + host + "/w/api.php?action=query&titles=File:" + encodeURIComponent(file) + "&prop=imageinfo&iiprop=extmetadata&format=json&origin=*", {}, 6000);
    const pages = (j && j.query && j.query.pages) ? Object.values(j.query.pages) : [];
    const ii = pages[0] && pages[0].imageinfo && pages[0].imageinfo[0];
    return licenseOf(ii);
  } catch (e) { return null; }
}

// Curated images used on a Wikipedia ARTICLE (real photos of the subject). jpeg + min-size + not near-square
// (album covers/logos) + not a wrong-context/document file + must name the artist (word-boundary).
async function articleImages(articleTitle, nameTier, srcTag, max) {
  if (!articleTitle) return [];
  const u = WIKI_API + "?action=query&generator=images&gimlimit=50&titles=" + encodeURIComponent(articleTitle) +
    "&prop=imageinfo&iiprop=url|size|mime|extmetadata&format=json&origin=*";
  const j = await jget(u, {});
  const pages = (j && j.query && j.query.pages) ? Object.values(j.query.pages) : [];
  const out = [];
  for (const p of pages) {
    const ii = (p.imageinfo && p.imageinfo[0]) || null;
    if (!ii || !/jpe?g/i.test(ii.mime || "")) continue;
    if (!(ii.width >= 600 && ii.height >= 400)) continue;
    if (Math.abs(ii.width - ii.height) <= Math.max(ii.width, ii.height) * 0.06) continue;
    const file = (p.title || "").replace(/^File:/, "");
    const clean = file.replace(/_/g, " ");
    if (BAD_FILE.test(file) || OBJECT_RE.test(clean) || POLITICS_RE.test(clean)) continue; // charter v1.1: junk + gear + politics/ceremony all out
    // Keep only photos of the ACT (name in filename) or a NAMED band member (full name present). This drops
    // context images that merely sit in the article (related acts, gear, buildings, places).
    const tier = nameTier ? nameTier(clean) : 0;
    if (tier < 0) continue;
    const host = /\/wikipedia\/commons\//.test(ii.url || "") ? "commons.wikimedia.org" : "en.wikipedia.org";
    const base = "https://" + host + "/wiki/Special:FilePath/" + encodeURIComponent(file);
    const cap = fileCaption(file);
    out.push({ type: "photo", url: base + "?width=1200", thumb: base + "?width=400", title: cap.slice(0, 60), w: ii.width, h: ii.height, yr: photoYear(cap), named: tier === 0, src: srcTag, credit: licenseOf(ii) });
    if (out.length >= (max || 10)) break;
  }
  return out;
}

// The ALBUM's own Wikipedia article — images here are era-correct by construction.
async function albumArticlePhotos(album, artist, nameTier, max) {
  if (!album) return [];
  const cands = [album + " (" + primaryArtist(artist).trim() + " album)", album + " (album)"];
  for (const c of cands) {
    const ph = await articleImages(c, nameTier, "album-article", max);
    if (ph.length) return ph;
  }
  return [];
}

// Photos from the artist's Wikidata Commons category (P373), context-filtered + artist-name matched.
async function categoryPhotos(cat, nameTier, max) {
  if (!cat) return [];
  const u = COMMONS_API + "?action=query&generator=categorymembers&gcmtitle=Category:" + encodeURIComponent(cat) +
    "&gcmtype=file&gcmlimit=50&prop=imageinfo&iiprop=url|size|mime|extmetadata&format=json&origin=*";
  const j = await jget(u, {});
  const pages = (j && j.query && j.query.pages) ? Object.values(j.query.pages) : [];
  const out = [];
  for (const p of pages) {
    const ii = (p.imageinfo && p.imageinfo[0]) || null;
    if (!ii || !/jpe?g/i.test(ii.mime || "")) continue;
    if (!(ii.width >= 600 && ii.height >= 400)) continue;
    if (Math.abs(ii.width - ii.height) <= Math.max(ii.width, ii.height) * 0.06) continue;
    const file = (p.title || "").replace(/^File:/, "");
    const clean = file.replace(/_/g, " ");
    if (BAD_FILE.test(file) || OBJECT_RE.test(clean) || POLITICS_RE.test(clean)) continue; // charter v1.1: junk + gear + politics/ceremony all out
    const tier = nameTier ? nameTier(clean) : 0;
    if (tier < 0) continue;
    const cap = fileCaption(file);
    out.push({ type: "photo", url: commonsFilePath(file, 1200), thumb: commonsFilePath(file, 400), title: cap.slice(0, 60), w: ii.width, h: ii.height, yr: photoYear(cap), named: tier === 0, src: "commons-cat", credit: licenseOf(ii) });
    if (out.length >= (max || 10)) break;
  }
  return out;
}

// ---- shared caption cache (Upstash Redis REST; inert until env vars are set) ----
async function redisCmd(cmd, ms) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 4000);
  try {
    const r = await fetch(REDIS_URL, { method: "POST", headers: { "Authorization": "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" }, body: JSON.stringify(cmd), signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && Object.prototype.hasOwnProperty.call(j, "result")) ? j.result : null;
  } catch (e) { return null; } finally { clearTimeout(timer); }
}
async function capGet(k) { const v = await redisCmd(["GET", k]); if (!v || typeof v !== "string") return null; try { return JSON.parse(v); } catch (e) { return null; } }
async function capSet(k, obj) { try { await redisCmd(["SET", k, JSON.stringify(obj), "EX", String(CAP_TTL)]); } catch (e) {} }

// Rule-based fallback caption: strip the year, archive codes, photo numbers, camera/scan cruft -> short who/what.
function cleanTitle(cap, artist) {
  let s = " " + String(cap || "") + " ";
  s = s.replace(/\b(18[5-9]\d|19\d\d|20\d\d)\b/g, " ");
  s = s.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
  s = s.replace(/\bbestanddeelnr\b[\s\S]*$/i, " ");
  s = s.replace(/\b(cropped|centered|centred|scan(ned)?|retouched|retusche|press ?photo|capitol records|records|official|hi[\s-]?res|version|edit|final|photo|image|jpe?g)\b/gi, " ");
  s = s.replace(/\b(no|nr|number|part|pt|vol)\.?\s*\d+\b/gi, " ");
  s = s.replace(/\b\d{4,}\b/g, " ");
  s = s.replace(/[-\u2013\u2014_]+/g, " ").replace(/\s{2,}/g, " ").replace(/\s+\d{1,3}\s*$/, "").replace(/^[\s,]+|[\s,.]+$/g, "").trim();
  if (!s || s.length < 2) s = (primaryArtist(artist) || "The artist").trim();
  return s.slice(0, 48);
}

// One batched Claude call -> a short "who/what + link to the song" title per photo (no year; added later).
async function smartCaptions(apiKey, ctx, arr) {
  if (!apiKey || !arr.length) return null;
  const list = arr.map(function (c, i) { return (i + 1) + ". " + c; }).join("\n");
  const system = "You caption photos for a music app. Each image is given by its Wikimedia filename. For each, write a SHORT title (max 6 words) that says WHO or WHAT the photo shows and, when clear, how it connects to the song or artist. Rules: if the filename names an iconic venue or festival (Woodstock, Glastonbury, the Fillmore, Royal Albert Hall, Budokan...), NAME IT — those magic moments are the point; NEVER add a decade or era phrase (no \"Seventies era\", \"1970s\", or \"... era\") because the photo's own year is shown separately and an era guess can contradict it; describe WHO or WHAT the photo shows instead; NO year or date digits (added separately); do NOT invent — use only the filename plus well-known facts, and when unclear fall back to a clean generic like the artist/band name or \"On stage\" / \"In the studio\"; these are PHOTOS OF THE ARTIST/BAND, NEVER album artwork — never output \"album cover\", \"cover\" or \"artwork\"; if the filename contains the album title, treat it as the era/context or a publicity/press shot (e.g. a 1975 publicity shot), NOT the cover; prefer descriptive filename words (publicity, press, portrait, live, backstage, festival); no trailing punctuation; Title Case. Output STRICT JSON: an array of strings, exactly one per image, same order.";
  const user = "Song: \"" + ctx.title + "\" - " + ctx.artist + (ctx.album ? " (album: " + ctx.album + ")" : "") + "\n\nImages:\n" + list + "\n\nReturn a JSON array of " + arr.length + " short captions, in order.";
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 12000);
  try {
    const r = await fetch(ANTHROPIC_URL, { method: "POST", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 500, system: system, messages: [{ role: "user", content: user }] }), signal: ctrl.signal });
    if (!r.ok) return null;
    const data = await r.json();
    const text = (data.content && data.content[0] && data.content[0].text) || "";
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    if (!Array.isArray(parsed)) return null;
    return parsed.map(function (x) { return String(x || "").replace(/[\s.,;:]+$/, "").trim(); });
  } catch (e) { return null; } finally { clearTimeout(timer); }
}

// AI vision curation: Claude actually LOOKS at the candidate photos and returns the interesting, on-topic
// ones — dropping shots that don't depict THIS artist (objects/logos/places, the wrong subject like the
// chemical element "iron") and low-value ones (posed backstage grip-and-grins with fans/officials). Best
// first. Returns an ordered subset of the input, [] to mean "reject all", or null on failure.
async function fetchImageB64(url) {
  if (!url) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 8000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": HTTP_UA }, signal: ctrl.signal });
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    if (ct.indexOf("image/") !== 0) return null;
    const mime = ct.indexOf("png") > -1 ? "image/png" : ct.indexOf("webp") > -1 ? "image/webp" : ct.indexOf("gif") > -1 ? "image/gif" : "image/jpeg";
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > 4500000) return null;
    return { mime: mime, data: buf.toString("base64") };
  } catch (e) { return null; } finally { clearTimeout(timer); }
}
// meta.visStatus is set by the caller for diagnostics.
async function curatePhotos(apiKey, ctx, photos, meta) {
  if (!apiKey || !photos || photos.length < 2) { if (meta) meta.visStatus = "skip:few"; return null; }
  const cand = photos.slice(0, 10);
  const b64s = await Promise.all(cand.map(function (p) { return fetchImageB64(p.thumb || p.url); }));
  const valid = [];
  cand.forEach(function (p, i) { if (b64s[i]) valid.push({ p: p, b64: b64s[i] }); });
  if (valid.length < 2) { if (meta) meta.visStatus = "skip:noimgs(" + valid.length + ")"; return null; }
  const system = "You curate photographs for a music app's now-playing screen. You are shown a song and several numbered candidate photos, and you reply with JSON only.";
  const intro = "Song: \"" + (ctx.title || "") + "\" by " + (ctx.artist || "") +
    (ctx.album ? " (album \"" + ctx.album + "\"" + (ctx.year ? ", " + ctx.year : "") + ")" : "") + ".\n\n" +
    "Below are " + valid.length + " candidate photos. Choose the ones worth showing a music fan, ORDERED best first. ERA COMES FIRST: the first picks are shown most prominently, and they MUST show this act during the ERA of THIS song/album" + (ctx.year ? " (around " + ctx.year + ")" : "") + " \u2014 ideally the exact line-up that made this record. Do NOT lead with photos from a DIFFERENT era, however famous: no later reunions or one-off later events (e.g. a 2000s reunion show), and no earlier photos from before this record's era or line-up (e.g. a founding member who had already left the band). Among the era-correct photos, THEN prefer the most legendary and iconic \u2014 signature live moments, famous venues/festivals, the classic line-up, the definitive portrait of THIS era. Fame is only a tie-breaker AFTER era-match.\n" +
    "Every kept photo MUST clearly depict THIS artist/band AND belong to the song's era. If you are not confident a photo is from the right era, do NOT place it among the first three.\n" +
    "REJECT: anything that does not actually show this artist (objects, logos, places, the wrong subject such as a chemical element), the plain album FRONT cover, and low-value shots — posed grip-and-grins or handshakes with fans/officials, backstage meet-and-greets, blurry/tiny/watermarked, fan-made or memes, generic filler.\n" +
    "Reply with JSON only, best first, up to 6: {\"keep\":[photo numbers]}. Return the best available even if fewer than 3 are truly iconic. If none qualify: {\"keep\":[]}.";
  const content = [{ type: "text", text: intro }];
  valid.forEach(function (v, i) {
    content.push({ type: "text", text: "Photo " + (i + 1) + ":" });
    content.push({ type: "image", source: { type: "base64", media_type: v.b64.mime, data: v.b64.data } });
  });
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, 25000);
  try {
    const r = await fetch(ANTHROPIC_URL, { method: "POST", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify({ model: ANTHROPIC_MODEL, max_tokens: 150, system: system, messages: [{ role: "user", content: content }] }), signal: ctrl.signal });
    if (!r.ok) { if (meta) meta.visStatus = "http:" + r.status; return null; }
    const d = await r.json();
    const txt = (d.content && d.content[0] && d.content[0].text) || "";
    const mm = txt.match(/\{[\s\S]*\}/);
    if (!mm) { if (meta) meta.visStatus = "noparse"; return null; }
    const parsed = JSON.parse(mm[0]);
    if (!parsed || !Array.isArray(parsed.keep)) { if (meta) meta.visStatus = "nokeep"; return null; }
    const out = [];
    parsed.keep.forEach(function (n) { const i = (n | 0) - 1; if (i >= 0 && i < valid.length && out.indexOf(valid[i].p) < 0) out.push(valid[i].p); });
    if (meta) meta.visStatus = "ok:" + out.length + "/" + valid.length;
    return out;
  } catch (e) { if (meta) meta.visStatus = "err"; return null; } finally { clearTimeout(timer); }
}

// Official band members (MusicBrainz "member of band"), cached per artist. Their full names get whitelisted
// so a member's SOLO photo (e.g. "David Gilmour 1984") is kept, while unrelated people/places stay out.
async function bandMembers(artist) {
  const paName = primaryArtist(artist).trim();
  if (!paName) return [];
  const mkey = "sdd:mem:1:" + nrm(paName);
  const cached = await capGet(mkey);
  if (cached) return cached;
  let members = [];
  try {
    const sr = await jget(MB_BASE + "/artist?query=" + encodeURIComponent('artist:"' + paName + '"') + "&fmt=json&limit=1", {});
    const a = sr && sr.artists && sr.artists[0];
    if (a && a.id) {
      const d = await jget(MB_BASE + "/artist/" + a.id + "?inc=artist-rels&fmt=json", {});
      const rels = (d && d.relations) || [];
      const seen = {};
      rels.forEach(function (r) {
        if (!/member of band/i.test(r.type || "") || !r.artist || !r.artist.name) return;
        const words = String(r.artist.name).toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w && w.length >= 3; });
        if (words.length >= 2) { const k = words.join(" "); if (!seen[k]) { seen[k] = 1; members.push(words); } } // need first+last to avoid common-word false positives
      });
      members = members.slice(0, 12);
    }
  } catch (e) {}
  await capSet(mkey, members);
  return members;
}
// Returns a tier for a filename: 0 = the act itself, 1 = a named band member, -1 = neither (reject).
function makeNameTier(artist, members) {
  const artRe = artistNameRe(artist);
  const esc = function (w) { return w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); };
  const memberRes = (members || []).map(function (words) {
    return words.map(function (w) { return new RegExp("\\b" + esc(w) + "\\b", "i"); });
  });
  // IDENTITY / LEGAL SAFEGUARD. A file like "Richard Hawley and Norma Waterson" is a two-person shot whose
  // named co-subject we cannot verify is our artist (the leading name could be a same-named DIFFERENT person).
  // Reject any "... and/with <Other Full Name>" caption UNLESS that other person is a WHITELISTED band member
  // (then it is a legitimate group photo, e.g. two members of the same band together). Solo artists have no
  // members to whitelist, so their ambiguous duo shots are dropped; real band/among-members photos stay.
  const CO = /\b(?:and|with|feat\.?|featuring|ft\.?|meets|versus|vs\.?|und|avec|et|&|\+)\b\s+([A-Z\u00C0-\u00DE][A-Za-z\u00C0-\u00FF.'\u2019-]*(?:\s+[A-Z\u00C0-\u00DE][A-Za-z\u00C0-\u00FF.'\u2019-]*)+)/;
  const isMemberName = function (name) {
    for (let i = 0; i < memberRes.length; i++) {
      const res = memberRes[i];
      let all = true;
      for (let k = 0; k < res.length; k++) { if (!res[k].test(name)) { all = false; break; } }
      if (all && res.length) return true;
    }
    return false;
  };
  return function (clean) {
    const co = clean.match(CO);
    if (co && !isMemberName(co[1])) return -1;   // unverifiable second subject -> reject (namesake/legal safety)
    if (artRe && artRe.test(clean)) return 0;
    for (let i = 0; i < memberRes.length; i++) {
      const res = memberRes[i];
      let all = true;
      for (let k = 0; k < res.length; k++) { if (!res[k].test(clean)) { all = false; break; } }
      if (all && res.length) return 1;
    }
    return -1;
  };
}

const A = require("../shared/auth");
module.exports = async function (context, req) {
  // ---- maintenance: re-apply the latest photo logic for one artist by purging its cached ----
  // curation (sdd:vis) + captions (sdd:cap). Gated by a server-side token; no Apple auth needed.
  const _purge = (req.query && req.query.purge) || "";
  if (_purge) {
    if (_purge !== PURGE_TOKEN) { context.res = { status: 403, headers: { "Content-Type": "application/json" }, body: { error: "forbidden" } }; return; }
    const who = ((req.query && req.query.artist) || "").trim();
    if (!who) { context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: { error: "purge needs ?artist=" } }; return; }
    const a = who.toLowerCase().replace(/\s+/g, "_");
    const scanDel = async function (pattern) {
      let cursor = "0", total = 0, guard = 0;
      do {
        const r = await redisCmd(["SCAN", cursor, "MATCH", pattern, "COUNT", "300"]);
        if (!Array.isArray(r)) break;
        cursor = String(r[0]); const keys = r[1] || [];
        if (keys.length) { await redisCmd(["DEL"].concat(keys)); total += keys.length; }
      } while (cursor && cursor !== "0" && ++guard < 200);
      return total;
    };
    const vis = (await scanDel("sdd:vis:4:" + a + "|*")) + (await scanDel("sdd:vis:3:" + a + "|*"));
    const cap = await scanDel("sdd:cap:5:" + a + "|*");
    let mem = 0; for (const k of Array.from(cache.keys())) { if (k.indexOf(a + "|") === 0) { cache.delete(k); mem++; } }
    context.res = { status: 200, headers: { "Content-Type": "application/json" }, body: { ok: true, artist: who, purged: { vis: vis, cap: cap, mem: mem } } };
    return;
  }
  if (A.blockIfUnauthed(context, req)) return;
  const artist = ((req.query && req.query.artist) || "").trim();
  const title = ((req.query && req.query.title) || "").trim();
  const album = ((req.query && req.query.album) || "").trim();
  const eraYear = (+(String((req.query && req.query.year) || "").match(/\b(?:18|19|20)\d\d\b/) || [])[0]) || 0;
  const paPrimary = primaryArtist(artist).trim() || artist;
  if (!artist && !title) { context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: { error: "Provide ?artist= and/or ?title=" } }; return; }

  // Cache keyed by ALBUM so each record is its own combination (same combo only for the same album/artist).
  const key = (artist + "|" + (album || title)).toLowerCase().replace(/\s+/g, "_");
  if (cache.has(key)) { context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=600" }, body: cache.get(key) }; return; }

  // Resolve the artist's music article. Prefer the FULL name so a band whose name contains "&" or ","
  // (e.g. "Iron & Wine", "Earth, Wind & Fire") is NOT reduced to a fragment like "Iron" (the element).
  let mw = await musicWiki(artist);
  const pa = mw ? artist : paPrimary; // effective artist name for every other lookup
  if (!mw) mw = await musicWiki(paPrimary);
  const [dzPhoto, cover, albs, members] = await Promise.all([
    deezerPhoto(pa), songCover(title, pa), albums(pa), bandMembers(pa)
  ]);
  const nameTier = makeNameTier(artist, members); // full artist string keeps collaborators; members whitelist solo shots
  const albumPhotos = await albumArticlePhotos(album, artist, nameTier, 8);

  let leadInfobox = null, artPhotos = [], catPhotos = [], leadCreditRef = null;
  if (mw) {
    if (mw.image && mw.w >= 600) {
      leadInfobox = { type: "photo", url: wikiImg(mw.image, 1400), thumb: wikiImg(mw.image, 400), title: artist, w: mw.w, h: mw.h, yr: null, src: "wikipedia" };
      leadCreditRef = mw.image;
    }
    artPhotos = await articleImages(mw.title, nameTier, "wikipedia-article", 12);
    if (!artPhotos.length && mw.title) artPhotos = await articleImages(mw.title, nameTier, "wikipedia-article", 12); // one retry (cold Wikipedia can be slow)
    if (mw.qid) {
      const [cat, p18] = await Promise.all([wdClaim(mw.qid, "P373"), leadInfobox ? Promise.resolve(null) : wdClaim(mw.qid, "P18")]);
      if (!leadInfobox && p18) { leadInfobox = { type: "photo", url: commonsFilePath(p18, 1400), thumb: commonsFilePath(p18, 400), title: artist, w: 1000, h: 1000, yr: null, src: "wikidata-p18" }; leadCreditRef = p18; }
      if (cat) catPhotos = await categoryPhotos(cat, nameTier, 12);
    }
  }
  // Charter v1.1 license compliance: the infobox/P18 lead arrives without extmetadata — fetch its credit.
  if (leadInfobox && leadCreditRef) leadInfobox.credit = await commonsCredit(leadCreditRef);

  // Album-article photos are era-correct by context — if undated in the filename, treat them as the album era.
  albumPhotos.forEach(function (p) { if (!p.yr && eraYear) p.yr = eraYear; });

  // Build the photo pool. Two tiers: tier 0 = confirmed band photos (filename names the artist, or the
  // infobox/deezer artist image); tier 1 = other curated article images (band members, frontman,
  // collaborators, era/mood context). Tier-0 photos lead so the FIRST slot is the artist in
  // the right era; tier-1 photos enrich the later slots. This keeps well-documented acts photo-rich while
  // never letting a non-band context photo lead.
  if (leadInfobox) { leadInfobox.named = true; }
  const pool = [];
  function pushPool(p) { if (!p) return; if (p._tier === undefined) p._tier = p.named ? 0 : 1; pool.push(p); }
  albumPhotos.forEach(pushPool);
  pushPool(leadInfobox);
  artPhotos.forEach(pushPool);
  catPhotos.forEach(pushPool);
  // Deezer only as a last resort when we found NO photo at all AND the name matches.
  if (!pool.length && dzPhoto) {
    const re2 = artistNameRe(artist);
    if (re2 && re2.test(dzPhoto.title || "")) { dzPhoto.named = true; pushPool(dzPhoto); }
  }

  // Charter v1.1 "essence-first" + CEO "magic moments" ranking (2026-07-07): within confirmed-band
  // (tier 0) photos, iconic venue/festival shots (Woodstock, Fillmore, Budokan…) lead, then LIVE/organic
  // music-making shots (stage, studio, rehearsal), then era distance (the first photo should be closest
  // to the album's era; undated sinks below dated when we know the era), then resolution.
  var ERA_WINDOW = 15; // years: lead story photos must sit within this of the song's era
  pool.forEach(function (p) {
    var s = (p.title || "") + " " + (p.src || "");
    p._magic = MAGIC_RE.test(s) ? 0 : 1;
    p._live = (p._magic === 0 || LIVE_RE.test(s)) ? 0 : 1; // a magic venue counts as live/organic
    p._dist = eraYear ? (p.yr ? Math.abs(p.yr - eraYear) : 9999) : 0;
    // ERA-FIRST bucket: 0 = in the song's era (dated & close, or era-correct album-article photo);
    // 1 = undated / unknown year; 2 = dated but FAR off era. Off-era shots must never lead, however iconic.
    p._era = !eraYear ? 1 : (p._dist <= ERA_WINDOW ? 0 : (p._dist === 9999 ? 1 : 2));
  });
  // Era-first: drop DATED far-off-era photos from ANY source (a later reunion/exhibition must not lead an
  // older song, e.g. a 2005 Live 8 or a 2023 exhibition hall for a 1973 record) — but only while enough
  // in/near-era photos remain; otherwise keep them as a last resort so the story is never empty.
  var _inEra = pool.filter(function (p) { return p._era <= 1; });
  const ranked = (_inEra.length >= 3 ? _inEra : pool.slice());
  ranked.sort(function (a, b) {
    return (a._tier - b._tier) || (a._era - b._era) || (a._magic - b._magic) || (a._live - b._live) || (a._dist - b._dist) || ((b.w * b.h) - (a.w * a.h));
  });

  // ---- AI vision curation: keep only the interesting, on-topic photos (cached per song so it runs once) ----
  const apiKey = process.env.ANTHROPIC_API_KEY;
  let curated = ranked;
  const visMeta = {};
  if (apiKey && ranked.length >= 2) {
    const visKey = "sdd:vis:4:" + key; // v4 2026-07-08: era-FIRST lead-photo curation (bump if the prompt changes)
    let order = await capGet(visKey);
    if (order) { visMeta.visStatus = "cache"; }
    if (!order) {
      const picks = await curatePhotos(apiKey, { title: title, artist: pa, album: album, year: eraYear || null }, ranked, visMeta);
      if (picks) { order = picks.map(function (p) { return photoId(p.url); }); await capSet(visKey, order); }
    }
    if (order && order.length) {
      const byId = {}; ranked.forEach(function (p) { byId[photoId(p.url)] = p; });
      const sel = []; order.forEach(function (id) { if (byId[id]) sel.push(byId[id]); });
      if (sel.length) curated = sel;                    // AI-approved photos, in AI's preferred order
    } else if (order && order.length === 0) {
      curated = ranked.slice(0, 3);                     // AI rejected all -> show the top few rather than nothing
    }
  }

  const items = [];
  const seenUrl = {};
  function add(it) { if (!it) return; var k = photoId(it.url || ""); if (!k || seenUrl[k]) return; seenUrl[k] = 1; delete it._tier; delete it._dist; delete it._live; delete it._magic; delete it.named; items.push(it); }

  curated.forEach(add);        // AI-curated, era-ranked photos (lead reflects the album era)
  add(cover);                  // now-playing album cover (gallery)
  const coverKey = cover ? baseAlbumKey(cover.title) : "";
  for (const a of albs) {      // other album covers (gallery, edition-deduped)
    if (coverKey && baseAlbumKey(a.title) === coverKey) continue;
    add(a);
  }

  // ---- Rewrite each photo's caption: a short who/what title that links it to the song, then the year ----
  const photoItems = items.filter(function (x) { return x.type === "photo"; });
  if (photoItems.length) {
    const capKey = "sdd:cap:5:" + key; // v3 2026-07-07: magic-moment/era-insight caption prompt (bump if the prompt changes)
    let capMap = (await capGet(capKey)) || {};
    const missing = photoItems.filter(function (p) { return !capMap[photoId(p.url)]; });
    if (missing.length && apiKey) {
      const gen = await smartCaptions(apiKey, { title: title, artist: pa, album: album }, missing.map(function (p) { return p.title; }));
      if (gen && gen.length === missing.length) {
        missing.forEach(function (p, i) { if (gen[i]) capMap[photoId(p.url)] = gen[i].slice(0, 48); });
        await capSet(capKey, capMap);
      }
    }
    photoItems.forEach(function (p) {
      var short = capMap[photoId(p.url)] || cleanTitle(p.title, artist);
      p.title = short + (p.yr ? " \u00b7 " + p.yr : "");
    });
  }

  const payload = { artist, title, album: album || null, eraYear: eraYear || null, items, _meta: { source: "wikipedia-article+commons+itunes", artistArticle: mw && mw.title, albumEraPhotos: albumPhotos.length, vis: visMeta.visStatus || null, generatedAt: new Date().toISOString() } };
  const nPhoto = items.filter(function (x) { return x.type === "photo"; }).length;
  // Cache only a COMPLETE result: >=2 photos, or nothing more to get (no music article) — so a cold
  // Wikipedia timeout that returned just the infobox is NOT cached and simply retries next time.
  if (items.length && (nPhoto >= 2 || !mw)) { if (cache.size > CACHE_MAX) cache.clear(); cache.set(key, payload); }
  context.res = { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=600" }, body: payload };
};