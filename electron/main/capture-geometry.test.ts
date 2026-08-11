import { describe, expect, it } from "vitest";
import { calculateCaptureCrop } from "./capture-geometry";

describe("calculateCaptureCrop", () => {
  it("uses the actual thumbnail scale instead of assuming a 1:1 Windows DPI", () => {
    expect(
      calculateCaptureCrop(
        { x: 0, y: 0, width: 1_920, height: 1_080 },
        { width: 1_440, height: 810 },
        { x: 100, y: 50, width: 800, height: 600 },
      ),
    ).toEqual({ x: 75, y: 38, width: 600, height: 450 });
  });

  it("handles negative coordinates and non-uniform display scaling", () => {
    expect(
      calculateCaptureCrop(
        { x: -1_920, y: -100, width: 1_920, height: 1_080 },
        { width: 2_560, height: 1_200 },
        { x: -1_800, y: 20, width: 900, height: 600 },
      ),
    ).toEqual({ x: 160, y: 133, width: 1_200, height: 667 });
  });

  it("crops a partially visible window and rejects a stale off-screen one", () => {
    expect(
      calculateCaptureCrop(
        { x: 0, y: 0, width: 1_000, height: 800 },
        { width: 1_000, height: 800 },
        { x: -100, y: 100, width: 400, height: 300 },
      ),
    ).toEqual({ x: 0, y: 100, width: 300, height: 300 });
    expect(
      calculateCaptureCrop(
        { x: 0, y: 0, width: 1_000, height: 800 },
        { width: 1_000, height: 800 },
        { x: 1_200, y: 100, width: 300, height: 300 },
      ),
    ).toBeUndefined();
  });
});
