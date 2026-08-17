"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";

interface FolderOption {
  id: string;
  name: string;
}

interface DocumentOption {
  id: string;
  originalFilename: string;
}

const WEEKDAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
];

type ScopeType = "COURSE" | "FOLDER" | "DOCUMENTS";

/**
 * Study Advisor input form (Phase 15 §22). No field is required beyond
 * goal/minutesPerDay — deadline, study days, target score, and material
 * scope all have sensible defaults (spec §22: "the UI must not require
 * every field").
 */
export function StudyAdvisorForm({
  courseId,
  folders,
  documents,
}: {
  courseId: string;
  folders: FolderOption[];
  documents: DocumentOption[];
}) {
  const router = useRouter();
  const [goal, setGoal] = useState("");
  const [deadline, setDeadline] = useState("");
  const [minutesPerDay, setMinutesPerDay] = useState(45);
  const [studyDays, setStudyDays] = useState<Set<number>>(new Set());
  const [targetScorePercent, setTargetScorePercent] = useState<string>("");
  const [scopeType, setScopeType] = useState<ScopeType>("COURSE");
  const [folderId, setFolderId] = useState<string>(folders[0]?.id ?? "");
  const [documentIds, setDocumentIds] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleDay(day: number) {
    setStudyDays((prev) => {
      const next = new Set(prev);
      if (next.has(day)) next.delete(day);
      else next.add(day);
      return next;
    });
  }

  function toggleDocument(id: string) {
    setDocumentIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!goal.trim()) {
      setError("Please describe your goal.");
      return;
    }
    if (scopeType === "FOLDER" && !folderId) {
      setError("Please choose a folder.");
      return;
    }
    if (scopeType === "DOCUMENTS" && documentIds.size === 0) {
      setError("Please select at least one document.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`/api/courses/${courseId}/roadmaps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          goal,
          deadline: deadline ? new Date(deadline).toISOString() : null,
          minutesPerDay,
          studyDays: Array.from(studyDays),
          targetScore: targetScorePercent ? Number(targetScorePercent) / 100 : null,
          scopeType,
          folderId: scopeType === "FOLDER" ? folderId : null,
          documentIds: scopeType === "DOCUMENTS" ? Array.from(documentIds) : [],
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(body.error ?? "Could not build a roadmap.");
      }
      router.push(`/courses/${courseId}/advisor/${body.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build a roadmap.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <form onSubmit={handleSubmit} className="space-y-6 rounded-lg border border-border p-5">
        <div>
          <label htmlFor="goal" className="block text-sm font-medium text-fg">
            Goal
          </label>
          <Input id="goal" type="text" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="e.g. Pass my Biology exam" className="mt-1" />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="deadline" className="block text-sm font-medium text-fg">
              Deadline (optional)
            </label>
            <Input id="deadline" type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} className="mt-1" />
          </div>
          <div>
            <label htmlFor="target-score" className="block text-sm font-medium text-fg">
              Target score % (optional)
            </label>
            <Input
              id="target-score"
              type="number"
              min={0}
              max={100}
              value={targetScorePercent}
              onChange={(e) => setTargetScorePercent(e.target.value)}
              className="mt-1"
            />
          </div>
        </div>

        <div>
          <label htmlFor="minutes-per-day" className="block text-sm font-medium text-fg">
            Minutes per day
          </label>
          <Input
            id="minutes-per-day"
            type="number"
            min={5}
            max={600}
            value={minutesPerDay}
            onChange={(e) => setMinutesPerDay(Number(e.target.value))}
            className="mt-1 w-32"
          />
        </div>

        <div>
          <p className="text-sm font-medium text-fg">Study days (optional — leave blank for every day)</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {WEEKDAYS.map((day) => (
              <button
                key={day.value}
                type="button"
                onClick={() => toggleDay(day.value)}
                aria-pressed={studyDays.has(day.value)}
                className={`focus-ring transition-standard rounded-full px-3 py-1 text-xs font-medium ${
                  studyDays.has(day.value) ? "bg-accent text-accent-fg" : "border border-border text-fg-muted hover:bg-surface-hover"
                }`}
              >
                {day.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="text-sm font-medium text-fg">Study material</p>
          <div className="mt-2 flex flex-wrap gap-2 text-sm">
            {(["COURSE", "FOLDER", "DOCUMENTS"] as ScopeType[]).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setScopeType(type)}
                aria-pressed={scopeType === type}
                className={`focus-ring transition-standard rounded-md px-3 py-1.5 font-medium ${
                  scopeType === type ? "bg-accent text-accent-fg" : "border border-border text-fg-muted hover:bg-surface-hover"
                }`}
              >
                {type === "COURSE" ? "Entire course" : type === "FOLDER" ? "One folder" : "Selected documents"}
              </button>
            ))}
          </div>

          {scopeType === "FOLDER" && (
            <Select value={folderId} onChange={(e) => setFolderId(e.target.value)} className="mt-3">
              {folders.length === 0 ? (
                <option value="">No folders yet</option>
              ) : (
                folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))
              )}
            </Select>
          )}

          {scopeType === "DOCUMENTS" && (
            <ul className="mt-3 max-h-48 space-y-1 overflow-auto rounded-md border border-border p-2 text-sm">
              {documents.map((doc) => (
                <li key={doc.id}>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={documentIds.has(doc.id)} onChange={() => toggleDocument(doc.id)} className="focus-ring accent-accent" />
                    <span className="truncate">{doc.originalFilename}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        {error && (
          <div className="rounded-lg border border-danger-border bg-danger-bg px-4 py-3.5 text-sm">
            <p className="font-medium text-danger-fg">{error}</p>
            <a href={`/courses/${courseId}/knowledge`} className="focus-ring mt-1 inline-block rounded text-danger-fg underline underline-offset-2">
              Check the Knowledge Graph
            </a>
          </div>
        )}

        <Button type="submit" variant="primary" size="lg" loading={submitting} className="w-full">
          {submitting ? "Building your roadmap…" : "Build my roadmap"}
        </Button>
      </form>
    </div>
  );
}
