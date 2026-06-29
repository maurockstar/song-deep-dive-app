// POST /api/apple-auth   { id_token }   (from Sign in with Apple JS)
// Verifies the Apple identity token, checks the approved allowlist, and on
// success issues the geeek session cookie. Apple-only login.
const A = require("../shared/auth");

module.exports = async function (context, req) {
  const headers = Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, A.corsHeaders(req));

  if (req.method === "OPTIONS") { context.res = { status: 204, headers }; return; }

  if (!A.isEnabled()) {
    context.res = { status: 503, headers, body: { ok: false, enabled: false, error: "Sign-in isn't configured yet." } };
    return;
  }

  const idToken = (req.body && (req.body.id_token || req.body.idToken)) || "";
  if (!idToken) { context.res = { status: 400, headers, body: { ok: false, error: "Missing Apple identity token." } }; return; }

  const claims = await A.verifyAppleIdToken(idToken);
  if (!claims) { context.res = { status: 401, headers, body: { ok: false, error: "Couldn't verify your Apple sign-in." } }; return; }

  const email = String(claims.email || "").toLowerCase();
  const sub = claims.sub;
  const match = A.appleAllowed(email, sub);
  if (!match) {
    context.res = {
      status: 403,
      headers,
      body: { ok: false, error: "This Apple ID isn't approved for geeek yet.", email: email || null }
    };
    return;
  }

  const identity = match.email || email || sub;
  const token = A.signSession(identity);
  context.res = {
    status: 200,
    headers: Object.assign({}, headers, { "Set-Cookie": A.cookieHeader(token) }),
    body: { ok: true, user: { email: email || null, role: match.role || "user" } }
  };
};
