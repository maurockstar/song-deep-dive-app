// GET /api/session -> { enabled, authed, user? }
// When auth is dormant (not configured) returns authed:true so the gate falls open.
const A = require("../shared/auth");

module.exports = async function (context, req) {
  const headers = Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, A.corsHeaders(req));
  if (!A.isEnabled()) { context.res = { status: 200, headers, body: { enabled: false, authed: true } }; return; }
  const s = A.sessionFromReq(req);
  const appleClientId = A.appleClientId();
  const raw = A.parseCookies(req)[A.COOKIE];
  context.res = {
    status: 200,
    headers,
    body: s
      ? { enabled: true, authed: true, user: s.u, appleClientId: appleClientId, seenCookie: !!raw, tokenLen: raw ? raw.length : 0 }
      : { enabled: true, authed: false, appleClientId: appleClientId, seenCookie: !!raw, tokenLen: raw ? raw.length : 0 }
  };
};
