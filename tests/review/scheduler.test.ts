import { describe, expect, it } from "vitest";
import { difficultyGrowthFactor, performanceAdjustment, scheduleReview, type ReviewItemSnapshot } from "@/lib/review/scheduler";
import {
  GRADUATION_REPS,
  LAPSE_RELEARN_INTERVAL_DAYS,
  MAX_DIFFICULTY,
  MAX_INTERVAL_DAYS,
  MIN_DIFFICULTY,
  MIN_INTERVAL_DAYS,
} from "@/lib/review/config";

function newItem(overrides: Partial<ReviewItemSnapshot> = {}): ReviewItemSnapshot {
  return {
    status: "NEW",
    interval: 0,
    stability: 0,
    difficulty: 3,
    repetitionCount: 0,
    lapseCount: 0,
    ...overrides,
  };
}

const NOW = new Date("2026-08-15T12:00:00Z");

describe("scheduleReview — Claude is never involved (spec §2)", () => {
  it("is a pure function: identical input always produces identical output", () => {
    const a = scheduleReview({ reviewItem: newItem(), outcome: "GOOD", now: NOW });
    const b = scheduleReview({ reviewItem: newItem(), outcome: "GOOD", now: NOW });
    expect(a).toEqual(b);
  });
});

describe("scheduleReview — first review (spec §22)", () => {
  it("GOOD on a brand-new item schedules a short positive interval and graduates it into LEARNING", () => {
    const result = scheduleReview({ reviewItem: newItem(), outcome: "GOOD", now: NOW });
    expect(result.interval).toBeGreaterThan(0);
    expect(result.repetitionCount).toBe(1);
    expect(result.status).toBe("LEARNING");
    expect(result.lapseCount).toBe(0);
  });

  it("EASY schedules a longer interval than GOOD on the same brand-new item", () => {
    const good = scheduleReview({ reviewItem: newItem(), outcome: "GOOD", now: NOW });
    const easy = scheduleReview({ reviewItem: newItem(), outcome: "EASY", now: NOW });
    expect(easy.interval).toBeGreaterThan(good.interval);
  });

  it("HARD schedules a shorter interval than GOOD on the same brand-new item", () => {
    const good = scheduleReview({ reviewItem: newItem(), outcome: "GOOD", now: NOW });
    const hard = scheduleReview({ reviewItem: newItem(), outcome: "HARD", now: NOW });
    expect(hard.interval).toBeLessThan(good.interval);
  });

  it("AGAIN on a brand-new item stays in LEARNING (nothing was learned yet to relapse from) and increments lapseCount", () => {
    const result = scheduleReview({ reviewItem: newItem(), outcome: "AGAIN", now: NOW });
    expect(result.status).toBe("LEARNING");
    expect(result.lapseCount).toBe(1);
    expect(result.repetitionCount).toBe(0);
    expect(result.interval).toBe(LAPSE_RELEARN_INTERVAL_DAYS);
  });
});

describe("scheduleReview — AGAIN/HARD/GOOD/EASY behavior (spec §6)", () => {
  const established = newItem({ status: "REVIEW", interval: 10, stability: 10, repetitionCount: 3 });

  it("AGAIN resets/reduces the interval and increases lapseCount", () => {
    const result = scheduleReview({ reviewItem: established, outcome: "AGAIN", now: NOW });
    expect(result.interval).toBeLessThan(established.interval);
    expect(result.lapseCount).toBe(established.lapseCount + 1);
    expect(result.repetitionCount).toBe(0);
    expect(result.status).toBe("RELEARNING");
  });

  it("HARD, GOOD, EASY all increase the interval, in increasing order", () => {
    const hard = scheduleReview({ reviewItem: established, outcome: "HARD", now: NOW });
    const good = scheduleReview({ reviewItem: established, outcome: "GOOD", now: NOW });
    const easy = scheduleReview({ reviewItem: established, outcome: "EASY", now: NOW });

    expect(hard.interval).toBeGreaterThan(established.interval);
    expect(good.interval).toBeGreaterThan(hard.interval);
    expect(easy.interval).toBeGreaterThan(good.interval);
  });

  it("difficulty moves in the expected direction per outcome: AGAIN/HARD increase it, GOOD/EASY decrease it", () => {
    const again = scheduleReview({ reviewItem: established, outcome: "AGAIN", now: NOW });
    const hard = scheduleReview({ reviewItem: established, outcome: "HARD", now: NOW });
    const good = scheduleReview({ reviewItem: established, outcome: "GOOD", now: NOW });
    const easy = scheduleReview({ reviewItem: established, outcome: "EASY", now: NOW });

    expect(again.difficulty).toBeGreaterThan(established.difficulty);
    expect(hard.difficulty).toBeGreaterThan(established.difficulty);
    expect(good.difficulty).toBeLessThan(established.difficulty);
    expect(easy.difficulty).toBeLessThan(good.difficulty);
  });

  it("difficulty stays within [MIN_DIFFICULTY, MAX_DIFFICULTY] under repeated extreme ratings", () => {
    let item = newItem({ difficulty: MAX_DIFFICULTY });
    for (let i = 0; i < 20; i++) {
      const result = scheduleReview({ reviewItem: item, outcome: "AGAIN", now: NOW });
      expect(result.difficulty).toBeLessThanOrEqual(MAX_DIFFICULTY);
      item = { ...item, ...result };
    }
    item = newItem({ difficulty: MIN_DIFFICULTY, status: "REVIEW", stability: 5 });
    for (let i = 0; i < 20; i++) {
      const result = scheduleReview({ reviewItem: item, outcome: "EASY", now: NOW });
      expect(result.difficulty).toBeGreaterThanOrEqual(MIN_DIFFICULTY);
      item = { ...item, ...result };
    }
  });
});

