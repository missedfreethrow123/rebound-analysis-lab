import { describe, expect, it } from "vitest";
import {
  GRID_NX,
  GRID_NY,
  GRID_CELL_SIZE_M,
  worldToCell,
  cellCenterWorld,
  cellIndex,
  createEmptyGrid,
  recordSample,
  mergeGrid,
  emptyTotals,
  addTotals,
  computeStats,
} from "./sweepGrid";
import {
  expandRange,
  rangeStepCount,
  totalShotCount,
  splitEvenly,
  defaultSweepConfig,
  DEFAULT_SWEEP_RANGES,
  sweepCacheKey,
  PHYSICS_VERSION,
} from "./sweepConfig";
import { BASELINE_TO_RIM_M, COURT_WIDTH_M } from "./constants";

describe("sweepConfig", () => {
  it("expands the default ranges to the step counts HEATMAP_SPEC.md expects", () => {
    expect(rangeStepCount(DEFAULT_SWEEP_RANGES.angle)).toBe(61); // 35..65 step 0.5
    expect(rangeStepCount(DEFAULT_SWEEP_RANGES.aim)).toBe(49); // -12..12 step 0.5
    expect(rangeStepCount(DEFAULT_SWEEP_RANGES.speed)).toBe(71); // 5.5..9.0 step 0.05

    const config = defaultSweepConfig(190);
    expect(totalShotCount(config)).toBe(61 * 49 * 71);
    expect(totalShotCount(config)).toBeCloseTo(212000, -3); // "about 212,000 shots" per spec
  });

  it("expandRange hits both endpoints exactly with no float drift", () => {
    const values = expandRange(DEFAULT_SWEEP_RANGES.angle);
    expect(values[0]).toBe(35);
    expect(values[values.length - 1]).toBe(65);
    expect(values.length).toBe(61);
    // no accumulated drift: every value should be an exact multiple-of-0.5 offset from 35
    for (const v of values) {
      expect(Math.round((v - 35) * 2)).toBeCloseTo((v - 35) * 2, 9);
    }
  });

  it("splitEvenly covers every value exactly once, split as evenly as possible", () => {
    const values = expandRange(DEFAULT_SWEEP_RANGES.angle); // 61 values
    const slices = splitEvenly(values, 8);
    expect(slices.length).toBe(8);
    const rejoined = slices.flat();
    expect(rejoined).toEqual(values); // order-preserving, no gaps, no duplicates
    const sizes = slices.map((s) => s.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1); // "as evenly as possible"
  });

  it("splitEvenly never produces more slices than values (fewer workers used, not empty duplicates)", () => {
    const slices = splitEvenly([1, 2, 3], 8);
    expect(slices.length).toBe(3);
    expect(slices.flat()).toEqual([1, 2, 3]);
  });

  it("sweepCacheKey is stable for identical configs and changes with any field, including PHYSICS_VERSION", () => {
    const a = defaultSweepConfig(190);
    const b = defaultSweepConfig(190);
    expect(sweepCacheKey(a)).toBe(sweepCacheKey(b));

    const differentHeight = { ...a, heightCm: 200 };
    const differentSpin = { ...a, spinRps: 3 };
    const differentAngle = { ...a, angle: { ...a.angle, step: 1 } };
    const differentRecord = { ...a, record: "catchPoint" as const };
    const differentExclude = { ...a, excludeMade: false };
    const keys = [a, differentHeight, differentSpin, differentAngle, differentRecord, differentExclude].map(sweepCacheKey);
    expect(new Set(keys).size).toBe(keys.length); // every variant produces a distinct key

    // A cache keyed without PHYSICS_VERSION would silently serve a stale map
    // after a core.ts physics change -- the key must embed it directly.
    expect(sweepCacheKey(a)).toContain(`v${PHYSICS_VERSION}`);
  });
});

