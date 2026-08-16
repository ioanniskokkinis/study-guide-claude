import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai/claude", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/claude")>("@/lib/ai/claude");
  return { ...actual, extractStructured: vi.fn() };
});

import { extractStructured } from "@/lib/ai/claude";
import { prisma } from "@/lib/db/prisma";
import { createStudyRoadmap } from "@/lib/advisor/roadmap-service";
import { getRoadmap } from "@/lib/advisor/queries";
import { getRoadmapProgress } from "@/lib/advisor/progress";
import { generateRoadmapPdf } from "@/lib/pdf/roadmap-pdf";
import { extractPdfText } from "@/lib/documents/pdf-extractor";
import { GET as getRoadmapPdf } from "@/app/api/roadmaps/[id]/pdf/route";
import { getCurrentUser } from "@/lib/auth/dev-user";
import { seedCourseWithConcepts } from "./fixtures";

function mockAiOutput(conceptIds: string[]) {
  vi.mocked(extractStructured).mockResolvedValue({
    data: {
      summary: "This roadmap focuses on your weakest topics first.",
      priorities: conceptIds.map((id) => ({ conceptId: id, reason: "Grounded reason." })),
      weeks: [{ weekNumber: 1, focusConceptIds: conceptIds, reason: "Week one focus." }],
      milestones: [{ title: "Finish week one review", afterWeek: 1 }],
      risks: ["Limited time before the deadline."],
      recommendations: ["Review daily in short sessions."],
    },
    usage: { inputTokens: 100, outputTokens: 100 },
  } as never);
}

/** Phase 15 §44-52 — deterministic PDF export. */
describe("roadmap PDF export", () => {
  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    userId = (await prisma.user.create({ data: { email: `pdf-${suffix}@example.com` } })).id;
    otherUserId = (await prisma.user.create({ data: { email: `pdf-other-${suffix}@example.com` } })).id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
  });

  afterEach(() => {
    vi.mocked(extractStructured).mockReset();
  });

  async function makeRoadmap() {
    const { course, concepts } = await seedCourseWithConcepts(userId, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    return createStudyRoadmap(userId, {
      courseId: course.id,
      goal: "Pass my unique-goal-marker exam",
      minutesPerDay: 30,
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });
  }

  it("generates a well-formed PDF (starts with the %PDF- magic bytes)", async () => {
    const roadmap = await makeRoadmap();
    const full = await getRoadmap(userId, roadmap.id);
    const progress = await getRoadmapProgress(userId, roadmap.id);
    const pdfBytes = await generateRoadmapPdf(full!, progress!);

    expect(pdfBytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("never calls the AI during PDF generation", async () => {
    const roadmap = await makeRoadmap();
    vi.mocked(extractStructured).mockClear();

    const full = await getRoadmap(userId, roadmap.id);
    const progress = await getRoadmapProgress(userId, roadmap.id);
    await generateRoadmapPdf(full!, progress!);

    expect(extractStructured).not.toHaveBeenCalled();
  });

  it("contains the expected sections and roadmap content as extractable text", async () => {
    const roadmap = await makeRoadmap();
    const full = await getRoadmap(userId, roadmap.id);
    const progress = await getRoadmapProgress(userId, roadmap.id);
    const pdfBytes = await generateRoadmapPdf(full!, progress!);

    const { text } = await extractPdfText(pdfBytes);
    expect(text).toContain("Study Roadmap");
    expect(text).toContain("Goal");
    expect(text).toContain("unique-goal-marker");
    expect(text).toContain("Weekly Roadmap");
    expect(text).toContain("Daily Schedule");
    expect(text).toContain("Study Recommendations");
    expect(text).toContain("Notes");
  });

  it("generates successfully even for a roadmap with no scheduled items (empty/partial data)", async () => {
    const roadmap = await makeRoadmap();
    await prisma.studyRoadmapItem.deleteMany({ where: { roadmapId: roadmap.id } });

    const full = await getRoadmap(userId, roadmap.id);
    const progress = await getRoadmapProgress(userId, roadmap.id);
    const pdfBytes = await generateRoadmapPdf(full!, progress!);

    expect(pdfBytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("never exposes raw database ids in the rendered text", async () => {
    const roadmap = await makeRoadmap();
    const full = await getRoadmap(userId, roadmap.id);
    const progress = await getRoadmapProgress(userId, roadmap.id);
    const pdfBytes = await generateRoadmapPdf(full!, progress!);

    const { text } = await extractPdfText(pdfBytes);
    expect(text).not.toContain(roadmap.id);
  });

  it("the PDF export API route returns a real PDF for a roadmap owned by the current (dev) user, and 404 for a nonexistent roadmap", async () => {
    // This sandbox's auth is a single-dev-user stand-in (getCurrentUser always
    // resolves to the same seeded user, see src/lib/auth/dev-user.ts) — the
    // cross-user ownership check itself (getRoadmap() scoping by userId) is
    // exercised directly in roadmap-service.test.ts's "own roadmap vs another
    // user's" case. This test covers the route's own behavior: it must
    // return the actual PDF bytes for a real, accessible roadmap, and a
    // clean 404 (never a 500) for one that doesn't exist.
    const devUser = await getCurrentUser();
    const { course, concepts } = await seedCourseWithConcepts(devUser.id, { conceptCount: 1 });
    mockAiOutput([concepts[0].id]);
    const roadmap = await createStudyRoadmap(devUser.id, {
      courseId: course.id,
      goal: "Pass my exam",
      minutesPerDay: 30,
      deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      scope: { scopeType: "COURSE" },
    });

    const okRequest = new Request(`http://localhost/api/roadmaps/${roadmap.id}/pdf`);
    const okResponse = await getRoadmapPdf(okRequest, { params: Promise.resolve({ id: roadmap.id }) });
    expect(okResponse.status).toBe(200);
    expect(okResponse.headers.get("Content-Type")).toBe("application/pdf");
    const bytes = Buffer.from(await okResponse.arrayBuffer());
    expect(bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");

    const missingRequest = new Request("http://localhost/api/roadmaps/does-not-exist/pdf");
    const missingResponse = await getRoadmapPdf(missingRequest, { params: Promise.resolve({ id: "does-not-exist" }) });
    expect(missingResponse.status).toBe(404);
  });
});
