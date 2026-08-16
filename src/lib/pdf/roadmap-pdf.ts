import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { getRoadmap } from "@/lib/advisor/queries";
import type { RoadmapProgress } from "@/lib/advisor/progress";

type Roadmap = NonNullable<Awaited<ReturnType<typeof getRoadmap>>>;

/**
 * Deterministic, server-side roadmap PDF export (Phase 15 §44-46). Built
 * entirely from already-persisted roadmap/progress data — no AI call here,
 * ever, so generating the same roadmap's PDF twice produces equivalent
 * content (spec §46). Never renders internal ids, storage paths, prompts,
 * or API keys — only what a student would already see on the roadmap page.
 */

const PAGE_WIDTH = 595.28; // A4, points
const PAGE_HEIGHT = 841.89;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const ACTION_LABEL: Record<string, string> = {
  LEARN: "Learn",
  REVIEW: "Review",
  PRACTICE: "Practice",
  ACTIVE_RECALL: "Active recall",
  SPACED_REPETITION: "Spaced repetition",
  TUTOR: "Tutor",
  EXAM_PRACTICE: "Exam practice",
};

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

class PdfWriter {
  private doc!: PDFDocument;
  private page!: PDFPage;
  private y = 0;
  private font!: PDFFont;
  private bold!: PDFFont;

  static async create(): Promise<PdfWriter> {
    const writer = new PdfWriter();
    writer.doc = await PDFDocument.create();
    writer.font = await writer.doc.embedFont(StandardFonts.Helvetica);
    writer.bold = await writer.doc.embedFont(StandardFonts.HelveticaBold);
    writer.addPage();
    return writer;
  }

  addPage(): void {
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.y = PAGE_HEIGHT - MARGIN;
  }

  private ensureSpace(height: number): void {
    if (this.y - height < MARGIN) this.addPage();
  }

  heading(text: string): void {
    this.ensureSpace(30);
    this.page.drawText(text, { x: MARGIN, y: this.y, size: 18, font: this.bold, color: rgb(0.09, 0.09, 0.09) });
    this.y -= 26;
  }

  subheading(text: string): void {
    this.ensureSpace(20);
    this.page.drawText(text, { x: MARGIN, y: this.y, size: 12, font: this.bold, color: rgb(0.2, 0.2, 0.2) });
    this.y -= 17;
  }

  paragraph(text: string, size = 10): void {
    if (!text) return;
    for (const line of wrapText(text, this.font, size, CONTENT_WIDTH)) {
      this.ensureSpace(size + 4);
      this.page.drawText(line, { x: MARGIN, y: this.y, size, font: this.font, color: rgb(0.25, 0.25, 0.25) });
      this.y -= size + 4;
    }
  }

  bullet(text: string, size = 10): void {
    const lines = wrapText(text, this.font, size, CONTENT_WIDTH - 14);
    lines.forEach((line, i) => {
      this.ensureSpace(size + 4);
      this.page.drawText(i === 0 ? `• ${line}` : `  ${line}`, {
        x: MARGIN,
        y: this.y,
        size,
        font: this.font,
        color: rgb(0.25, 0.25, 0.25),
      });
      this.y -= size + 4;
    });
  }

  ruledLine(): void {
    this.ensureSpace(24);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE_WIDTH - MARGIN, y: this.y },
      thickness: 0.5,
      color: rgb(0.75, 0.75, 0.75),
    });
    this.y -= 24;
  }

  spacer(height = 10): void {
    this.y -= height;
  }

  async save(): Promise<Buffer> {
    return Buffer.from(await this.doc.save());
  }
}

function scopeLabel(roadmap: Roadmap): string {
  if (roadmap.scopeType === "COURSE") return "Entire course";
  if (roadmap.scopeType === "FOLDER") return roadmap.scopeFolder?.name ?? "Folder";
  return roadmap.scopeDocuments.map((d) => d.document.originalFilename).join(", ") || "Selected documents";
}