describe("sweepGrid coordinate mapping", () => {
  it("maps the rim's floor projection and the baseline centre to the expected cells", () => {
    // Rim at world (0,0): grid y should be at the baseline (iy=0..1 band),
    // since BASELINE_TO_RIM_M puts the baseline *in front of* the rim.
    const rimCell = worldToCell(0, 0);
    expect(rimCell).not.toBeNull();
    // Baseline centre (0, BASELINE_TO_RIM_M) should land in the iy=0 row (grid origin).
    const baselineCell = worldToCell(0, BASELINE_TO_RIM_M - 0.001);
    expect(baselineCell!.iy).toBe(0);
  });

  it("round-trips: a cell's own center maps back to the same cell", () => {
    for (const [ix, iy] of [
      [0, 0],
      [GRID_NX - 1, 0],
      [0, GRID_NY - 1],
      [GRID_NX - 1, GRID_NY - 1],
      [75, 70],
    ]) {
      const { x, z } = cellCenterWorld(ix, iy);
      const cell = worldToCell(x, z);
      expect(cell).toEqual({ ix, iy });
    }
  });

  it("returns null outside the grid", () => {
    expect(worldToCell(-COURT_WIDTH_M, 0)).toBeNull(); // way outside sidelines
    expect(worldToCell(0, 100)).toBeNull(); // way past the baseline
    expect(worldToCell(0, -100)).toBeNull(); // way beyond half-court
  });

  it("cellIndex matches the iy*NX+ix convention the spec requires", () => {
    expect(cellIndex(0, 0)).toBe(0);
    expect(cellIndex(1, 0)).toBe(1);
    expect(cellIndex(0, 1)).toBe(GRID_NX);
  });
});

