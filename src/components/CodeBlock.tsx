// Security: Shiki's output is generator-escaped; nothing else reaches the DOM as HTML.
import { useEffect, useMemo, useState } from "react";
import type { HighlighterCore } from "shiki/core";
import { Check, X } from "../icons";
import type { ShikiWorkerReply, ShikiWorkerRequest } from "./shiki-worker";

import { GROK_LIGHT_THEME } from "./code-theme-grok";
import { Icon } from "./Icon";
import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { phoneBridge } from "@/lib/phone-bridge";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";

const highlightCache = new Map<string, string>();
export const HIGHLIGHT_CACHE_MAX = 200;
export const HIGHLIGHT_CACHE_MAX_CHARS = 4 * 1024 * 1024;
function rememberHighlight(key: string, html: string) {
  if (html.length > HIGHLIGHT_CACHE_MAX_CHARS) return;
  highlightCache.set(key, html);
  let chars = 0;
  for (const cached of highlightCache.values()) chars += cached.length;
  for (const [oldest, oldestHtml] of highlightCache) {
    if (highlightCache.size <= HIGHLIGHT_CACHE_MAX && chars <= HIGHLIGHT_CACHE_MAX_CHARS) break;
    highlightCache.delete(oldest);
    chars -= oldestHtml.length;
  }
}

/** A short stable hash for cache keys. */
export const codeHash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

