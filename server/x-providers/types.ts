// The routes x_search reads X through. Each answers the asks it can in the shapes server/x-research.ts defines, throws
// an XResearchError when it fails, and throws XSkip when it cannot take an ask at all (not set up for this person, or
// not that kind of ask), which never counts against it.
import type { ServiceCredential } from "../included-services.ts";
import type { XPostList, XPostWithReplies, XProfile } from "../x-research.ts";

export type XProviderId = "session" | "syndication" | "xpage" | "oembed" | "treg" | "websearch";
export type XAction = "search" | "userPosts" | "post" | "profile";

/** Who asks: the bot whose tool call it is, its conversation, and the research credential held for it (the person's
 * own treg key or the plan's relay), if any. */
export interface XCall {
  botId: string;
  threadId?: string;
  credential: ServiceCredential | null;
}

export interface SearchInput { query: string; sort: "latest" | "top"; limit: number; sinceId?: string }
export interface UserPostsInput { handle: string; limit: number; sinceId?: string; includeReplies: boolean }
export interface PostInput { id: string; handle?: string; replies: boolean }

export interface XProvider {
  readonly id: XProviderId;
  /** An empty list from it is X's own answer (nothing matched), not a miss to look past. */
  readonly emptyIsAnswer: boolean;
  /** Its answers differ per person (their own X sign-in), so they are cached apart. */
  readonly personal?: boolean;
  search?(input: SearchInput, call: XCall): Promise<XPostList>;
  userPosts?(input: UserPostsInput, call: XCall): Promise<XPostList>;
  post?(input: PostInput, call: XCall): Promise<XPostWithReplies>;
  profile?(handle: string, call: XCall): Promise<XProfile>;
}

/** Why a route did not take an ask. `paced`: a watch asked again too soon, so nothing was read. */
export type XSkipReason = "not_set_up" | "not_for_this" | "paced" | "cooling_down" | "signed_out" | "daily_cap" | "busy";

export class XSkip extends Error {
  readonly reason: XSkipReason;
  /** A sentence the person should hear once, carried to the answer as its note. */
  readonly tell?: string;
  constructor(reason: XSkipReason, tell?: string) {
    super(reason);
    this.name = "XSkip";
    this.reason = reason;
    if (tell) this.tell = tell;
  }
}
