// GET /api/amtoken
// Mints a short-lived Apple Music DEVELOPER token (ES256 JWT) so the web app
// can use MusicKit JS. The secret MusicKit private key never leaves the server.
//
// Set these as Application Settings in Azure (Static Web App → Configuration):
//   APPLE_MUSIC_PRIVATE_KEY = contents of your AuthKey_XXXXXXXXXX.p8 (the whole file,
//                             including the BEGIN/END lines; newlines or \n both OK)
//   APPLE_MUSIC_KEY_ID      = the 10-char Key ID of that MusicKit key
//   APPLE_TEAM_ID           = your 10-char Apple Developer Team ID
// Until all three are set, this endpoint returns {configured:false} and the
// web app simply hides the Apple Music button (nothing breaks).
//
// No external npm packages: the JWT is signed with Node's built-in crypto.

const crypto = require("crypto");

let cached = null; // { token, exp }

function b64url(input) {
  return Buffer.from(input).toString("base64")
    .replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function normalizeKey(k) {
  if (!k) return k;
  // Be tolerant of however the .p8 arrived: literal "\n", collapsed newlines
  // (pasting multi-line text into a single-line field turns line breaks into
  // spaces or removes them), CRLF, etc. Rebuild a clean PKCS8 PEM.
  if (k.indexOf("\\n") !== -1) k = k.replace(/\\n/g, "\n");
  const m = k.match(/-----BEGIN [^-]+-----([\s\S]*?)-----END [^-]+-----/);
  if (m) {
    const b64 = m[1].replace(/[^A-Za-z0-9+/=]/g, ""); // keep only base64 chars
    if (b64) {
      const wrapped = b64.match(/.{1,64}/g).join("\n");
      return "-----BEGIN PRIVATE KEY-----\n" + wrapped + "\n-----END PRIVATE KEY-----\n";
    }
  }
  return k;
}

function mintToken(privateKeyPem, keyId, teamId, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlSeconds;
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const payload = { iss: teamId, iat: now, exp: exp };
  const data = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(payload));
  const signer = crypto.createSign("SHA256");
  signer.update(data);
  signer.end();
  // Apple wants the raw R||S (JOSE / IEEE P1363) signature, not DER.
  const sig = signer.sign({ key: privateKeyPem, dsaEncoding: "ieee-p1363" });
  return { token: data + "." + b64url(sig), exp: exp };
}

module.exports = async function (context, req) {
  const keyRaw = process.env.APPLE_MUSIC_PRIVATE_KEY;
  const keyId = process.env.APPLE_MUSIC_KEY_ID;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!keyRaw || !keyId || !teamId) {
    context.res = {
      status: 501,
      headers: { "Content-Type": "application/json" },
      body: { configured: false, error: "Apple Music not configured yet" }
    };
    return;
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    if (cached && cached.exp - now > 3600) {
      context.res = {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=3600" },
        body: { configured: true, token: cached.token, exp: cached.exp }
      };
      return;
    }
    const pem = normalizeKey(keyRaw);
    cached = mintToken(pem, keyId, teamId, 150 * 24 * 3600); // 150 days (< 180 max)
    context.res = {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, max-age=3600" },
      body: { configured: true, token: cached.token, exp: cached.exp }
    };
  } catch (e) {
    context.log("amtoken signing error:", e.message);
    context.res = {
      status: 500,
      headers: { "Content-Type": "application/json" },
      body: { configured: false, error: "token signing failed" }
    };
  }
};