describe("scheduleReview — repeated reviews and graduation", () => {
  it("graduates from LEARNING to REVIEW after GRADUATION_REPS consecutive successes", () => {
    let item = newItem();
    let lastStatus = item.status;
    for (let i = 0; i < GRADUATION_REPS; i++) {
      const result = scheduleReview({ reviewItem: item, outcome: "GOOD", now: NOW });
      lastStatus = result.status;
      item = { ...item, ...result };
    }
    expect(item.repetitionCount).toBe(GRADUATION_REPS);
    expect(lastStatus).toBe("REVIEW");
  });

  it("intervals keep growing across consecutive GOOD ratings, staying below MAX_INTERVAL_DAYS", () => {
    let item = newItem();
    let previousInterval = 0;
    for (let i = 0; i < 8; i++) {
      const result = scheduleReview({ reviewItem: item, outcome: "GOOD", now: NOW });
      expect(result.interval).toBeGreaterThanOrEqual(previousInterval);
      expect(result.interval).toBeLessThanOrEqual(MAX_INTERVAL_DAYS);
      previousInterval = result.interval;
      item = { ...item, ...result };
    }
  });

  it("never schedules an interval below MIN_INTERVAL_DAYS on a successful rating", () => {
    const result = scheduleReview({ reviewItem: newItem(), outcome: "HARD", now: NOW });
    expect(result.interval).toBeGreaterThanOrEqual(MIN_INTERVAL_DAYS);
  });
});

describe("scheduleReview — lapse recovery", () => {
  it("a lapsed item that had substantial prior stability recovers faster than a brand-new item on the next GOOD", () => {
    const veteran = newItem({ status: "REVIEW", interval: 30, stability: 30, repetitionCount: 5 });
    const lapsed = scheduleReview({ reviewItem: veteran, outcome: "AGAIN", now: NOW });
    const relearning: ReviewItemSnapshot = { ...veteran, ...lapsed };

    const recovered = scheduleReview({ reviewItem: relearning, outcome: "GOOD", now: NOW });
    const brandNew = scheduleReview({ reviewItem: newItem(), outcome: "GOOD", now: NOW });

    expect(recovered.interval).toBeGreaterThan(brandNew.interval);
  });

  it("repeated lapses shrink stability further each time, never below the configured floor", () => {
    let item = newItem({ status: "REVIEW", stability: 20, interval: 20, repetitionCount: 4 });
    let previousStability = item.stability;
    for (let i = 0; i < 3; i++) {
      const result = scheduleReview({ reviewItem: item, outcome: "AGAIN", now: NOW });
      expect(result.stability).toBeLessThanOrEqual(previousStability);
      expect(result.stability).toBeGreaterThan(0);
      previousStability = result.stability;
      item = { ...item, ...result };
    }
    expect(item.lapseCount).toBe(3);
  });
});

describe("difficultyGrowthFactor", () => {
  it("is monotonically decreasing as difficulty increases", () => {
    expect(difficultyGrowthFactor(MIN_DIFFICULTY)).toBeGreaterThan(difficultyGrowthFactor(3));
    expect(difficultyGrowthFactor(3)).toBeGreaterThan(difficultyGrowthFactor(MAX_DIFFICULTY));
  });
});

describe("performanceAdjustment — current mastery + recent recall performance (spec §5)", () => {
  it("defaults to a neutral (1.0-ish) adjustment when neither signal is known", () => {
    expect(performanceAdjustment(null, null)).toBeCloseTo(1, 5);
  });

  it("higher mastery and stronger recent performance push the adjustment above neutral", () => {
    expect(performanceAdjustment(0.95, 0.95)).toBeGreaterThan(1);
  });

  it("lower mastery and weaker recent performance push the adjustment below neutral", () => {
    expect(performanceAdjustment(0.05, 0.05)).toBeLessThan(1);
  });

  it("stays within its configured bounds for extreme inputs", () => {
    expect(performanceAdjustment(1, 1)).toBeLessThanOrEqual(1.25);
    expect(performanceAdjustment(0, 0)).toBeGreaterThanOrEqual(0.75);
  });

  it("is only a supporting signal: a GOOD rating still outscores AGAIN's interval regardless of mastery", () => {
    const item = newItem({ status: "REVIEW", stability: 5, interval: 5, repetitionCount: 2 });
    const again = scheduleReview({ reviewItem: item, outcome: "AGAIN", studentMastery: 1, recentPerformance: 1, now: NOW });
    const good = scheduleReview({ reviewItem: item, outcome: "GOOD", studentMastery: 0, recentPerformance: 0, now: NOW });
    expect(good.interval).toBeGreaterThan(again.interval);
  });
});

describe("scheduleReview — nextReviewAt", () => {
  it("is always in the future relative to `now`, by exactly `interval` days", () => {
    const result = scheduleReview({ reviewItem: newItem(), outcome: "GOOD", now: NOW });
    const diffDays = (result.nextReviewAt.getTime() - NOW.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeCloseTo(result.interval, 5);
  });
});
