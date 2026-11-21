// The Google sign-in URLs Antigravity CLI 1.5+ prints, the code or redirect a person pastes back, and the loopback
// callback forwarded to the CLI's own listener.
import { request as httpRequest } from "node:http";

export const ANTIGRAVITY_CODE_REDIRECT_URI = "https://antigravity.google/oauth-callback";

export interface AntigravityAuthorizationUrl {
  authorizationUrl: string;
  redirectUri: string;
  state: string;
}

export function parseAntigravityAuthorizationUrl(
  authorizationUrl: string,
  kind: "loopback" | "code" = "loopback",
): AntigravityAuthorizationUrl {
  if (authorizationUrl.length > 16_384 || /\s/u.test(authorizationUrl)) {
    throw new Error("Antigravity returned an invalid Google sign-in URL.");
  }
  const url = new URL(authorizationUrl);
  const state = url.searchParams.get("state");
  const redirectUri = url.searchParams.get("redirect_uri");
  const validPath = kind === "loopback"
    ? url.pathname === "/o/oauth2/v2/auth"
    : url.pathname === "/o/oauth2/auth" || url.pathname === "/o/oauth2/v2/auth";
  const validRedirect = kind === "loopback"
    ? Boolean(redirectUri && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/u.test(redirectUri))
    : redirectUri === ANTIGRAVITY_CODE_REDIRECT_URI;
  if (
    url.origin !== "https://accounts.google.com" ||
    !validPath ||
    url.username || url.password || url.hash ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.getAll("redirect_uri").length !== 1 ||
    url.searchParams.getAll("response_type").length !== 1 ||
    url.searchParams.get("response_type") !== "code" ||
    !state || state.length > 512 || /\s/u.test(state) ||
    !redirectUri || !validRedirect
  ) {
    throw new Error("Antigravity returned an invalid Google sign-in URL.");
  }
  if (kind === "loopback") {
    const redirect = new URL(redirectUri);
    if (Number(redirect.port) < 1024 || Number(redirect.port) > 65535) {
      throw new Error("Antigravity returned an invalid Google sign-in URL.");
    }
  }
  return { authorizationUrl, redirectUri, state };
}

/** Validates what `agy acp --login` accepts on stdin: the code from the Antigravity page or that page's full URL. */
export function antigravityLoginResponse(
  pending: Pick<AntigravityAuthorizationUrl, "redirectUri" | "state">,
  response: string,
): string | undefined {
  const value = response.trim();
  if (/^[\w./~-]{1,2048}$/u.test(value)) return value;
  if (value.length > 16_384 || /\s/u.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    `${url.origin}${url.pathname}` !== pending.redirectUri ||
    url.username !== "" ||
    url.password !== "" ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.get("state") !== pending.state ||
    url.searchParams.getAll("code").length !== 1 ||
    !url.searchParams.get("code")
  ) {
    return undefined;
  }
  return value;
}

export function validateAntigravityCallbackUrl(
  pending: { redirectUri: string; state: string },
  callbackUrl: string,
): URL {
  if (callbackUrl.length > 16_384) throw new Error("The sign-in response URL is too long.");
  let callback: URL;
  try { callback = new URL(callbackUrl); }
  catch { throw new Error("Paste the complete redirect URL from Google."); }
  const expected = new URL(pending.redirectUri);
  const states = callback.searchParams.getAll("state");
  const codes = callback.searchParams.getAll("code");
  const errors = callback.searchParams.getAll("error");
  const issuers = callback.searchParams.getAll("iss");
  if (
    callback.protocol !== "http:" || callback.hostname !== "127.0.0.1" ||
    callback.origin !== expected.origin || callback.pathname !== expected.pathname ||
    callback.username || callback.password || callback.hash ||
    states.length !== 1 || states[0] !== pending.state ||
    !((codes.length === 1 && codes[0] && errors.length === 0) ||
      (errors.length === 1 && errors[0] && codes.length === 0)) ||
    issuers.length > 1 || (issuers.length === 1 && issuers[0] !== "https://accounts.google.com")
  ) throw new Error("This redirect URL does not belong to the current sign-in.");
  return callback;
}

export function forwardAntigravityCallback(callback: URL): Promise<void> {
  return new Promise((resolveForward, reject) => {
    const req = httpRequest({
      protocol: "http:",
      hostname: "127.0.0.1",
      port: callback.port,
      path: `${callback.pathname}${callback.search}`,
      method: "GET",
      agent: false,
      timeout: 10_000,
    }, (response) => {
      response.resume();
      response.once("end", () => {
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300) resolveForward();
        else reject(new Error("Could not deliver the Google sign-in response."));
      });
      response.once("error", reject);
    });
    req.once("timeout", () => req.destroy(new Error("The Google sign-in response timed out.")));
    req.once("error", reject);
    req.end();
  });
}
