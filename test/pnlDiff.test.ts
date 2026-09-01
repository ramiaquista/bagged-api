import { describe, expect, it } from "vitest";
import { computePnlChangePct, hasCrossedThreshold } from "../src/worker/pnlDiff.js";

describe("worker/pnlDiff", () => {
  describe("computePnlChangePct", () => {
    it("returns null when there's no previous snapshot", () => {
      expect(computePnlChangePct(null, 500)).toBeNull();
    });

    it("returns null when the previous total was exactly 0 (undefined percentage)", () => {
      expect(computePnlChangePct(0, 100)).toBeNull();
      expect(computePnlChangePct(0, 0)).toBeNull();
    });

    it("computes a positive percentage change", () => {
      expect(computePnlChangePct(100, 150)).toBeCloseTo(50);
    });

    it("computes a negative percentage change", () => {
      expect(computePnlChangePct(200, 100)).toBeCloseTo(-50);
    });

    it("uses the absolute value of the previous total as the denominator", () => {
      // Going from a $100 loss to a $50 loss is an improvement, not a -150% change.
      expect(computePnlChangePct(-100, -50)).toBeCloseTo(50);
      // Going from a $100 loss to a $150 loss is a further decline.
      expect(computePnlChangePct(-100, -150)).toBeCloseTo(-50);
    });
  });

  describe("hasCrossedThreshold", () => {
    it("never fires on the first-ever check (no previous snapshot)", () => {
      expect(hasCrossedThreshold(null, 1_000_000, 1)).toBe(false);
    });

    it("fires when the change meets the threshold exactly", () => {
      expect(hasCrossedThreshold(100, 110, 10)).toBe(true);
    });

    it("fires when the change exceeds the threshold", () => {
      expect(hasCrossedThreshold(100, 200, 10)).toBe(true);
    });

    it("does not fire when the change is below the threshold", () => {
      expect(hasCrossedThreshold(100, 105, 10)).toBe(false);
    });

    it("fires on a swing in either direction", () => {
      expect(hasCrossedThreshold(100, 50, 10)).toBe(true);
    });

    it("fires on any nonzero movement away from a zero baseline", () => {
      expect(hasCrossedThreshold(0, 0.01, 10)).toBe(true);
    });

    it("does not fire when a zero baseline stays at zero", () => {
      expect(hasCrossedThreshold(0, 0, 10)).toBe(false);
    });
  });
});