// Shiki's package entry registers every grammar and theme (hundreds of chunks), so each one is imported on its own.
const LIGHT_THEME = GROK_LIGHT_THEME.name!;
const DARK_THEME = "github-dark-default";
const grammarLoaders = {
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  json5: () => import("shiki/langs/json5.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  fish: () => import("shiki/langs/fish.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  sass: () => import("shiki/langs/sass.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  mdx: () => import("shiki/langs/mdx.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  makefile: () => import("shiki/langs/makefile.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  wasm: () => import("shiki/langs/wasm.mjs"),
};
type GrammarFile = keyof typeof grammarLoaders;
const grammarAlias: Record<string, GrammarFile> = {
  js: "javascript", node: "javascript",
  ts: "typescript",
  sh: "bash", zsh: "bash", shell: "bash",
  ps1: "powershell",
  py: "python",
  htm: "html",
  yml: "yaml",
  md: "markdown",
  svg: "xml",
  "c++": "cpp", cc: "cpp", cxx: "cpp",
  cs: "csharp", "c#": "csharp",
  rs: "rust",
  golang: "go",
  rb: "ruby",
  kt: "kotlin",
  gql: "graphql",
  protobuf: "proto",
  docker: "dockerfile",
  make: "makefile",
};
const PLAIN_LANGS = new Set(["", "text", "txt", "plaintext", "plain"]);
let highlighterPromise: Promise<HighlighterCore> | undefined;
const grammarLoading = new Map<string, Promise<void>>();

function grammarFile(lang: string): GrammarFile | undefined {
  const alias = grammarAlias[lang];
  if (alias) return alias;
  return Object.prototype.hasOwnProperty.call(grammarLoaders, lang) ? lang as GrammarFile : undefined;
}

function getHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise) return highlighterPromise;
  const created = (async () => {
    const { createHighlighterCore } = await import("shiki/core");
    const { createJavaScriptRegexEngine } = await import("shiki/engine/javascript");
    return createHighlighterCore({
      themes: [
        GROK_LIGHT_THEME,
        import("shiki/themes/github-dark-default.mjs").then((mod) => mod.default),
      ],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })().catch((error: unknown) => {
    highlighterPromise = undefined;
    throw error;
  });
  highlighterPromise = created;
  return created;
}

function loadGrammar(highlighter: HighlighterCore, file: GrammarFile): Promise<void> {
  const pending = grammarLoading.get(file);
  if (pending) return pending;
  const next = grammarLoaders[file]().then((mod) => highlighter.loadLanguage(mod.default)).catch((error: unknown) => {
    grammarLoading.delete(file);
    throw error;
  });
  grammarLoading.set(file, next);
  return next;
}

async function highlightFenceInThread(code: string, lang: string): Promise<string> {
  const highlighter = await getHighlighter();
  const requested = lang.trim().toLowerCase();
  const plain = PLAIN_LANGS.has(requested);
  const file = plain ? undefined : grammarFile(requested);
  if (!plain && !file) throw new Error(`no bundled grammar for ${requested}`);
  if (file) await loadGrammar(highlighter, file);
  return highlighter.codeToHtml(code, {
    lang: file ?? "text",
    themes: { light: LIGHT_THEME, dark: DARK_THEME },
    defaultColor: "light-dark()",
  });
}

type WorkerPending = { resolve: (html: string) => void; reject: (error: Error) => void };
let shikiWorker: Worker | null = null;
let shikiWorkerFailed = false;
let shikiWorkerIdle: ReturnType<typeof setTimeout> | null = null;
let shikiRequestId = 1;
const shikiPending = new Map<number, WorkerPending>();
const SHIKI_WORKER_IDLE_MS = 60_000;

function stopShikiWorker(): void {
  if (shikiWorkerIdle) {
    clearTimeout(shikiWorkerIdle);
    shikiWorkerIdle = null;
  }
  if (!shikiWorker) return;
  shikiWorker.terminate();
  shikiWorker = null;
}

function armShikiWorkerIdle(): void {
  if (shikiWorkerIdle) clearTimeout(shikiWorkerIdle);
  if (!shikiWorker || shikiPending.size > 0) return;
  shikiWorkerIdle = setTimeout(() => {
    shikiWorkerIdle = null;
    if (shikiPending.size === 0) stopShikiWorker();
  }, SHIKI_WORKER_IDLE_MS);
}

function getShikiWorker(): Worker | null {
  if (shikiWorkerFailed || typeof Worker === "undefined") return null;
  if (shikiWorker) return shikiWorker;
  try {
    const worker = new Worker(new URL("./shiki-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<ShikiWorkerReply>) => {
      const reply = event.data;
      const waiter = shikiPending.get(reply.id);
      if (!waiter) return;
      shikiPending.delete(reply.id);
      if (reply.ok) waiter.resolve(reply.html);
      else waiter.reject(new Error(reply.error));
      if (shikiPending.size === 0) armShikiWorkerIdle();
    };
    worker.onerror = () => {
      shikiWorkerFailed = true;
      stopShikiWorker();
      for (const waiter of shikiPending.values()) waiter.reject(new Error("shiki worker failed"));
      shikiPending.clear();
    };
    shikiWorker = worker;
    return worker;
  } catch {
    shikiWorkerFailed = true;
    return null;
  }
}

function highlightFence(code: string, lang: string): Promise<string> {
  const requested = lang.trim().toLowerCase();
  const plain = PLAIN_LANGS.has(requested);
  const file = plain ? undefined : grammarFile(requested);
  if (!plain && !file) return Promise.reject(new Error(`no bundled grammar for ${requested}`));
  const worker = getShikiWorker();
  if (!worker) return highlightFenceInThread(code, lang);
  if (shikiWorkerIdle) {
    clearTimeout(shikiWorkerIdle);
    shikiWorkerIdle = null;
  }
  const id = shikiRequestId++;
  return new Promise<string>((resolve, reject) => {
    shikiPending.set(id, { resolve, reject });
    worker.postMessage({ id, code, lang } satisfies ShikiWorkerRequest);
  }).catch(() => highlightFenceInThread(code, lang));
}
const highlightKey = (lang: string, code: string) => `${lang}:${codeHash(code)}`;
// Shiki tokenizes on the renderer's main thread: 100 KB of TypeScript took 1.1 s, 1 MB took 12 s.
export const HIGHLIGHT_MAX_CHARS = 100_000;

export interface CodeBlockProps {
  code: string;
  lang: string;
  initialWrap?: boolean;
}

const PLATE_BUTTON_SMALL = "composer-press inline-flex size-5 touch:size-7 items-center justify-center rounded-[4px] border border-transparent bg-composer text-ink/[0.66] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";
/** Grok's copy-code button: a 24px white key with a hairline and a small drop, top right of the block. */
const PLATE_BUTTON = "composer-press inline-flex size-6 touch:size-8 items-center justify-center rounded-[6px] border border-transparent bg-composer text-ink/[0.66] shadow-[0_1px_3px_rgb(28_28_28/0.12)] hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus";

/** The hover plate on a code block or diagram: Copy, and a ⋯ menu for the rest. It shows on hover, on
 * keyboard focus and always on touch screens, and stays while its menu is open. */
export function CodePlate({ copied, onCopy, copyLabel, items, small = false, expand }: {
  copied: "idle" | "copied" | "failed";
  onCopy: () => void;
  copyLabel: string;
  items: SidebarMenuItem[];
  /** A key before Copy that opens the block full screen, as a diagram's does. */
  expand?: { label: string; onClick: () => void };
  /** Grok's key on a fenced block with a language: 20px, a 4px corner and no drop. */
  small?: boolean;
}) {
  const button = small ? PLATE_BUTTON_SMALL : PLATE_BUTTON;
  const icon = small ? 12 : 14;
  return (
    <div data-code-plate className="absolute end-1.5 top-1.5 z-[1] flex gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/code:opacity-100 touch:opacity-100 has-[[aria-expanded=true]]:opacity-100">
      {expand && <button type="button" data-plate-expand onClick={expand.onClick} className={button} title={expand.label} aria-label={expand.label}>
        <Icon name="arrows-expand" size={icon} />
      </button>}
      <button type="button" onClick={onCopy} className={button}
        title={copied === "copied" ? t("code.copiedTitle") : copied === "failed" ? t("common.copyFailed") : copyLabel}
        aria-label={copied === "copied" ? t("code.copiedTitle") : copied === "failed" ? t("common.copyFailed") : copyLabel}>
        {copied === "failed" ? <X size={icon} className="text-danger" aria-hidden="true" />
          : copied === "copied" ? <Check size={icon} className="text-success" aria-hidden="true" />
            : <Icon name="copy" size={icon} />}
      </button>
      {copied !== "idle" && <span role="status" className="sr-only">{copied === "failed" ? t("common.copyFailed") : t("code.copiedTitle")}</span>}
      {items.length > 0 && <SidebarPopoverMenu items={items} ariaLabel={t("chat.more")} placement="below" triggerClassName="rounded-[6px]" triggerTitle={t("chat.more")}
        renderTrigger={() => <span className={button}><Icon name="dots-3-horizontal" size={icon} /></span>} />}
    </div>
  );
}

/** Shiki's markup for a fence, from the cache when it was drawn before; null while it loads and for a fence with no
 * language, which stays plain in the bubble's grey as grok does. */
export function useHighlightedCode(code: string, lang: string): { __html: string } | null {
  const highlightable = code.length <= HIGHLIGHT_MAX_CHARS && Boolean(lang.trim());
  const [html, setHtml] = useState<string | null>(() => highlightable ? highlightCache.get(highlightKey(lang, code)) ?? null : null);
  useEffect(() => {
    if (!highlightable) return setHtml(null);
    const key = highlightKey(lang, code);
    const cached = highlightCache.get(key);
    if (cached) return setHtml(cached);
    let alive = true;
    highlightFence(code, lang || "text")
      .then((out) => {
        if (!alive) return;
        rememberHighlight(key, out);
        setHtml(out);
      })
      .catch(() => {
      });
    return () => {
      alive = false;
    };
  }, [code, lang, highlightable]);
  // React compares dangerouslySetInnerHTML by identity: a fresh object each render rebuilds the highlighted DOM.
  return useMemo(() => (html ? { __html: html } : null), [html]);
}

/** The words a fence's language reads as on a label: "TypeScript" for ts, the fence's own word for one we don't name. */
export function codeLanguageLabel(lang: string): string {
  const requested = lang.trim().toLowerCase();
  if (PLAIN_LANGS.has(requested)) return "";
  const file = grammarFile(requested);
  return (file && LANGUAGE_NAMES[file]) || requested;
}
const LANGUAGE_NAMES: Partial<Record<GrammarFile, string>> = {
  javascript: "JavaScript", jsx: "JSX", typescript: "TypeScript", tsx: "TSX", json: "JSON", jsonc: "JSON", json5: "JSON5",
  bash: "Bash", powershell: "PowerShell", fish: "Fish", python: "Python", html: "HTML", css: "CSS", scss: "SCSS", sass: "Sass",
  less: "Less", markdown: "Markdown", mdx: "MDX", yaml: "YAML", toml: "TOML", xml: "XML", c: "C", cpp: "C++", csharp: "C#",
  rust: "Rust", go: "Go", ruby: "Ruby", php: "PHP", java: "Java", kotlin: "Kotlin", swift: "Swift", dart: "Dart", r: "R",
  lua: "Lua", sql: "SQL", graphql: "GraphQL", proto: "Protobuf", dockerfile: "Dockerfile", makefile: "Makefile", diff: "Diff",
  wasm: "WebAssembly",
};

export function CodeBlock({ code, lang, initialWrap = false }: CodeBlockProps) {
  const markup = useHighlightedCode(code, lang);
  const { state: copied, copy } = useCopyFeedback(code);
  const wrapLines = initialWrap;
  const phone = phoneBridge();

  const body = (pad: string, plainInk: string) => markup ? (
    <div
      className={cn(`text-[13px] [&_pre]:!bg-transparent [&_pre]:m-0 ${pad}`, wrapLines
        ? "whitespace-pre-wrap break-words overflow-x-hidden [&_pre]:!whitespace-pre-wrap [&_pre]:!break-words [&_code]:!whitespace-pre-wrap [&_code]:!break-words"
        : "overflow-x-auto")}
      dangerouslySetInnerHTML={markup}
    />
  ) : (
    <pre className={cn(`text-[13px] ${pad.replaceAll("[&_pre]:", "")}`, plainInk, wrapLines ? "whitespace-pre-wrap break-words overflow-x-hidden" : "overflow-x-auto")}>
      {code}
    </pre>
  );

  const label = codeLanguageLabel(lang);
  const open = phone ? () => phone.view({ kind: "code", code, lang }) : undefined;
  return (
    <div dir="ltr" data-lang={lang.trim() || undefined} className="chat-code-block group/code relative my-2.5 overflow-hidden rounded-lg bg-ink/[0.04]"
      onClick={open && ((event) => { if (!(event.target as Element).closest("button, a")) open(); })}>
      {phone && label && <span data-code-label className="pointer-events-none absolute start-3 top-2.5 text-[12px] leading-4 font-medium text-ink-tertiary">{label}</span>}
      {/* grok's code block offers copy alone; the phone adds a key that opens it full screen */}
      <CodePlate copied={copied} onCopy={copy} copyLabel={t("code.copyTitle")} small={Boolean(lang.trim())} items={[]}
        expand={open && { label: t("code.open"), onClick: open }} />
      {body("leading-5 [&_pre]:px-3 [&_pre]:py-2", "text-ink-secondary")}
    </div>
  );
}
