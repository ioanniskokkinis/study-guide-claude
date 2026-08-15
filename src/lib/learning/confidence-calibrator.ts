/**
 * Confidence calibration (spec §12-13): confidence is a student's
 * self-reported certainty (1-5, normalized to 0-1 by callers before this
 * module ever sees it), stored and reasoned about separately from
 * correctness. This is deliberately simple arithmetic, not statistics —
 * the spec explicitly scopes Phase 4 to "not advanced statistics yet."
 */

const HIGH_CONFIDENCE = 0.7;
const LOW_CONFIDENCE = 0.4;
const CORRECT = 0.7;
const WRONG = 0.4;

export type CalibrationSignal = "OVERCONFIDENT" | "UNDERCONFIDENT" | "CALIBRATED";

/**
 * Per-attempt signal. High confidence + wrong answer is a misconception
 * signal (the student is confidently incorrect, not just unsure). Low
 * confidence + correct answer is fragile knowledge (right by luck or
 * partial understanding, not to be over-trusted as mastery).
 */
export function classifyCalibrationSignal(confidence: number, correctness: number): CalibrationSignal {
  const highConfidence = confidence >= HIGH_CONFIDENCE;
  const lowConfidence = confidence <= LOW_CONFIDENCE;
  const correct = correctness >= CORRECT;
  const wrong = correctness <= WRONG;

  if (highConfidence && wrong) return "OVERCONFIDENT";
  if (lowConfidence && correct) return "UNDERCONFIDENT";
  return "CALIBRATED";
}

export interface CalibrationSample {
  confidence: number | null;
  correctness: number | null;
}

export interface CalibrationResult {
  averageConfidence: number;
  averageScore: number;
  /** averageConfidence - averageScore: positive = overconfident on average, negative = underconfident. */
  gap: number;
  sampleSize: number;
}

/** Aggregate calibration across a set of attempts (e.g. a course's worth of evidence). */
export function calculateCalibration(samples: CalibrationSample[]): CalibrationResult {
  const usable = samples.filter(
    (s): s is { confidence: number; correctness: number } => s.confidence != null && s.correctness != null,
  );

  if (usable.length === 0) {
    return { averageConfidence: 0, averageScore: 0, gap: 0, sampleSize: 0 };
  }

  const averageConfidence = usable.reduce((sum, s) => sum + s.confidence, 0) / usable.length;
  const averageScore = usable.reduce((sum, s) => sum + s.correctness, 0) / usable.length;

  return {
    averageConfidence,
    averageScore,
    gap: averageConfidence - averageScore,
    sampleSize: usable.length,
  };
}
