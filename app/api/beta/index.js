// Beta signups.
//   POST /api/beta { email }        -> append to the Upstash list "geeek:beta" (open; CORS for geeek.fm)
//   GET  /api/beta                  -> recent signups (admin: requires a valid session)
const A = require("../shared/auth");
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = "geeek:beta";

async function redis(cmd) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const r = await fetch(REDIS_URL, {
      method: "POST",
      headers: { "Authorization": "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(cmd)
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && Object.prototype.hasOwnProperty.call(j, "result")) ? j.result : null;
  } catch (e) { return null; }
}

module.exports = async function (context, req) {
  const headers = Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, A.corsHeaders(req));
  if (req.method === "OPTIONS") { context.res = { status: 204, headers }; return; }

  if (req.method === "GET") {
    // Admin view — requires a valid geeek session.
    if (!A.sessionFromReq(req)) { context.res = { status: 401, headers, body: { error: "Unauthorized" } }; return; }
    const items = (await redis(["LRANGE", KEY, "0", "999"])) || [];
    const signups = items.map(function (s) { try { return JSON.parse(s); } catch (e) { return { raw: s }; } });
    context.res = { status: 200, headers, body: { count: signups.length, signups: signups } };
    return;
  }

  // POST — open so prospective users can join the beta line.
  // Body may arrive as text/plain (to skip the CORS preflight from the website) — parse it.
  var body = req.body; if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const email = String((body && body.email) || "").trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) {
    context.res = { status: 400, headers, body: { ok: false, error: "Enter a valid email." } };
    return;
  }
  if (!REDIS_URL || !REDIS_TOKEN) { context.res = { status: 200, headers, body: { ok: true, stored: false } }; return; }
  const ip = String((req.headers && (req.headers["x-forwarded-for"] || req.headers["client-ip"])) || "").split(",")[0].trim();
  await redis(["LPUSH", KEY, JSON.stringify({ email: email, ts: new Date().toISOString(), ip: ip })]);
  context.res = { status: 200, headers, body: { ok: true } };
};
