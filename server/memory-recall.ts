// Fact recall: words (FTS5 BM25), meaning (local embeddings), names and time, fused by reciprocal rank (k = 60, as
// Hindsight's TEMPR does), then gently boosted for recency and for falling inside the asked-about time. Replaced and
// expired facts answer only questions about the past.
import { factIdentity, parseMemoryEntries } from "./memory-entries.ts";
import { cosine, embedderReady, embedPassages, embedQuery, warmEmbedder } from "./memory-embed.ts";
import { embedPendingFacts, factsOf, factVectors, searchFactText, syncAboutFacts, syncWorkspaceFacts, type FactRow, type FactStatus } from "./memory-facts.ts";
import { daysOutside, overlaps, queryTime, type DayRange } from "./memory-time.ts";
import { parseGeneral, type HistoryEntry } from "./general-memory.ts";
import { looksLikeInstruction } from "./memory-trust.ts";
import { recallTerms } from "./message-db.ts";

export const RRF_K = 60;
const CANDIDATES = 60;
/** Cosine similarity a fact needs on meaning alone to count as relevant (bge-small: unrelated pairs sit near 0.4-0.5). */
export const SIMILAR = 0.6;
const SIMILAR_WITH_WORDS = 0.5;
const MAX_FACTS = 14;
const RECENCY_DAYS = 365;

export interface RecalledFact {
  fact: FactRow;
  score: number;
  /** Shown as history ("was … until …"), not as how things are. */
  past: boolean;
}

export interface FactRecallInput {
  /** Workspace ids whose notes this turn reads. */
  memoryIds: readonly string[];
  about?: { owner: string; text: string; history?: readonly HistoryEntry[] };
  query: string;
  today: string;
  /** Text already in the prompt: facts in it are not recalled again. */
  loaded?: readonly string[];
  /** Looser relevance, for showing the capture step what it might repeat or change. */
  wide?: boolean;
}

const QUESTION = /\?\s*$|^\s*(?:what|when|where|who|whom|which|why|how|did|do|does|have|has|is|are|was|were|can|could|should|will|would)\b/i;
const ABOUT_THEM = /\b(?:my|me|mine|i|i'm|i've|we|our|us|remember|told you)\b/i;

/** A question about the person or what they told the bot: when nothing is recalled, the bot is told so. */
export function asksMemory(query: string): boolean {
  return QUESTION.test(query.trim()) && ABOUT_THEM.test(query);
}

function loadedIdents(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    for (const entry of parseMemoryEntries(text)) out.add(factIdentity(entry.body));
    for (const line of parseGeneral(text)) out.add(factIdentity(line.fact));
  }
  return out;
}

