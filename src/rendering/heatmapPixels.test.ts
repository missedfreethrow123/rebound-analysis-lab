import { describe, expect, it } from "vitest";
import { computeHeatmapPixels } from "./heatmapPixels";
import { createEmptyGrid, recordSample, cellCenterWorld, cellIndex, GRID_NX, GRID_NY } from "../physics/sweepGrid";

describe("computeHeatmapPixels", () => {
  it("returns fully transparent pixels for an empty grid", () => {
    const grid = createEmptyGrid();
    const pixels = computeHeatmapPixels(grid, { blurPasses: 0 });
    expect(pixels.length).toBe(GRID_NX * GRID_NY * 4);
    for (let i = 3; i < pixels.length; i += 4) expect(pixels[i]).toBe(0); // every alpha channel
  });

  it("the hottest cell is darkest/most opaque, a cold cell is lighter/fainter", () => {
    const grid = createEmptyGrid();
    const everSet = new Uint8Array(GRID_NX * GRID_NY);
    const hot = cellCenterWorld(75, 30);
    const cold = cellCenterWorld(90, 60);
    for (let i = 0; i < 50; i++) recordSample(grid, everSet, hot.x, hot.z, 50, 0, 7.2, 2.5, false);
    for (let i = 0; i < 1; i++) recordSample(grid, everSet, cold.x, cold.z, 50, 0, 7.2, 2.5, false);

    const pixels = computeHeatmapPixels(grid, { blurPasses: 0 });
    const hotIdx = cellIndex(75, 30) * 4;
    const coldIdx = cellIndex(90, 60) * 4;

    // both visible (nonzero alpha)
    expect(pixels[hotIdx + 3]).toBeGreaterThan(0);
    expect(pixels[coldIdx + 3]).toBeGreaterThan(0);
    // hottest cell is more opaque
    expect(pixels[hotIdx + 3]).toBeGreaterThan(pixels[coldIdx + 3]);
    // single-hue ramp: hotter cell is darker (lower RGB sum), not a different hue
    const hotSum = pixels[hotIdx] + pixels[hotIdx + 1] + pixels[hotIdx + 2];
    const coldSum = pixels[coldIdx] + pixels[coldIdx + 1] + pixels[coldIdx + 2];
    expect(hotSum).toBeLessThan(coldSum);
  });

  it("a cell one step below the max is not visually indistinguishable from empty (sqrt transform)", () => {
    // This is the exact failure mode HEATMAP_SPEC.md calls out: on a linear
    // scale, one very hot cell washes out everything else to near-invisible.
    const grid = createEmptyGrid();
    const everSet = new Uint8Array(GRID_NX * GRID_NY);
    const veryHot = cellCenterWorld(75, 20);
    const modest = cellCenterWorld(80, 40);
    for (let i = 0; i < 10000; i++) recordSample(grid, everSet, veryHot.x, veryHot.z, 50, 0, 7.2, 2.5, false);
    for (let i = 0; i < 100; i++) recordSample(grid, everSet, modest.x, modest.z, 50, 0, 7.2, 2.5, false);
    // 100/10000 = 1% linearly, but sqrt(0.01) = 10% -- should be clearly nonzero.

    const pixels = computeHeatmapPixels(grid, { blurPasses: 0 });
    const modestAlpha = pixels[cellIndex(80, 40) * 4 + 3];
    expect(modestAlpha).toBeGreaterThan(20); // clearly visible, not near-zero
  });

  it("blurring spreads density into immediately adjacent empty cells", () => {
    const grid = createEmptyGrid();
    const everSet = new Uint8Array(GRID_NX * GRID_NY);
    const center = cellCenterWorld(75, 30);
    for (let i = 0; i < 20; i++) recordSample(grid, everSet, center.x, center.z, 50, 0, 7.2, 2.5, false);

    const unblurred = computeHeatmapPixels(grid, { blurPasses: 0 });
    const blurred = computeHeatmapPixels(grid, { blurPasses: 1 });
    const neighborIdx = cellIndex(76, 30) * 4; // directly adjacent, was empty

    expect(unblurred[neighborIdx + 3]).toBe(0); // no blur: still fully transparent
    expect(blurred[neighborIdx + 3]).toBeGreaterThan(0); // blurred: some spillover
  });

  it("the rimTouch layer renders from rimTouchCounts, independent of total counts", () => {
    const grid = createEmptyGrid();
    const everSet = new Uint8Array(GRID_NX * GRID_NY);
    const cell = cellCenterWorld(75, 30);
    // 10 misses land here, only 2 touched the rim.
    for (let i = 0; i < 2; i++) recordSample(grid, everSet, cell.x, cell.z, 50, 0, 7.2, 2.5, true);
    for (let i = 0; i < 8; i++) recordSample(grid, everSet, cell.x, cell.z, 50, 0, 7.2, 2.5, false);

    const allLayer = computeHeatmapPixels(grid, { layer: "all", blurPasses: 0 });
    const rimLayer = computeHeatmapPixels(grid, { layer: "rimTouch", blurPasses: 0 });
    const idx = cellIndex(75, 30) * 4;

    // Both layers show data at this cell (counts=10, rimTouchCounts=2), but
    // since each layer normalizes against its own max and this is the only
    // populated cell in both, they render identically opaque here — the
    // real distinguishing test is that a cell with count but zero rim
    // touches disappears entirely in the rimTouch layer.
    expect(allLayer[idx + 3]).toBeGreaterThan(0);
    expect(rimLayer[idx + 3]).toBeGreaterThan(0);

    const rimOnlyGrid = createEmptyGrid();
    const rimOnlyEverSet = new Uint8Array(GRID_NX * GRID_NY);
    const other = cellCenterWorld(90, 60);
    recordSample(rimOnlyGrid, rimOnlyEverSet, other.x, other.z, 50, 0, 7.2, 2.5, false); // never touches rim
    const rimLayerOther = computeHeatmapPixels(rimOnlyGrid, { layer: "rimTouch", blurPasses: 0 });
    expect(rimLayerOther[cellIndex(90, 60) * 4 + 3]).toBe(0); // invisible in the rim-touch layer
  });

  it("uses a single hue across the whole ramp (no rainbow)", () => {
    const grid = createEmptyGrid();
    const everSet = new Uint8Array(GRID_NX * GRID_NY);
    const cells = [
      [70, 10, 1],
      [75, 30, 25],
      [80, 50, 100],
    ] as const;
    for (const [ix, iy, n] of cells) {
      const c = cellCenterWorld(ix, iy);
      for (let i = 0; i < n; i++) recordSample(grid, everSet, c.x, c.z, 50, 0, 7.2, 2.5, false);
    }
    const pixels = computeHeatmapPixels(grid, { blurPasses: 0 });

    const hueOf = (r: number, g: number, b: number) => {
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max === min) return 0;
      const d = max - min;
      let h: number;
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      return h < 0 ? h + 360 : h;
    };

    for (const [ix, iy] of cells) {
      const o = cellIndex(ix, iy) * 4;
      const hue = hueOf(pixels[o], pixels[o + 1], pixels[o + 2]);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(40); // stays in the warm orange-red band
    }
  });
});
