import { describe, expect, it } from "vitest";
import { calculateCalibration, classifyCalibrationSignal } from "@/lib/learning/confidence-calibrator";

describe("classifyCalibrationSignal", () => {
  it("flags high confidence + wrong as OVERCONFIDENT (misconception signal)", () => {
    expect(classifyCalibrationSignal(0.9, 0.1)).toBe("OVERCONFIDENT");
  });

  it("flags low confidence + correct as UNDERCONFIDENT (fragile knowledge)", () => {
    expect(classifyCalibrationSignal(0.1, 0.9)).toBe("UNDERCONFIDENT");
  });

  it("treats high confidence + correct as CALIBRATED", () => {
    expect(classifyCalibrationSignal(0.9, 0.9)).toBe("CALIBRATED");
  });

  it("treats low confidence + wrong as CALIBRATED (accurately unsure)", () => {
    expect(classifyCalibrationSignal(0.1, 0.1)).toBe("CALIBRATED");
  });
});

describe("calculateCalibration", () => {
  it("returns a zeroed result for an empty sample set", () => {
    expect(calculateCalibration([])).toEqual({ averageConfidence: 0, averageScore: 0, gap: 0, sampleSize: 0 });
  });

  it("ignores samples missing confidence or correctness", () => {
    const result = calculateCalibration([
      { confidence: 0.8, correctness: 0.8 },
      { confidence: null, correctness: 0.5 },
      { confidence: 0.5, correctness: null },
    ]);
    expect(result.sampleSize).toBe(1);
  });

  it("computes a positive gap when the student is systematically overconfident", () => {
    const result = calculateCalibration([
      { confidence: 0.9, correctness: 0.3 },
      { confidence: 0.9, correctness: 0.3 },
    ]);
    expect(result.averageConfidence).toBeCloseTo(0.9);
    expect(result.averageScore).toBeCloseTo(0.3);
    expect(result.gap).toBeGreaterThan(0);
  });

  it("computes a negative gap when the student is systematically underconfident", () => {
    const result = calculateCalibration([
      { confidence: 0.2, correctness: 0.9 },
      { confidence: 0.2, correctness: 0.9 },
    ]);
    expect(result.gap).toBeLessThan(0);
  });
});