const PROPER = /\b\p{Lu}[\p{L}'-]{2,}\b/gu;
const NOT_NAMES = new Set("I What When Where Who Which Why How Did Do Does Have Has Is Are Was Were Can Could Should Will Would The This That My Our Your Please Tell Remind Remember".split(" "));

function names(text: string): string[] {
  return [...new Set([...text.matchAll(PROPER)].map((m) => m[0]).filter((word) => !NOT_NAMES.has(word)))];
}

export function factDay(fact: FactRow): string | null {
  return fact.validFrom ?? (Number.isFinite(fact.learnedAt) ? new Date(fact.learnedAt).toISOString().slice(0, 10) : null);
}

/** Days the fact held (a state) or happened (an event). */
function factSpan(fact: FactRow, today: string): DayRange | null {
  if (fact.happenedStart) return { start: fact.happenedStart, end: fact.happenedEnd ?? fact.happenedStart };
  const from = factDay(fact);
  if (!from) return null;
  return { start: from, end: fact.validUntil && fact.validUntil < today ? fact.validUntil : today };
}

function wordHits(terms: readonly string[], fact: FactRow): number {
  const words = `${fact.text} ${fact.keys}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return terms.filter((term) => words.some((word) => word === term || (term.length >= 4 && word.length >= 4 && (word.startsWith(term.slice(0, -1)) || term.startsWith(word.slice(0, -1)))))).length;
}

/** The message names the fact's topic (its file name, title or an alias): a topic match counts on its own, as one word. */
function keyHit(terms: readonly string[], fact: FactRow): boolean {
  if (!fact.keys) return false;
  const words = fact.keys.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return terms.some((term) => words.includes(term) || words.includes(term.replace(/s$/, "")));
}

const TIME_WORDS = new Set("last this next year month week day days weeks months years ago spring summer autumn fall winter yesterday today since during january february march april may june july august september october november december".split(" "));

const QUESTION_WORDS = new Set("what who where when which why how whats".split(" "));

/** The message's searchable words, possessives folded ("Ana's" is "ana"). */
export function queryTerms(query: string): string[] {
  const out: string[] = [];
  for (const raw of recallTerms(query)) {
    const term = raw.replace(/['’]s$/u, "").replace(/['’]/gu, "");
    if (term.length < 2 || QUESTION_WORDS.has(term) || out.includes(term)) continue;
    out.push(term);
  }
  return out;
}

/** A question about one of these facets rarely shares a word with the fact that answers it ("my job title" against
 * "is now design lead at Fernhill"), and a small model does not bridge them reliably, so the words are added. */
const FACETS: ReadonlyArray<[RegExp, readonly string[]]> = [
  [/^(?:job|jobs|title|role|position|career|work|occupation|profession)$/, ["works", "job", "role", "title", "designer", "engineer", "manager", "lead", "head", "developer", "director", "founder", "joined", "employed"]],
  [/^(?:live|living|home|city|address|reside|moved|located)$/, ["lives", "live", "moved", "home", "city", "address", "apartment"]],
  [/^(?:eat|food|diet|allergy|allergies|allergic)$/, ["allergic", "vegetarian", "vegan", "eats", "diet", "allergy"]],
  [/^(?:phone|number|call|mobile)$/, ["phone", "mobile", "number"]],
];

function expandTerms(terms: readonly string[]): string[] {
  const out = [...terms];
  for (const term of terms) for (const [pattern, more] of FACETS) if (pattern.test(term)) for (const word of more) if (!out.includes(word)) out.push(word);
  return out.slice(0, 32);
}

function ftsMatch(terms: readonly string[]): string | null {
  const usable = terms.filter((term) => /^[\p{L}\p{N}]+$/u.test(term));
  return usable.length ? usable.map((term) => `"${term}"`).join(" OR ") : null;
}

/** `facts`: what to recall. `current`: the live facts that answer it but are already in the prompt (`loaded`), so a
 * caller can weigh older conversation passages against them. */
export async function recallFacts(input: FactRecallInput): Promise<{ facts: RecalledFact[]; current: FactRow[]; searched: boolean }> {
  warmEmbedder();
  const owners = [...input.memoryIds];
  for (const id of input.memoryIds) syncWorkspaceFacts(id);
  if (input.about) {
    syncAboutFacts(input.about.owner, input.about.text, new Date(), input.about.history ?? []);
    owners.push(input.about.owner);
  }
  void embedPendingFacts(owners);
  const time = queryTime(input.query, input.today);
  const statuses: FactStatus[] = time.past ? ["active", "superseded", "expired"] : ["active"];
  const all = factsOf(owners, statuses);
  if (!all.length) return { facts: [], current: [], searched: true };
  const byId = new Map(all.map((fact) => [fact.id, fact]));
  const asked = queryTerms(input.query);
  const said = asked.filter((term) => !TIME_WORDS.has(term));
  const terms = expandTerms(asked);
  const content = terms.filter((term) => !TIME_WORDS.has(term));
  const need = said.length >= 5 ? 2 : 1;
  const lists: string[][] = [];

  const match = ftsMatch(terms);
  const lexical = match ? searchFactText(owners, match, statuses, CANDIDATES).filter((id) => byId.has(id) && (wordHits(content.length ? content : terms, byId.get(id)!) >= need || keyHit(content, byId.get(id)!))) : [];
  lists.push(lexical);

  const similarity = new Map<string, number>();
  if (embedderReady()) {
    const query = await embedQuery(input.query);
    if (query) {
      for (const [id, vector] of factVectors(owners, statuses)) similarity.set(id, cosine(query, vector));
      lists.push([...similarity.entries()].filter(([, s]) => s >= SIMILAR_WITH_WORDS).sort((a, b) => b[1] - a[1]).slice(0, CANDIDATES).map(([id]) => id));
    }
  }

  const named = new Set([...names(input.query).map((name) => name.toLowerCase()), ...said]);
  const known = new Map<string, string[]>();
  for (const fact of all) for (const name of names(fact.text)) known.set(name.toLowerCase(), [...(known.get(name.toLowerCase()) ?? []), fact.id]);
  const entity = [...named].flatMap((name) => known.get(name) ?? []);
  lists.push([...new Set(entity)].sort((a, b) => byId.get(b)!.learnedAt - byId.get(a)!.learnedAt).slice(0, CANDIDATES));

  const inWindow = new Set<string>();
  if (time.range) {
    for (const fact of all) {
      const span = factSpan(fact, input.today);
      if (span && overlaps(span, time.range)) inWindow.add(fact.id);
    }
    lists.push([...inWindow].sort((a, b) => (similarity.get(b) ?? 0) - (similarity.get(a) ?? 0) || byId.get(b)!.learnedAt - byId.get(a)!.learnedAt).slice(0, CANDIDATES));
  }

  const fused = new Map<string, number>();
  for (const list of lists) list.forEach((id, rank) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));

  const lexicalSet = new Set(lexical);
  const entitySet = new Set(entity);
  const timeOnly = Boolean(time.range) && said.length <= 2;
  // "which restaurants have I liked", "how many trips": a list wants every fact that fits, not only the closest
  const listing = /\b(?:which|how many|all|every|list|so far|ever)\b/i.test(input.query);
  const similar = listing ? SIMILAR_WITH_WORDS + 0.05 : SIMILAR;
  const loaded = loadedIdents(input.loaded ?? []);
  const today = Date.parse(`${input.today}T12:00:00Z`);
  const scored: RecalledFact[] = [];
  const current: FactRow[] = [];
  for (const [id, rrf] of fused) {
    const fact = byId.get(id)!;
    if (looksLikeInstruction(fact.text)) continue;
    const sim = similarity.get(id) ?? 0;
    const relevant = (input.wide && (sim >= SIMILAR_WITH_WORDS || lexicalSet.has(id) || entitySet.has(id))) || sim >= similar
      || (lexicalSet.has(id) && (sim >= SIMILAR_WITH_WORDS || (!similarity.size && (wordHits(content, fact) >= need || keyHit(content, fact))) || wordHits(content, fact) >= Math.min(2, said.length)))
      || (entitySet.has(id) && (sim >= SIMILAR_WITH_WORDS || !similarity.size || lexicalSet.has(id)))
      || (inWindow.has(id) && (timeOnly || lexicalSet.has(id) || sim >= SIMILAR_WITH_WORDS));
    if (!relevant) continue;
    if (fact.status === "active" && loaded.has(fact.ident)) {
      current.push(fact);
      continue;
    }
    const day = factDay(fact);
    const age = day ? Math.max(0, (today - Date.parse(`${day}T12:00:00Z`)) / 86_400_000) : RECENCY_DAYS;
    const recency = Math.max(0.1, 1 - age / RECENCY_DAYS);
    let score = rrf * (1 + 0.2 * (recency - 0.5));
    if (time.range) {
      const span = factSpan(fact, input.today);
      const near = span ? Math.max(0, 1 - daysOutside(span, time.range) / 180) : 0;
      score *= 1 + 0.2 * (near - 0.5);
    }
    if (fact.status !== "active") score *= time.range && inWindow.has(id) ? 1 : 0.8;
    if (fact.trust === "low") score *= 0.9;
    scored.push({ fact, score, past: fact.status !== "active" });
  }
  scored.sort((a, b) => b.score - a.score);
  // one fact said in two places (About me and a bot's notes) is recalled once
  const seen = new Set<string>();
  const facts = scored.filter((item) => (seen.has(item.fact.ident) ? false : (seen.add(item.fact.ident), true))).slice(0, MAX_FACTS);
  return { facts, current, searched: true };
}

/** Cosine similarity past which two facts say the same thing, unless their numbers, names or a negation differ. */
export const SAME_FACT = 0.95;
const NEGATION = /\b(?:not|no|never|none|n't|without|stopped|quit|no longer)\b/i;
const numbers = (text: string) => (text.match(/-?\d+(?:[.,]\d+)?/g) ?? []).sort().join(" ");

/** Whether two near-identical sentences may still be different facts: other numbers, other names, one negated. */
export function differInDetail(a: string, b: string): boolean {
  return numbers(a) !== numbers(b) || NEGATION.test(a) !== NEGATION.test(b) || names(a).sort().join(" ") !== names(b).sort().join(" ");
}

/** For each new text, a known fact that already says it (by meaning, not wording); none without embeddings. */
export async function nearDuplicateOf(texts: readonly string[], known: readonly FactRow[]): Promise<Map<string, FactRow>> {
  const out = new Map<string, FactRow>();
  if (!texts.length || !known.length || !embedderReady()) return out;
  const vectors = await embedPassages([...texts, ...known.map((fact) => fact.text)]);
  if (!vectors) return out;
  texts.forEach((text, i) => {
    let best: { fact: FactRow; sim: number } | null = null;
    known.forEach((fact, j) => {
      const sim = cosine(vectors[i]!, vectors[texts.length + j]!);
      if (sim >= SAME_FACT && (!best || sim > best.sim) && !differInDetail(text, fact.text)) best = { fact, sim };
    });
    if (best) out.set(text, (best as { fact: FactRow }).fact);
  });
  return out;
}
