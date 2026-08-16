import { PDFDocument, StandardFonts } from "pdf-lib";

export async function makeTextPdfBuffer(text: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage();
  page.setFont(font);
  page.drawText(text, { x: 50, y: 700, size: 12, lineHeight: 16 });
  return Buffer.from(await doc.save());
}
