// Plain HTTPS reads for the free routes: capped bodies, a timeout, no redirects followed unless asked, and every
// failure as an XResearchError the router can weigh.
import { readCapped, X_MESSAGES, XResearchError } from "../x-research.ts";

/** A desktop Chrome's: x.com and the search page serve a bare client an empty shell. */
export const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface HttpOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export interface HttpAnswer { status: number; text: string; url: string }

export const unavailable = () => new XResearchError("unavailable", X_MESSAGES.unavailable);
export const rateLimited = () => new XResearchError("rate_limited", X_MESSAGES.rateLimited);

/** GET a page or JSON. 429 and 5xx throw; any other status comes back for the route to read (a 404 means not found). */
export async function httpGet(url: string, options: HttpOptions & { headers?: Record<string, string>; follow?: boolean } = {}): Promise<HttpAnswer> {
  let response: Response;
  let text: string;
  try {
    response = await (options.fetcher ?? fetch)(url, {
      headers: { "user-agent": BROWSER_UA, "accept-language": "en-US,en;q=0.9", ...options.headers },
      redirect: options.follow ? "follow" : "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? 12_000),
    });
    text = await readCapped(response);
  } catch (error) {
    if (error instanceof XResearchError) throw error;
    throw unavailable();
  }
  if (response.status === 429) throw rateLimited();
  if (response.status >= 500) throw unavailable();
  return { status: response.status, text, url: response.url || url };
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw unavailable();
  }
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…" };

/** Tags out, entities decoded, white space as written. */
export function htmlText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] === "#") {
        const code = name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[name.toLowerCase()] ?? whole;
    })
    .trim();
}
