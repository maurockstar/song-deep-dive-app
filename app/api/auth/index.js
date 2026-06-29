// POST /api/auth        { username, password }  -> sets session cookie on success
// POST /api/auth?logout=1                        -> clears the session cookie
const A = require("../shared/auth");

module.exports = async function (context, req) {
  const headers = Object.assign({ "Content-Type": "application/json", "Cache-Control": "no-store" }, A.corsHeaders(req));

  if (req.method === "OPTIONS") { context.res = { status: 204, headers }; return; }

  if (req.query && (req.query.logout === "1" || req.query.logout === "true")) {
    context.res = { status: 200, headers: Object.assign({}, headers, { "Set-Cookie": A.cookieHeader("", 0) }), body: { ok: true } };
    return;
  }

  if (!A.isEnabled()) {
    context.res = { status: 503, headers, body: { ok: false, enabled: false, error: "Sign-in isn't configured yet." } };
    return;
  }

  const b = req.body || {};
  const username = String(b.username || "").trim().toLowerCase();
  const password = String(b.password || "");
  if (!username || !password) {
    context.res = { status: 400, headers, body: { ok: false, error: "Enter a username and password." } };
    return;
  }

  const user = A.loadUsers().find(u => u && String(u.u).toLowerCase() === username);
  // Always run a verify (even on unknown user) to keep timing uniform.
  const ok = A.verifyPassword(password, user || { salt: "00", hash: "00" });
  if (!user || !ok) {
    context.res = { status: 401, headers, body: { ok: false, error: "Wrong username or password." } };
    return;
  }

  const token = A.signSession(user.u);
  context.res = {
    status: 200,
    headers: Object.assign({}, headers, { "Set-Cookie": A.cookieHeader(token) }),
    body: { ok: true, user: { u: user.u, role: user.role || "user" } }
  };
};