describe("sweepGrid recording and merging", () => {
  it("counts every sample but only records params for the first one per cell", () => {
    const grid = createEmptyGrid();
    const everSet = new Uint8Array(GRID_NX * GRID_NY);
    const { x, z } = cellCenterWorld(10, 10);

    recordSample(grid, everSet, x, z, 50, 0, 7.2, 2.5, false);
    recordSample(grid, everSet, x, z, 55, 1, 7.5, 2.5, false); // second hit, same cell

    const idx = cellIndex(10, 10);
    expect(grid.counts[idx]).toBe(2);
    expect(grid.params[idx * 4]).toBe(50); // first sample's angle wins, not overwritten by the second
  });

  it("samples outside the grid are silently dropped", () => {
    const grid = createEmptyGrid();
    const everSet = new Uint8Array(GRID_NX * GRID_NY);
    const recorded = recordSample(grid, everSet, 1000, 1000, 50, 0, 7.2, 2.5, false);
    expect(recorded).toBe(false);
    expect(grid.counts.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("tracks rim-contact as metadata alongside counts, not as a filter", () => {
    const grid = createEmptyGrid();
    const everSet = new Uint8Array(GRID_NX * GRID_NY);
    const { x, z } = cellCenterWorld(30, 30);
    const idx = cellIndex(30, 30);

    recordSample(grid, everSet, x, z, 50, 0, 7.2, 2.5, true); // touched the rim
    recordSample(grid, everSet, x, z, 45, 0, 6.5, 2.5, false); // airball landing in the same cell
    recordSample(grid, everSet, x, z, 55, 0, 8.0, 2.5, false); // backboard-only landing in the same cell

    expect(grid.counts[idx]).toBe(3); // every miss is counted
    expect(grid.rimTouchCounts[idx]).toBe(1); // only the rim-touching one flagged
  });

  it("mergeGrid sums counts, rimTouchCounts, and preserves first-set params across deltas", () => {
    const target = createEmptyGrid();
    const targetEverSet = new Uint8Array(GRID_NX * GRID_NY);
    const { x, z } = cellCenterWorld(20, 20);
    const idx = cellIndex(20, 20);

    const delta1 = createEmptyGrid();
    const everSet1 = new Uint8Array(GRID_NX * GRID_NY);
    recordSample(delta1, everSet1, x, z, 40, -1, 6.0, 2.5, true);
    mergeGrid(target, targetEverSet, delta1);

    const delta2 = createEmptyGrid();
    const everSet2 = new Uint8Array(GRID_NX * GRID_NY);
    recordSample(delta2, everSet2, x, z, 60, 1, 8.0, 2.5, false); // a later worker/tick hitting the same cell
    mergeGrid(target, targetEverSet, delta2);

    expect(target.counts[idx]).toBe(2);
    expect(target.rimTouchCounts[idx]).toBe(1);
    expect(target.params[idx * 4]).toBe(40); // first-merged delta's params win
  });
});

describe("computeStats", () => {
  it("finds the hottest cell and computes side/rim-touch fractions", () => {
    const grid = createEmptyGrid();
    const everSet = new Uint8Array(GRID_NX * GRID_NY);
    const nearCell = cellCenterWorld(75, 50); // some cell with z < 0 (shooter's side)
    const farCell = cellCenterWorld(75, 5); // some cell with z >= 0 (beyond the rim)
    expect(nearCell.z).toBeLessThan(0);
    expect(farCell.z).toBeGreaterThanOrEqual(0);

    for (let i = 0; i < 5; i++) recordSample(grid, everSet, nearCell.x, nearCell.z, 50, 0, 7.2, 2.5, false);
    for (let i = 0; i < 2; i++) recordSample(grid, everSet, farCell.x, farCell.z, 50, 0, 7.2, 2.5, false);

    const totals = addTotals(emptyTotals(), {
      totalShots: 10,
      excludedMadeCount: 3,
      rimTouchCount: 6,
      recordedCount: 7,
      nearSideCount: 5,
      farSideCount: 2,
    });
    const stats = computeStats(grid, totals);

    expect(stats.hottestCell).not.toBeNull();
    expect(stats.hottestCell!.count).toBe(5);
    expect(stats.hottestCell!.x).toBeCloseTo(nearCell.x, 6);
    expect(stats.rimTouchPercent).toBeCloseTo(60, 6);
    expect(stats.nearSideFraction).toBeCloseTo(5 / 7, 6);
    expect(stats.farSideFraction).toBeCloseTo(2 / 7, 6);
  });

  it("radius50PercentM is the smallest rim-centred radius covering half the recorded rebounds", () => {
    const grid = createEmptyGrid();
    const everSet = new Uint8Array(GRID_NX * GRID_NY);
    // Two cells: one close to the rim (small radius) with most of the mass,
    // one far away with a minority — the 50% radius should land at the near cell.
    const near = cellCenterWorld(76, 5); // close to x=0, z small (near the rim)
    const far = cellCenterWorld(140, 5); // far from the rim in x
    for (let i = 0; i < 9; i++) recordSample(grid, everSet, near.x, near.z, 50, 0, 7.2, 2.5, false);
    for (let i = 0; i < 1; i++) recordSample(grid, everSet, far.x, far.z, 50, 0, 7.2, 2.5, false);

    const totals = { ...emptyTotals(), totalShots: 10, recordedCount: 10 };
    const stats = computeStats(grid, totals);
    const nearDist = Math.hypot(near.x, near.z);
    const farDist = Math.hypot(far.x, far.z);
    expect(stats.radius50PercentM).toBeCloseTo(nearDist, 6);
    expect(stats.radius50PercentM).toBeLessThan(farDist);
  });

  it("returns nulls/zeros gracefully for an empty grid", () => {
    const grid = createEmptyGrid();
    const stats = computeStats(grid, emptyTotals());
    expect(stats.hottestCell).toBeNull();
    expect(stats.radius50PercentM).toBeNull();
    expect(stats.nearSideFraction).toBeNull();
    expect(stats.farSideFraction).toBeNull();
    expect(stats.rimTouchPercent).toBe(0);
  });
});
