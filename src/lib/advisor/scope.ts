import { prisma } from "@/lib/db/prisma";
import type { StudyRoadmapScopeType } from "@/generated/prisma/client";
import { collectFolderSubtreeIds } from "@/lib/services/folders";

/**
 * Resolves a Study Advisor's requested material scope (Phase 15 §11, §19)
 * into a concrete, ownership-verified set of concept ids — the only thing
 * the rest of the Advisor pipeline (knowledge-gap analysis, AI context,
 * roadmap generation) is allowed to see. A course/folder/document the
 * requesting user doesn't own can never leak in here: every lookup below is
 * filtered by `courseId`/`userId` before anything else happens (spec §18,
 * §23 — the same "never trust a client-asserted id" pattern this whole
 * codebase uses).
 *
 * Concept membership is derived transitively via
 * Concept -> ConceptSource -> DocumentChunk -> Document(.folderId), never
 * duplicated or cached — the knowledge graph itself (Phase 3) is the single
 * source of truth for which concepts a document teaches.
 */
export class InvalidScopeError extends Error {}

export interface ResolvedScope {
  scopeType: StudyRoadmapScopeType;
  scopeFolderId: string | null;
  /** Only populated (and only persisted via StudyRoadmapDocument) for a DOCUMENTS scope — see spec §19/§31's "persist enough relational information to reconstruct the scope." */
  documentIds: string[];
  conceptIds: string[];
  /** Human-readable description for display/AI context — never trusted as the scope's source of truth, only its label. */
  label: string;
}

export interface ScopeInput {
  scopeType: StudyRoadmapScopeType;
  folderId?: string | null;
  documentIds?: string[];
}

async function conceptIdsForDocuments(courseId: string, documentIds: string[]): Promise<string[]> {
  if (documentIds.length === 0) return [];
  const concepts = await prisma.concept.findMany({
    where: { courseId, sources: { some: { documentChunk: { documentId: { in: documentIds } } } } },
    select: { id: true },
  });
  return concepts.map((c) => c.id);
}

export async function resolveStudyScope(userId: string, courseId: string, input: ScopeInput): Promise<ResolvedScope> {
  const course = await prisma.course.findFirst({ where: { id: courseId, userId }, select: { id: true, title: true } });
  if (!course) throw new InvalidScopeError("Course not found.");

  if (input.scopeType === "COURSE") {
    const concepts = await prisma.concept.findMany({ where: { courseId }, select: { id: true } });
    return { scopeType: "COURSE", scopeFolderId: null, documentIds: [], conceptIds: concepts.map((c) => c.id), label: course.title };
  }

  if (input.scopeType === "FOLDER") {
    if (!input.folderId) throw new InvalidScopeError("folderId is required for a FOLDER scope.");
    const folder = await prisma.folder.findFirst({ where: { id: input.folderId, courseId } });
    if (!folder) throw new InvalidScopeError("Folder not found in this course.");

    const subtreeIds = await collectFolderSubtreeIds(courseId, folder.id);
    const documents = await prisma.document.findMany({ where: { folderId: { in: Array.from(subtreeIds) } }, select: { id: true } });
    const documentIds = documents.map((d) => d.id);
    const conceptIds = await conceptIdsForDocuments(courseId, documentIds);
    return { scopeType: "FOLDER", scopeFolderId: folder.id, documentIds, conceptIds, label: folder.name };
  }

  // DOCUMENTS
  if (!input.documentIds || input.documentIds.length === 0) {
    throw new InvalidScopeError("At least one document must be selected for a document-based scope.");
  }
  const documents = await prisma.document.findMany({
    where: { id: { in: input.documentIds }, courseId },
    select: { id: true, originalFilename: true },
  });
  if (documents.length !== new Set(input.documentIds).size) {
    throw new InvalidScopeError("One or more selected documents were not found in this course.");
  }

  const documentIds = documents.map((d) => d.id);
  const conceptIds = await conceptIdsForDocuments(courseId, documentIds);
  const label = documents.map((d) => d.originalFilename).join(", ");
  return { scopeType: "DOCUMENTS", scopeFolderId: null, documentIds, conceptIds, label };
}