export async function generateRoadmapPdf(roadmap: Roadmap, progress: RoadmapProgress): Promise<Buffer> {
  const w = await PdfWriter.create();

  w.heading("Study Roadmap");
  w.subheading(roadmap.title);
  w.spacer(4);

  w.subheading("Goal");
  w.paragraph(roadmap.goal);
  w.spacer(4);

  w.subheading("Deadline");
  w.paragraph(roadmap.deadline ? formatDate(roadmap.deadline) : "None set");
  w.spacer(4);

  w.subheading("Current status");
  w.paragraph(
    `${Math.round(progress.overallProgressPercent * 100)}% overall progress · ${Math.round(progress.currentAverageMasteryPercent * 100)}% average mastery · ${progress.completedItems}/${progress.totalItems} items complete${progress.overdueItems > 0 ? ` · ${progress.overdueItems} overdue` : ""}`,
  );
  w.spacer(4);

  w.subheading("Study material");
  w.paragraph(scopeLabel(roadmap));
  w.spacer(4);

  const allItems = roadmap.weeks.flatMap((week) => week.items);
  const priorities = allItems
    .filter((i) => !i.isMilestone && i.conceptId)
    .sort((a, b) => b.priority - a.priority)
    .filter((item, index, all) => all.findIndex((i) => i.conceptId === item.conceptId) === index)
    .slice(0, 8);

  if (priorities.length > 0) {
    w.subheading("Key priorities");
    for (const item of priorities) w.bullet(`${item.title} — ${item.reason}`);
    w.spacer(4);
  }

  if (roadmap.summary) {
    w.subheading("Summary");
    w.paragraph(roadmap.summary);
  }

  w.addPage();
  w.heading("Weekly Roadmap");
  for (const week of roadmap.weeks) {
    w.subheading(`Week ${week.weekNumber} (${formatDate(week.startDate)} – ${formatDate(week.endDate)})`);
    w.paragraph(`Focus: ${week.focusSummary}`);
    w.paragraph(week.reason);
    w.spacer(6);
  }

  w.heading("Daily Schedule");
  const dailyItems = allItems.filter((i) => !i.isMilestone && i.scheduledDate).sort((a, b) => a.scheduledDate!.getTime() - b.scheduledDate!.getTime());
  const byDate = new Map<string, typeof dailyItems>();
  for (const item of dailyItems) {
    const key = item.scheduledDate!.toISOString().slice(0, 10);
    const list = byDate.get(key) ?? [];
    list.push(item);
    byDate.set(key, list);
  }
  for (const [dateKey, items] of byDate) {
    w.subheading(formatDate(dateKey));
    for (const item of items) w.bullet(`${ACTION_LABEL[item.action] ?? item.action}: ${item.title} (${item.estimatedMinutes} min)`);
  }

  const milestones = allItems.filter((i) => i.isMilestone);
  if (milestones.length > 0) {
    w.heading("Milestones");
    for (const m of milestones) w.bullet(`${m.title}${m.scheduledDate ? ` — by ${formatDate(m.scheduledDate)}` : ""}`);
  }

  w.addPage();
  w.heading("Study Recommendations");
  const recommendations = Array.isArray(roadmap.recommendations) ? (roadmap.recommendations as unknown[]).filter((r): r is string => typeof r === "string") : [];
  if (recommendations.length > 0) {
    for (const r of recommendations) w.bullet(r);
  } else {
    w.paragraph("No specific recommendations for this roadmap.");
  }
  w.spacer(8);

  const risks = Array.isArray(roadmap.risks) ? (roadmap.risks as unknown[]).filter((r): r is string => typeof r === "string") : [];
  if (risks.length > 0) {
    w.subheading("Risks");
    for (const r of risks) w.bullet(r);
    w.spacer(8);
  }

  w.subheading("Notes");
  for (let i = 0; i < 8; i++) w.ruledLine();

  return w.save();
}
