// Pure grid math and statistics for the rebound heat map — no Worker, no
// postMessage, no simulate() calls. sweep.worker.ts calls into this to
// record samples; sweep.ts (main thread) calls into it to merge worker
// deltas and compute the summary statistics. Kept separate and pure so both
// sides can be unit tested directly instead of only through an actual Worker.

import { BASELINE_TO_RIM_M, COURT_WIDTH_M } from "./constants";

export const GRID_CELL_SIZE_M = 0.1;
export const GRID_NX = Math.round(COURT_WIDTH_M / GRID_CELL_SIZE_M); // 150: x in [-7.5, 7.5]
export const GRID_NY = Math.round(14.0 / GRID_CELL_SIZE_M); // 140: baseline (0) to half-court (14)

const SIDELINE_HALF_M = COURT_WIDTH_M / 2;
const BASELINE_Z_M = BASELINE_TO_RIM_M;

export interface SweepGrid {
  nx: number;
  ny: number;
  cellSizeM: number;
  counts: Uint32Array; // NX*NY, index iy*NX+ix — every recorded miss, regardless of whether it touched the rim
  // Of counts[i], how many also had rimContacts > 0. Metadata, not a filter —
  // the default map shows every recorded miss (counts); this is what a
  // toggleable "rim contact" layer renders from in Phase 4, e.g. as
  // rimTouchCounts[i]/counts[i] per cell, without needing a second sweep.
  rimTouchCounts: Uint32Array;
  params: Float32Array; // NX*NY*4: [angleDeg, aimDeg, speed, spinRps] for the first recorded sample in that cell, NaN if never set
}

export function createEmptyGrid(): SweepGrid {
  const params = new Float32Array(GRID_NX * GRID_NY * 4);
  params.fill(NaN);
  return {
    nx: GRID_NX,
    ny: GRID_NY,
    cellSizeM: GRID_CELL_SIZE_M,
    counts: new Uint32Array(GRID_NX * GRID_NY),
    rimTouchCounts: new Uint32Array(GRID_NX * GRID_NY),
    params,
  };
}

// World (x, z) metres -> grid cell indices, or null if outside the grid.
// Origin (ix=0, iy=0) is the baseline at the court's centre-x, per
// HEATMAP_SPEC.md's grid definition: x spans the full court width, y (here,
// world z — court depth) spans baseline (0) to half-court line (14m).
export function worldToCell(x: number, z: number): { ix: number; iy: number } | null {
  const ix = Math.floor((x + SIDELINE_HALF_M) / GRID_CELL_SIZE_M);
  const iy = Math.floor((BASELINE_Z_M - z) / GRID_CELL_SIZE_M);
  if (ix < 0 || ix >= GRID_NX || iy < 0 || iy >= GRID_NY) return null;
  return { ix, iy };
}

export function cellCenterWorld(ix: number, iy: number): { x: number; z: number } {
  return {
    x: -SIDELINE_HALF_M + (ix + 0.5) * GRID_CELL_SIZE_M,
    z: BASELINE_Z_M - (iy + 0.5) * GRID_CELL_SIZE_M,
  };
}

export function cellIndex(ix: number, iy: number): number {
  return iy * GRID_NX + ix;
}

// Records one rebound sample into `grid`. `everSet` tracks, per cell, whether
// a representative-params sample has already been stored — separate from
// `grid.counts` because counts should keep incrementing on every hit, while
// params should only be written once (the *first* sample to land there).
export function recordSample(
  grid: SweepGrid,
  everSet: Uint8Array,
  x: number,
  z: number,
  angleDeg: number,
  aimDeg: number,
  speed: number,
  spinRps: number,
  touchedRim: boolean,
): boolean {
  const cell = worldToCell(x, z);
  if (!cell) return false;
  const idx = cellIndex(cell.ix, cell.iy);
  grid.counts[idx]++;
  if (touchedRim) grid.rimTouchCounts[idx]++;
  if (!everSet[idx]) {
    everSet[idx] = 1;
    const o = idx * 4;
    grid.params[o] = angleDeg;
    grid.params[o + 1] = aimDeg;
    grid.params[o + 2] = speed;
    grid.params[o + 3] = spinRps;
  }
  return true;
}

