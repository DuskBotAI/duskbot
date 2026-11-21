// The paid route: scrapers through treg, with the person's own treg key or their plan's relay (server/x-research.ts).
// Only for a person who holds one of those.
import type { ServiceCredential } from "../included-services.ts";
import { createXClient, type XResearchClient } from "../x-research.ts";
import { XSkip, type XCall, type XProvider } from "./types.ts";

export function createTregProvider(options: { client?: (credential: ServiceCredential) => XResearchClient } = {}): XProvider {
  const clientFor = (call: XCall) => {
    if (!call.credential) throw new XSkip("not_set_up");
    return (options.client ?? ((credential: ServiceCredential) => createXClient(credential)))(call.credential);
  };
  return {
    id: "treg",
    emptyIsAnswer: false,
    search: (input, call) => clientFor(call).search(input),
    userPosts: (input, call) => clientFor(call).userPosts(input),
    post: (input, call) => clientFor(call).post(input),
    profile: (handle, call) => clientFor(call).profile(handle),
  };
}
