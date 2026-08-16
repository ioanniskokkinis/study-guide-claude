import { getCurrentUser } from "@/lib/auth/dev-user";
import { getRoadmap } from "@/lib/advisor/queries";
import { getRoadmapProgress } from "@/lib/advisor/progress";
import { generateRoadmapPdf } from "@/lib/pdf/roadmap-pdf";

export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * PDF export (Phase 15 §44-47). Ownership is enforced by getRoadmap()
 * itself (scoped to `userId`) exactly like every other roadmap read — a
 * user can only ever export their own roadmap. No AI call, deterministic
 * from persisted data only (spec §46).
 */
export async function GET(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const user = await getCurrentUser();

  const [roadmap, progress] = await Promise.all([getRoadmap(user.id, id), getRoadmapProgress(user.id, id)]);
  if (!roadmap || !progress) {
    return Response.json({ error: "Roadmap not found." }, { status: 404 });
  }

  try {
    const pdfBytes = await generateRoadmapPdf(roadmap, progress);
    const filename = `${roadmap.title.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 80) || "study-roadmap"}.pdf`;
    return new Response(new Blob([new Uint8Array(pdfBytes)]), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error(`PDF generation failed for roadmap ${id}:`, error);
    return Response.json({ error: "The PDF could not be generated. Please try again." }, { status: 500 });
  }
}