// Merges a worker's delta grid into the main thread's running total. `delta`
// is consumed (its buffers may be the ones just transferred over
// postMessage) — `target`/`targetEverSet` accumulate across every worker and
// every progress tick for the sweep's lifetime.
export function mergeGrid(target: SweepGrid, targetEverSet: Uint8Array, delta: SweepGrid): void {
  for (let i = 0; i < target.counts.length; i++) {
    target.counts[i] += delta.counts[i];
    target.rimTouchCounts[i] += delta.rimTouchCounts[i];
    if (!targetEverSet[i]) {
      const o = i * 4;
      if (!Number.isNaN(delta.params[o])) {
        targetEverSet[i] = 1;
        target.params[o] = delta.params[o];
        target.params[o + 1] = delta.params[o + 1];
        target.params[o + 2] = delta.params[o + 2];
        target.params[o + 3] = delta.params[o + 3];
      }
    }
  }
}

export interface SweepTotals {
  totalShots: number;
  excludedMadeCount: number;
  rimTouchCount: number; // shots with rimContacts > 0, regardless of outcome or excludeMade
  recordedCount: number; // shots actually added to the grid (excludes made-when-excluded and null record points)
  nearSideCount: number; // recorded point on the shooter's side of the rim (z < 0)
  farSideCount: number; // recorded point beyond the rim (z >= 0)
}

export function emptyTotals(): SweepTotals {
  return { totalShots: 0, excludedMadeCount: 0, rimTouchCount: 0, recordedCount: 0, nearSideCount: 0, farSideCount: 0 };
}

export function addTotals(a: SweepTotals, b: SweepTotals): SweepTotals {
  return {
    totalShots: a.totalShots + b.totalShots,
    excludedMadeCount: a.excludedMadeCount + b.excludedMadeCount,
    rimTouchCount: a.rimTouchCount + b.rimTouchCount,
    recordedCount: a.recordedCount + b.recordedCount,
    nearSideCount: a.nearSideCount + b.nearSideCount,
    farSideCount: a.farSideCount + b.farSideCount,
  };
}

export interface SweepStats {
  totalShots: number;
  excludedMadeCount: number;
  rimTouchPercent: number; // 0-100, of totalShots
  hottestCell: { ix: number; iy: number; x: number; z: number; count: number } | null;
  radius50PercentM: number | null; // smallest circle centred on the rim containing >=50% of recorded rebounds
  nearSideFraction: number | null; // 0-1, of recordedCount
  farSideFraction: number | null; // 0-1, of recordedCount
}

export function computeStats(grid: SweepGrid, totals: SweepTotals): SweepStats {
  let hottestIdx = -1;
  let hottestCount = 0;
  for (let i = 0; i < grid.counts.length; i++) {
    if (grid.counts[i] > hottestCount) {
      hottestCount = grid.counts[i];
      hottestIdx = i;
    }
  }
  let hottestCell: SweepStats["hottestCell"] = null;
  if (hottestIdx >= 0) {
    const ix = hottestIdx % grid.nx;
    const iy = Math.floor(hottestIdx / grid.nx);
    const { x, z } = cellCenterWorld(ix, iy);
    hottestCell = { ix, iy, x, z, count: hottestCount };
  }

  // Radius of the smallest rim-centred circle containing >=50% of recorded
  // rebounds: sort every non-empty cell by distance from the rim (0,0) and
  // accumulate counts until crossing half of the recorded total.
  let radius50PercentM: number | null = null;
  if (totals.recordedCount > 0) {
    const entries: { dist: number; count: number }[] = [];
    for (let i = 0; i < grid.counts.length; i++) {
      const c = grid.counts[i];
      if (c === 0) continue;
      const ix = i % grid.nx;
      const iy = Math.floor(i / grid.nx);
      const { x, z } = cellCenterWorld(ix, iy);
      entries.push({ dist: Math.hypot(x, z), count: c });
    }
    entries.sort((a, b) => a.dist - b.dist);
    const half = totals.recordedCount / 2;
    let running = 0;
    for (const e of entries) {
      running += e.count;
      if (running >= half) {
        radius50PercentM = e.dist;
        break;
      }
    }
    if (radius50PercentM === null && entries.length > 0) {
      radius50PercentM = entries[entries.length - 1].dist;
    }
  }

  return {
    totalShots: totals.totalShots,
    excludedMadeCount: totals.excludedMadeCount,
    rimTouchPercent: totals.totalShots > 0 ? (totals.rimTouchCount / totals.totalShots) * 100 : 0,
    hottestCell,
    radius50PercentM,
    nearSideFraction: totals.recordedCount > 0 ? totals.nearSideCount / totals.recordedCount : null,
    farSideFraction: totals.recordedCount > 0 ? totals.farSideCount / totals.recordedCount : null,
  };
}
