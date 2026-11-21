// x_search's router as the server builds it: the free routes for everyone, the person's own X sign-in once they said
// yes, and treg for a person with a treg key or a plan.
import type { ServiceCredential } from "../included-services.ts";
import type { ResearchClient } from "../research.ts";
import type { XResearchClient } from "../x-research.ts";
import { createOembedProvider } from "./oembed.ts";
import { XRouter } from "./router.ts";
import { createSessionProvider, graphqlOp, XAccountStore, type XAskAnswer, type XSessionProvider, type XSessionTarget } from "./session.ts";
import { createSyndicationProvider } from "./syndication.ts";
import { createTregProvider } from "./treg.ts";
import { createWebSearchProvider } from "./websearch.ts";
import type { XIndexAccess } from "./x-index.ts";
import { createXPageProvider } from "./xpage.ts";

export interface XRouterDeps {
  research?: (credential: ServiceCredential) => ResearchClient;
  index?: () => XIndexAccess | null;
  treg?: (credential: ServiceCredential) => XResearchClient;
  session?: XSessionProvider;
  fetcher?: typeof fetch;
}

export function createXRouter(deps: XRouterDeps = {}): XRouter {
  const http = deps.fetcher ? { fetcher: deps.fetcher } : {};
  return new XRouter({
    providers: [
      createSyndicationProvider(http),
      createXPageProvider(http),
      createOembedProvider(http),
      createWebSearchProvider({ ...http, ...(deps.research ? { research: deps.research } : {}), ...(deps.index ? { index: deps.index } : {}) }),
      createTregProvider(deps.treg ? { client: deps.treg } : {}),
    ],
    ...(deps.session ? { session: deps.session } : {}),
  });
}

/** The server's router: the session route reads through the bot's browser (BrowserService.readResponses) and asks on a
 * card in the conversation; its answers and pacing are kept in the data folder. */
export function createServerXRouter(deps: {
  dataDir: string;
  index: () => XIndexAccess | null;
  research: (credential: ServiceCredential) => ResearchClient;
  askPerson: (input: { botId: string; threadId: string; title: string; subtitle: string; options: string[] }) => Promise<XAskAnswer>;
  target: (botId: string, threadId?: string) => Promise<XSessionTarget | null>;
  readResponses: (target: XSessionTarget, request: { url: string; wanted: (url: string) => string | null; enough: (names: ReadonlySet<string>) => boolean; timeoutMs: number }) => Promise<{ url: string; responses: Array<{ name: string; status: number; body: string }> }>;
}): XRouter {
  return createXRouter({
    research: deps.research,
    index: deps.index,
    session: createSessionProvider({
      store: new XAccountStore(deps.dataDir),
      askPerson: deps.askPerson,
      browser: {
        target: deps.target,
        read: (target, request) => deps.readResponses(target, { url: request.url, wanted: (url) => graphqlOp(url, request.ops), enough: (names) => request.ops.every((op) => names.has(op)), timeoutMs: request.timeoutMs }),
      },
    }),
  });
}
