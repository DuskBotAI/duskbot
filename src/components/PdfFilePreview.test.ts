import { describe, expect, it } from "vitest";
import { filePreviewKind } from "./HtmlFilePreview";

describe("PDF preview", () => {
  it("opens a PDF in a preview rather than saving it at once", () => {
    expect(filePreviewKind("report.pdf")).toBe("pdf");
    expect(filePreviewKind("REPORT.PDF")).toBe("pdf");
    expect(filePreviewKind("report.pdf.zip")).toBeNull();
  });
});
