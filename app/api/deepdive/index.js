// GET /api/deepdive?id=&title=&artist=
// Phase 1 STUB: returns a correctly-shaped deep-dive payload so the UI is real.
//
// Phase 2 will replace generate() with the real pipeline:
//   1) cacheGet(key)  -> if hit, return instantly (cache-first reuse across users)
//   2) on miss: fetch open data (MusicBrainz / Wikidata / Discogs)
//   3) LLM writes the cards, constrained to the retrieved facts (accuracy guardrail)
//   4) cachePut(key, payload)  -> Cosmos DB / Table Storage (free tier)
//
// The contract (the `cards` array) stays the same, so the front-end never changes.

function cacheKey(q) {
  return ("song:" + (q.id || (q.title + "|" + q.artist))).toLowerCase().replace(/\s+/g, "_");
}

// --- Phase 1 placeholder generator (no external calls yet) ---
function generate(q) {
  var title = q.title || "this track";
  var artist = q.artist || "the artist";
  return {
    track: { id: q.id || "", title: q.title || "", artist: q.artist || "" },
    cards: [
      {
        kicker: "The story",
        title: "What's behind “" + title + "”",
        body: "A short, engaging take on the song's origin and meaning will appear here — written from open-data facts in Phase 2.",
        extra: "Go-deeper view: the fuller narrative (recording, era, themes) expands here on demand, keeping the first glance light."
      },
      {
        kicker: "The people",
        title: "Who made it",
        body: "Producers, writers, and players behind " + artist + " — sourced from MusicBrainz/Discogs credits.",
        extra: "Each contributor links to their other notable work, so you can follow the threads."
      },
      {
        kicker: "Connections",
        title: "How it connects",
        body: "Collaborations, influences, and related artists — our story-driven 'music DNA', built from open relationships data.",
        extra: "Rendered as a small map in a later phase; for now, a ranked list of the strongest links."
      },
      {
        kicker: "Did you know",
        title: "A fact to share",
        body: "A surprising, shareable tidbit about " + title + " — the kind of thing you'd text a friend.",
        extra: "These become the shareable cards that drive growth (your chosen channel)."
      }
    ],
    _meta: { stub: true, key: cacheKey(q), generatedAt: new Date().toISOString() }
  };
}

module.exports = async function (context, req) {
  var q = {
    id: (req.query && req.query.id) || "",
    title: (req.query && req.query.title) || "",
    artist: (req.query && req.query.artist) || ""
  };

  if (!q.id && !q.title) {
    context.res = { status: 400, headers: { "Content-Type": "application/json" }, body: { error: "Provide ?id= or ?title=" } };
    return;
  }

  // Phase 2 seam: const cached = await cacheGet(cacheKey(q)); if (cached) return cached;
  var payload = generate(q);

  context.res = {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      // cache-first intent: safe to cache identical song payloads at the edge
      "Cache-Control": "public, max-age=86400"
    },
    body: payload
  };
};
