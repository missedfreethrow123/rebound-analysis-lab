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
import { isInboundsLanding } from "../rebound/contest";

export interface SweepWorkerStartMessage {
  type: "start";
  workerId: number;
  angleValues: number[]; // this worker's slice of the full angle range
  aimRange: RangeConfig;
  speedRange: RangeConfig;
  heightCm: number;
  spinRps: number;
  record: "catchPoint" | "floorPoint"; // no longer read by the worker — kept so SweepConfig/sweepCacheKey still compile (sweepGrid.test.ts keys off it)
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
  // Flat [x,z,x,z,...] 2.44 m contest points for the scatter-dot renderer:
  // rim-touching misses whose contest point (result.contestPoint — where the
  // ball first comes down through REBOUND_CATCH_HEIGHT_M after the first rim
  // contact) lands inside the court per isInboundsLanding. This is now
  // exactly the same population and the same points as contestPoints below
  // — see the recording gate below.
  points: Float32Array;
  // Flat [x,z,x,z,...] 2.44 m contest points that QUALIFY for the rebound
  // contest (touched rim AND contest point landed inbounds per
  // src/rebound/contest.ts's isInboundsLanding). Identical set to `points`
  // above. Deliberately NOT pre-tallied into a win/loss count here: the
  // actual contestLanding() call (and therefore who wins each point) happens
  // on the main thread instead, keeping the pairing/eligibility logic in one
  // place rather than duplicated into the worker.
  contestPoints: Float32Array;
  // One entry per contestPoints point (not per coordinate) — that shot's own
  // result.firstRimContactTime, i.e. contest.ts's releaseToRimS. The FIBA
  // lane-player start time (ball release, not t_rim) varies with how long
  // each shot's flight to the rim took, so the main thread's contestLanding()
  // call needs this alongside each point, not a single shared constant.
  contestFlightTimes: Float32Array;
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
  let scatterPoints: number[] = [];
  let contestPoints: number[] = [];
  let contestFlightTimes: number[] = [];
  let lastFlush = performance.now();

  const flush = (done: boolean) => {
    const outGrid = grid;
    const outTotals = totals;
    const outShots = shotsThisFlush;
    const outPoints = Float32Array.from(scatterPoints);
    const outContestPoints = Float32Array.from(contestPoints);
    const outContestFlightTimes = Float32Array.from(contestFlightTimes);
    const message: SweepWorkerOutboundMessage = {
      type: done ? "done" : "progress",
      workerId: msg.workerId,
      grid: outGrid,
      totals: outTotals,
      shotsThisFlush: outShots,
      points: outPoints,
      contestPoints: outContestPoints,
      contestFlightTimes: outContestFlightTimes,
    };
    self.postMessage(
      message,
      [
        outGrid.counts.buffer,
        outGrid.rimTouchCounts.buffer,
        outGrid.params.buffer,
        outPoints.buffer,
        outContestPoints.buffer,
        outContestFlightTimes.buffer,
      ],
    );
    // The transferred buffers are now neutered on this side — allocate fresh
    // ones to keep accumulating. `everSet` is deliberately NOT reset: it's
    // this worker's memory of which cells it has already recorded a
    // representative sample for, which must persist across flushes so
    // "first sample per cell" stays correct for this worker's whole run.
    grid = createEmptyGrid();
    totals = emptyTotals();
    shotsThisFlush = 0;
    scatterPoints = [];
    contestPoints = [];
    contestFlightTimes = [];
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
          // ONE population for everything the heat map shows: a rim-touching
          // miss, at its 2.44 m contest point (result.contestPoint — where
          // the ball first comes down through REBOUND_CATCH_HEIGHT_M after
          // the first rim contact), kept only if that point lands inside the
          // court per src/rebound/contest.ts's isInboundsLanding. The grid
          // (counts/stats), the scatter dots (`points`), and the rebound
          // contest (`contestPoints`) are now all the exact same set of
          // points — floorPoint/catchPoint/landingValid play no part here.
          if (result.rimContacts > 0 && result.contestPoint) {
            if (result.contestPointIsFallback) totals.contestCatchFallbackCount++;
            const [cx, cz] = result.contestPoint;
            if (isInboundsLanding(cx, cz)) {
              const inGrid = recordSample(grid, everSet, cx, cz, angleDeg, aimDeg, speed, msg.spinRps, true);
              if (inGrid) {
                totals.recordedCount++;
                if (cz < 0) totals.nearSideCount++;
                else totals.farSideCount++;
              }
              scatterPoints.push(cx, cz);
              contestPoints.push(cx, cz);
              // rimContacts > 0 guarantees firstRimContactTime is set — see
              // its own comment in core.ts.
              contestFlightTimes.push(result.firstRimContactTime!);
            } else {
              totals.contestOutOfBounds++;
            }
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
