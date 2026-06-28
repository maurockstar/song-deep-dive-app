// GET/POST /api/log — lightweight client log sink backed by Upstash Redis.
//   POST { events:[...] }  → appends events to a capped list (newest first).
//   GET  ?n=300            → returns the most recent N events as JSON.
// Reuses the same Upstash REST credentials as /api/deepdive:
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
// Inert (ok:false) if Upstash isn't configured. Never throws.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = "sdd:logs";          // single rolling list of recent events
const CAP = 4000;                // keep at most this many events
const MAX_PER_POST = 200;

async function redisCmd(cmd, ms) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || 5000);
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

module.exports = async function (context, req) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
  };
  const method = (req.method || "GET").toUpperCase();

  if (method === "OPTIONS") { context.res = { status: 204, headers }; return; }

  if (!REDIS_URL || !REDIS_TOKEN) {
    context.res = { status: 200, headers, body: { ok: false, error: "log store not configured (set UPSTASH_REDIS_REST_URL / _TOKEN)" } };
    return;
  }

  try {
    if (method === "GET") {
      let n = parseInt((req.query && req.query.n) || "300", 10);
      if (!(n > 0)) n = 300;
      if (n > CAP) n = CAP;
      const raw = (await redisCmd(["LRANGE", KEY, "0", String(n - 1)])) || [];
      const events = raw.map(function (s) { try { return JSON.parse(s); } catch (e) { return { raw: s }; } });
      context.res = { status: 200, headers, body: { ok: true, count: events.length, events: events } };
      return;
    }

    // POST — append a batch of events.
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
    let events = (body && body.events) || (body && (body.cat || body.action) ? [body] : []);
    if (!Array.isArray(events) || !events.length) {
      context.res = { status: 400, headers, body: { ok: false, error: "no events" } };
      return;
    }
    const srvTs = new Date().toISOString();
    const ipRaw = (req.headers && (req.headers["x-forwarded-for"] || req.headers["x-azure-clientip"])) || "";
    const ip = String(ipRaw).split(",")[0].trim();
    const vals = events.slice(0, MAX_PER_POST).map(function (e) {
      e = (e && typeof e === "object") ? e : { msg: String(e) };
      e.srvTs = srvTs;
      if (ip && !e.ip) e.ip = ip;
      return JSON.stringify(e);
    });
    await redisCmd(["LPUSH", KEY].concat(vals));   // newest first
    await redisCmd(["LTRIM", KEY, "0", String(CAP - 1)]);
    context.res = { status: 200, headers, body: { ok: true, stored: vals.length } };
  } catch (e) {
    context.res = { status: 200, headers, body: { ok: false, error: String((e && e.message) || e) } };
  }
};
