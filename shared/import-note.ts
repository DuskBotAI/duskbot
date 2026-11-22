// The first bot's short note in its chat after something was brought in from other apps: what came in and where it
// went. The app sends counts and names only (POST /api/bots/:id/import-note); server/import-note.ts writes the words.
import { z } from "zod";

const name = (max: number) => z.string().transform((value) => value.replace(/\p{Cc}+/gu, " ").replace(/\s+/g, " ").trim()).pipe(z.string().min(1).max(max));
const count = z.number().int().min(0).max(100_000).default(0);

export const importNoteSchema = z.object({
  /** The apps it came from, as people know them. */
  from: z.array(name(60)).min(1).max(12),
  bots: z.array(name(100)).max(60).default([]),
  /** Bots an earlier bring-in made that this one added to. */
  joined: count,
  /** Facts about the person added to About me. */
  facts: count,
  /** Facts about the person that didn't fit in About me, kept word for word in the first bot's memory. */
  aboutInMemory: count,
  /** Memories and notes kept in bots' memory. */
  memories: count,
  /** Open threads and recurring tasks kept in the first bot's memory. */
  threads: count,
  skills: count,
  tools: count,
  routines: count,
  /** Apps whose standing instructions were kept in the first bot's memory. */
  instructions: z.array(name(60)).max(12).default([]),
  /** Apps the moved bots used there, to connect again here. */
  reconnect: count,
  /** Some of it couldn't come in. */
  failed: z.boolean().default(false),
  /** The notes stopped part way: what was whole before the cut came in, the rest is missing. */
  partial: z.boolean().default(false),
  /** Everything in it was here already: said so, so the start note never hangs. */
  nothingNew: z.boolean().optional(),
  /** Said as the bringing in starts, before anything came in: the first bot says it got them and is setting things up. */
  start: z.boolean().optional(),
  /** It came by itself, from the notes file saved in Downloads. */
  via: z.enum(["downloads"]).optional(),
}).strict();

export type ImportNoteFacts = z.input<typeof importNoteSchema>;
