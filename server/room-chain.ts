// "@Forge write the notes, then @Morning Brief turn them into a standup": a person's message that hands one member's
// output to the next, so its members answer one after another in the order named, each seeing the reply before it.

const CHAIN = /\b(?:then|after that|afterwards|after (?:it|they|that)(?:'s| is| are)? done|once (?:it|they|that)(?:'s| is| are)? (?:done|ready|finished)|next)\b[^@\n]{0,48}@/i;

/** Whether the message asks for a later @mention to build on an earlier one. */
export function chainsMentions(text: string): boolean {
  const first = text.indexOf("@");
  return first !== -1 && CHAIN.test(text.slice(first + 1));
}

/** `members` in the order the message names them; any it does not name keep their place after those it does. */
export function inMentionOrder<T extends { name: string }>(members: readonly T[], text: string): T[] {
  const lower = text.toLocaleLowerCase();
  const at = (member: T) => {
    const found = lower.indexOf(`@${member.name.toLocaleLowerCase()}`);
    return found === -1 ? Number.MAX_SAFE_INTEGER : found;
  };
  return members.map((member, index) => ({ member, index, at: at(member) }))
    .sort((a, b) => a.at - b.at || a.index - b.index).map(({ member }) => member);
}
