/** Splits on paragraph, then line, then word boundaries so each piece fits a platform's message limit. */
export function splitMessage(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const cut = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")].find((at) => at > max / 2) ?? max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Markdown as Telegram's HTML parse mode reads it (b, i, s, code, pre, a). Anything else stays as text. */
export function markdownToTelegramHtml(markdown: string): string {
  const held: string[] = [];
  const hold = (html: string) => `\uE000${held.push(html) - 1}\uE000`;
  let text = markdown.replace(/```[^\n`]*\n([\s\S]*?)```/g, (_, code: string) => hold(`<pre><code>${escapeHtml(code.replace(/\n$/, ""))}</code></pre>`));
  text = text.replace(/`([^`\n]+)`/g, (_, code: string) => hold(`<code>${escapeHtml(code)}</code>`));
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) =>
    hold(`<a href="${escapeHtml(url).replaceAll('"', "&quot;")}">${escapeHtml(label)}</a>`));
  text = escapeHtml(text);
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
  text = text.replace(/^(\s*)[-*]\s+/gm, "$1• ");
  text = text.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/__([^_\n]+)__/g, "<b>$1</b>");
  text = text.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1<i>$2</i>").replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<i>$2</i>");
  text = text.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
  return text.replace(/\uE000(\d+)\uE000/g, (_, index: string) => held[Number(index)]!);
}
