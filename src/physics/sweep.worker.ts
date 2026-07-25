// Sweep worker: owns one contiguous slice of the angle range, sweeps the full
// aim x speed grid within it, and posts progressive count/param deltas back
// to the main thread. Imports simulate() directly — this is the only place
// besides the single-shot UI that calls it, so the sweep and the single shot
// can never run different physics (see HEATMAP_SPEC.md's "Do not create a
// second copy of the physics").
//
// Typing note: this file is compiled as part of the same TS program as the
// rest of src, which targets the DOM lib (for the main app) rather than the
// "webworker" lib (the two are not meant to coexist in one tsconfig — DOM and
// WebWorker both declare an incompatible global `self`). Since this file is a
// module (has top-level imports), a local `declare const self` below shadows
// the ambient DOM `self` only within this file, without touching the global
// scope or requiring a second tsconfig.
declare const self: {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

import { simulate } from "./core";
import { createEmptyGrid, recordSample, emptyTotals, GRID_NX, GRID_NY, type SweepGrid, type SweepTotals } from "./sweepGrid";
import { expandRange, type RangeConfig } from "./sweepConfig";

export interface SweepWorkerStartMessage {
  type: "start";
  workerId: number;
  angleValues: number[]; // this worker's slice of the full angle range
  aimRange: RangeConfig;
  speedRange: RangeConfig;
  heightCm: number;
  spinRps: number;
  record: "catchPoint" | "floorPoint";
  excludeMade: boolean;
}

export interface SweepWorkerCancelMessage {
  type: "cancel";
}

export type SweepWorkerInboundMessage = SweepWorkerStartMessage | SweepWorkerCancelMessage;

export interface SweepWorkerOutboundMessage {
  type: "progress" | "done";
  workerId: number;
  grid: SweepGrid;
  totals: SweepTotals;
  shotsThisFlush: number;
}

const PROGRESS_INTERVAL_MS = 200;

let cancelled = false;

self.onmessage = (event: MessageEvent) => {
  const msg = event.data as SweepWorkerInboundMessage;
  if (msg.type === "cancel") {
    cancelled = true;
    return;
  }
  if (msg.type === "start") {
    cancelled = false;
    runSweep(msg);
  }
};

function runSweep(msg: SweepWorkerStartMessage): void {
  const aimValues = expandRange(msg.aimRange);
  const speedValues = expandRange(msg.speedRange);

  let grid = createEmptyGrid();
  let everSet = new Uint8Array(GRID_NX * GRID_NY);
  let totals = emptyTotals();
  let shotsThisFlush = 0;
  let lastFlush = performance.now();

  const flush = (done: boolean) => {
    const outGrid = grid;
    const outTotals = totals;
    const outShots = shotsThisFlush;
    const message: SweepWorkerOutboundMessage = {
      type: done ? "done" : "progress",
      workerId: msg.workerId,
      grid: outGrid,
      totals: outTotals,
      shotsThisFlush: outShots,
    };
    self.postMessage(message, [outGrid.counts.buffer, outGrid.rimTouchCounts.buffer, outGrid.params.buffer]);
    // The transferred buffers are now neutered on this side — allocate fresh
    // ones to keep accumulating. `everSet` is deliberately NOT reset: it's
    // this worker's memory of which cells it has already recorded a
    // representative sample for, which must persist across flushes so
    // "first sample per cell" stays correct for this worker's whole run.
    grid = createEmptyGrid();
    totals = emptyTotals();
    shotsThisFlush = 0;
  };

  outer: for (const angleDeg of msg.angleValues) {
    for (const aimDeg of aimValues) {
      for (const speed of speedValues) {
        if (cancelled) break outer;

        const result = simulate(
          { heightCm: msg.heightCm, angleDeg, aimDeg, speed, spinRps: msg.spinRps },
          { recordTrajectory: false },
        );

        totals.totalShots++;
        shotsThisFlush++;
        const isMade = result.outcome === "made";
        if (isMade) totals.excludedMadeCount++;
        if (result.rimContacts > 0) totals.rimTouchCount++;

        if (!(msg.excludeMade && isMade)) {
          const point = msg.record === "catchPoint" ? result.catchPoint : result.floorPoint;
          if (point) {
            recordSample(grid, everSet, point[0], point[1], angleDeg, aimDeg, speed, msg.spinRps, result.rimContacts > 0);
            totals.recordedCount++;
            if (point[1] < 0) totals.nearSideCount++;
            else totals.farSideCount++;
          }
        }

        const now = performance.now();
        if (now - lastFlush >= PROGRESS_INTERVAL_MS) {
          flush(false);
          lastFlush = now;
        }
      }
    }
  }

  flush(true);
}
