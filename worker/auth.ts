import type { Env } from "./types";

interface AccessJwtPayload {
  email?: string;
  aud?: string | string[];
  iss?: string;
  exp?: number;
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

// Cloudflare Access rotates signing keys rarely; cache the JWKS per isolate
// instead of fetching it on every request.
let jwksCache: { keys: Jwk[]; fetchedAt: number; teamDomain: string } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

function base64UrlToUint8Array(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function base64UrlDecodeJson<T>(segment: string): T {
  const raw = atob(segment.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segment.length / 4) * 4, "="));
  return JSON.parse(raw) as T;
}

async function getJwks(teamDomain: string): Promise<Jwk[]> {
  const now = Date.now();
  if (jwksCache && jwksCache.teamDomain === teamDomain && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Failed to fetch Access JWKS: ${res.status}`);
  const data = await res.json<{ keys: Jwk[] }>();
  jwksCache = { keys: data.keys, fetchedAt: now, teamDomain };
  return data.keys;
}

async function verifyAccessJwt(jwt: string, env: Env): Promise<AccessJwtPayload | null> {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  if (!teamDomain || !aud) return null;

  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: string; kid?: string };
  let payload: AccessJwtPayload;
  try {
    header = base64UrlDecodeJson(headerB64);
    payload = base64UrlDecodeJson(payloadB64);
  } catch {
    return null;
  }

  if (header.alg !== "RS256" || !header.kid) return null;
  if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
  if (payload.iss !== teamDomain) return null;
  const audList = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
  if (!audList.includes(aud)) return null;
  if (typeof payload.email !== "string" || !payload.email) return null;

  const keys = await getJwks(teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const signature = base64UrlToUint8Array(sigB64);
  const signedData = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, signedData);
  if (!valid) return null;

  return payload;
}

export async function getUserEmail(request: Request, env: Env): Promise<string | null> {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return null;
  const payload = await verifyAccessJwt(jwt, env);
  return payload?.email ?? null;
}

export async function resolveUserEmail(request: Request, env: Env): Promise<string | null> {
  const verified = await getUserEmail(request, env);
  return verified ?? (env.DEV_USER_EMAIL || null);
}
