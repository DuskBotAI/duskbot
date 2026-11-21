import { Children, isValidElement, useMemo, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { RichTable, type TableAlign, type TableCell, type TableColumn } from "./RichTable";

type Element = ReactElement<{ children?: ReactNode; align?: string; alt?: string; style?: CSSProperties }>;
const elements = (children: ReactNode): Element[] => Children.toArray(children).filter(isValidElement) as Element[];
function plain(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(plain).join("");
  if (!isValidElement(node)) return "";
  const element = node as Element;
  if (element.type === "br") return "\n";
  return plain(element.props.children) || element.props.alt || "";
}

/** react-markdown (9 and later) hands a GFM column's alignment over as style.textAlign, not the align attribute. */
function authoredAlign(element: Element): TableAlign | undefined {
  const align = element.props.align ?? element.props.style?.textAlign;
  return align === "left" || align === "right" || align === "center" ? align : undefined;
}

/** Security: keeps react-markdown's already-sanitized cell children; never renders model-authored raw HTML. */
export function MarkdownTable({ children, direction }: { children?: ReactNode; direction?: "rtl" | "ltr" }) {
  const data = useMemo(() => {
    const sections = elements(children);
    const head = sections.find((section) => section.type === "thead");
    const body = sections.find((section) => section.type === "tbody");
    const cell = (element: Element): TableCell => ({ text: plain(element.props.children), content: element.props.children, align: authoredAlign(element) });
    const columns: TableColumn[] = elements(elements(head?.props.children)[0]?.props.children).map(cell);
    const rows = elements(body?.props.children).map((row) => elements(row.props.children).map(cell));
    return { columns, rows };
  }, [children]);
  return <RichTable {...data} direction={direction} />;
}
