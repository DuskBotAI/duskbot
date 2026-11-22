// Security: Shiki's output is generator-escaped; nothing else reaches the DOM as HTML.
import { useMemo, useState } from "react";
import { Check, Copy, Share, WrapText } from "../../icons";
import { codeLanguageLabel, useHighlightedCode } from "@/components/CodeBlock";
import { useCopyFeedback } from "@/lib/copy-text";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useChrome } from "../chrome";
import { RoundButton } from "../RoundButton";
import { Sheet } from "../Sheet";
import { usePlatform } from "../platform";
import { ViewerNote } from "./ViewerNote";

/** A fence full screen: its language over the code, line numbers, wrap on or off, copy and share. Unwrapped lines scroll
 * sideways inside the code alone; the sheet still follows a finger pulling down from the top. */
export function CodeViewer({ code, lang, open, onClose }: { code: string; lang: string; open: boolean; onClose: () => void }) {
  const platform = usePlatform();
  const systemBar = useChrome() !== null;
  const highlighted = useHighlightedCode(code, lang);
  // each line is its own block here, so the newlines Shiki keeps between them would draw as blank lines
  const markup = useMemo(() => highlighted && { __html: highlighted.__html.replace(/<\/span>\n<span class="line">/g, "</span><span class=\"line\">") }, [highlighted]);
  const { state: copied, copy } = useCopyFeedback(code);
  const [wrap, setWrap] = useState(false);
  const label = codeLanguageLabel(lang);
  const lines = code.split("\n");
  const title = label || t("mobile.code.title");
  return (
    <Sheet open={open} onClose={onClose} full label={title}
      title={systemBar ? title : <span className="flex items-baseline gap-2">{title}<span className="text-[13px] font-normal text-ink-tertiary tabular-nums">{t(lines.length === 1 ? "mobile.code.lines.one" : "mobile.code.lines", { count: lines.length })}</span></span>}
      actions={[
        { key: "wrap", label: t("mobile.code.wrap"), symbol: wrap ? "text.alignleft" : "arrow.right.to.line", onPress: () => setWrap((on) => !on) },
        ...(platform.share ? [{ key: "share", label: t("mobile.code.share"), symbol: "square.and.arrow.up", onPress: () => void platform.share!({ text: code }).catch(() => {}) }] : []),
        { key: "copy", label: copied === "copied" ? t("code.copiedTitle") : t("code.copyTitle"), symbol: copied === "copied" ? "checkmark" : "doc.on.doc", onPress: () => void copy() },
      ]}
      trailing={<div className="flex gap-2">
        <RoundButton label={t("mobile.code.wrap")} pressed={wrap} onClick={() => setWrap(!wrap)} className={cn(wrap && "bg-ink/[0.12]")}><WrapText size={18} /></RoundButton>
        {platform.share && <RoundButton label={t("mobile.code.share")} onClick={() => void platform.share!({ text: code }).catch(() => {})}><Share size={18} /></RoundButton>}
        <RoundButton label={copied === "copied" ? t("code.copiedTitle") : t("code.copyTitle")} onClick={copy}>
          {copied === "copied" ? <Check size={18} className="text-success" /> : <Copy size={18} />}
        </RoundButton>
      </div>}
      bodyClassName="!overflow-x-hidden">
      <div dir="ltr" data-code-viewer="" data-selectable="" data-wrap={wrap || undefined}
        className={cn("code-viewer mx-3 mb-3 rounded-2xl bg-ink/[0.04] py-3 font-mono text-[13px] leading-[1.6]", wrap ? "overflow-x-hidden" : "overflow-x-auto")}>
        {markup
          ? <div className="[&_pre]:!bg-transparent [&_pre]:m-0 [&_pre]:w-max [&_pre]:min-w-full" dangerouslySetInnerHTML={markup} />
          : <pre className="m-0 w-max min-w-full text-ink-secondary"><code>{lines.map((line, index) => <span key={index} className="line">{line || " "}</span>)}</code></pre>}
      </div>
      <ViewerNote show={copied !== "idle"} text={copied === "failed" ? t("common.copyFailed") : t("mobile.viewer.copied")} failed={copied === "failed"} />
    </Sheet>
  );
}
