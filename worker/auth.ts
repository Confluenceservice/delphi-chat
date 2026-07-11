import type { Env } from "./types";

export function getUserEmail(request: Request): string | null {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return null;
  try {
    const payload = JSON.parse(atob(jwt.split(".")[1]));
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

export function resolveUserEmail(request: Request, env: Env): string | null {
  return getUserEmail(request) ?? (env.DEV_USER_EMAIL || null);
}
