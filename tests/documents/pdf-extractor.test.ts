import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractPdfText, NoExtractableTextError } from "@/lib/documents/pdf-extractor";

async function makeTextPdf(pagesText: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pagesText) {
    const page = doc.addPage();
    page.setFont(font);
    page.drawText(text, { x: 50, y: 700, size: 14 });
  }
  return Buffer.from(await doc.save());
}

async function makeBlankPdf(pageCount: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) {
    doc.addPage();
  }
  return Buffer.from(await doc.save());
}

describe("extractPdfText", () => {
  it("extracts text and page count from a normal text-based PDF", async () => {
    const buffer = await makeTextPdf(["Hello World from page one.", "Second page content here."]);

    const result = await extractPdfText(buffer);

    expect(result.pageCount).toBe(2);
    expect(result.text).toContain("Hello World from page one.");
    expect(result.text).toContain("Second page content here.");
  });

  it("throws NoExtractableTextError for a PDF with no extractable text", async () => {
    const buffer = await makeBlankPdf(1);

    await expect(extractPdfText(buffer)).rejects.toThrow(NoExtractableTextError);
    await expect(extractPdfText(buffer)).rejects.toThrow(/OCR is not supported/);
  });
});
