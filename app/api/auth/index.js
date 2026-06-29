// POST /api/auth?logout=1   -> clears the session cookie
// Password login was removed in favour of Sign in with Apple (see /api/apple-auth).
const A = require("../shared/auth");

module.exports = async function (context, req) {
  const headers = Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, A.corsHeaders(req));

  if (req.method === "OPTIONS") { context.res = { status: 204, headers }; return; }

  if (req.query && (req.query.logout === "1" || req.query.logout === "true")) {
    context.res = { status: 200, headers: Object.assign({}, headers, { "Set-Cookie": A.cookieHeader("", 0) }), body: { ok: true } };
    return;
  }

  context.res = { status: 410, headers, body: { ok: false, error: "Password sign-in is disabled. Use Sign in with Apple." } };
};
