// Main-thread sweep orchestrator: spawns a capped worker pool, gives each
// worker its own slice of the angle range, merges their progressive count/
// param deltas, and recomputes summary statistics — all off the main thread
// except cheap merging, so sliders stay responsive while a sweep runs (see
// HEATMAP_SPEC.md's "the main thread must never block").
//
// Client-side only: references `navigator`/`Worker` only inside startSweep()
// (never at module scope), so importing this module is SSR-safe — it's the
// call site's job to only invoke it after hydration, same as the rest of the
// physics/rendering stack.

import { createEmptyGrid, mergeGrid, emptyTotals, addTotals, computeStats, GRID_NX, GRID_NY, type SweepGrid, type SweepStats, type SweepTotals } from "./sweepGrid";
import { expandRange, splitEvenly, totalShotCount, type SweepConfig } from "./sweepConfig";
import type { SweepWorkerOutboundMessage, SweepWorkerStartMessage, SweepWorkerCancelMessage } from "./sweep.worker";

const MAX_WORKERS = 8;
const DEFAULT_WORKER_COUNT_FALLBACK = 4; // if navigator.hardwareConcurrency is unavailable
const STATS_RECOMPUTE_INTERVAL_MS = 100; // throttles the O(NX*NY log) hottest-cell/radius scan independently of how often workers post

export interface SweepProgress {
  grid: SweepGrid;
  stats: SweepStats;
  shotsCompleted: number;
  totalShotsPlanned: number;
  done: boolean;
}

export interface SweepHandle {
  cancel(): void;
}

export function startSweep(config: SweepConfig, onProgress: (progress: SweepProgress) => void): SweepHandle {
  const angleValues = expandRange(config.angle);
  const workerCount = Math.max(
    1,
    Math.min(MAX_WORKERS, (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || DEFAULT_WORKER_COUNT_FALLBACK),
  );
  const angleSlices = splitEvenly(angleValues, workerCount);
  const totalShotsPlanned = totalShotCount(config);

  const grid = createEmptyGrid();
  const everSet = new Uint8Array(GRID_NX * GRID_NY);
  let totals: SweepTotals = emptyTotals();
  let shotsCompleted = 0;
  let lastStatsComputeAt = 0;
  let cachedStats: SweepStats = computeStats(grid, totals);

  const workers: Worker[] = [];
  let finishedWorkers = 0;
  let settled = false; // true once every worker has reported done, or cancel() has torn the pool down

  const deliver = (done: boolean, force: boolean) => {
    const now = performance.now();
    if (force || now - lastStatsComputeAt >= STATS_RECOMPUTE_INTERVAL_MS || done) {
      cachedStats = computeStats(grid, totals);
      lastStatsComputeAt = now;
    }
    onProgress({ grid, stats: cachedStats, shotsCompleted, totalShotsPlanned, done });
  };

  for (let i = 0; i < angleSlices.length; i++) {
    if (angleSlices[i].length === 0) continue; // more workers than angle values in a tiny/custom sweep
    const worker = new Worker(new URL("./sweep.worker.ts", import.meta.url), { type: "module" });
    workers.push(worker);

    worker.onmessage = (event: MessageEvent) => {
      if (settled) return;
      const msg = event.data as SweepWorkerOutboundMessage;
      mergeGrid(grid, everSet, msg.grid);
      totals = addTotals(totals, msg.totals);
      shotsCompleted += msg.shotsThisFlush;

      if (msg.type === "done") {
        finishedWorkers++;
      }
      const allDone = finishedWorkers === workers.length;
      deliver(allDone, allDone);

      if (allDone && !settled) {
        settled = true;
        for (const w of workers) w.terminate();
      }
    };

    const startMsg: SweepWorkerStartMessage = {
      type: "start",
      workerId: i,
      angleValues: angleSlices[i],
      aimRange: config.aim,
      speedRange: config.speed,
      heightCm: config.heightCm,
      spinRps: config.spinRps,
      record: config.record,
      excludeMade: config.excludeMade,
    };
    worker.postMessage(startMsg);
  }

  return {
    cancel() {
      if (settled) return;
      const cancelMsg: SweepWorkerCancelMessage = { type: "cancel" };
      for (const w of workers) w.postMessage(cancelMsg);
      // Each worker flushes its final partial delta on receiving "cancel"
      // (see sweep.worker.ts's runSweep loop) and that arrives through the
      // normal onmessage handler above, which sets `settled` once every
      // worker has reported done — so this timeout is only a fallback for a
      // worker that doesn't respond, not the primary shutdown path. Either
      // way, cancel() doesn't discard progress the user already waited for.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        for (const w of workers) w.terminate();
      }, 300);
    },
  };
}
