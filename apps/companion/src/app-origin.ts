import type { IncomingMessage, ServerResponse } from "node:http";

// Capacitor 8 WebView page origins: Android serves the app from https://localhost
// (default androidScheme), iOS from capacitor://localhost (default iosScheme).
const PHONE_APP_ORIGINS = new Set(["https://localhost", "capacitor://localhost"]);
const METHODS = new Set(["GET", "HEAD"]);
// cache-control: phone builds up to 1.0.1 send it on the live stream
const HEADERS = ["Accept", "Authorization", "Cache-Control", "Last-Event-ID"];

export const isPhoneAppOrigin = (origin: string | undefined): origin is string =>
  typeof origin === "string" && PHONE_APP_ORIGINS.has(origin);

const allowOrigin = (res: ServerResponse, origin: string): void => {
  res.setHeader("access-control-allow-origin", origin);
};

/** Preflights carry no credential, so this answer grants nothing: the request
 * that follows must still bring a bearer the normal checks accept. */
export function answerPhoneAppPreflight(req: IncomingMessage, res: ServerResponse, origin: string): void {
  const method = req.headers["access-control-request-method"];
  const requested = String(req.headers["access-control-request-headers"] ?? "")
    .toLowerCase().split(",").map((value) => value.trim()).filter(Boolean);
  if (
    typeof method !== "string" || !METHODS.has(method) || !requested.includes("authorization")
    || requested.some((header) => !HEADERS.some((allowed) => allowed.toLowerCase() === header))
  ) {
    res.writeHead(403, { "cache-control": "no-store" }).end();
    return;
  }
  allowOrigin(res, origin);
  res.setHeader("access-control-allow-methods", method);
  res.setHeader("access-control-allow-headers", HEADERS.filter((header) => requested.includes(header.toLowerCase())).join(", "));
  res.setHeader("access-control-max-age", "600");
  res.writeHead(204, { "cache-control": "no-store" }).end();
}

/** Security invariant: the phone app's own WebView origin is admitted only on a
 * read that carries a bearer; every other Origin, and any tokenless request from
 * these origins (pairing, redemption), stays refused before authentication. */
export function admitPhoneAppRequest(req: IncomingMessage, res: ServerResponse, origin: string, token: string | undefined): boolean {
  if (!token || !METHODS.has(req.method ?? "GET")) return false;
  allowOrigin(res, origin);
  return true;
}
