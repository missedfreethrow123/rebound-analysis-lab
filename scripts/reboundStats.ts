// Baseline/comparison script for the rebound-contest "go-around" feature.
// NOT imported by the app — a standalone diagnostic. Run with vite-node (see
// README at the bottom of this file / the usage message below) so the "@/..."
// path alias resolves exactly the way the app's own Vite build resolves it.
//
// Deterministic: simulate() and simulateRebound() are both pure functions of
// their inputs (core.ts's own header: "Calling simulate() twice with the
// same ShotParams returns byte-identical output"), and this script never
// reads wall-clock time or randomness for anything that affects the numbers
// (only for progress/ETA logging) — same code, same shot grid, same numbers,
// every run.
//
// PERFORMANCE NOTE (read before assuming this literally mirrors the app):
// for each shot, this first calls simulate() WITHOUT trajectory recording —
// byte-for-byte the same call the app's own sweep.worker.ts makes — to
// decide whether the shot qualifies (see QUALIFYING FILTER below). Only for
// shots that qualify does it call simulate() a SECOND time, now WITH
// trajectory recording, to get what simulateRebound() needs. This is safe
// specifically because recordTrajectory is documented in core.ts as a pure
// post-hoc toggle that never affects the physics integration itself — the
// two calls are guaranteed byte-identical in every other field. Only ~7-8%
// of shots end up qualifying (rim-touching misses), so this avoids ~195,000
// wasted trajectory-array allocations and cuts the run from several hours to
// roughly the same ~85 minutes a trajectory-free sweep alone takes. If you
// want literally every shot's trajectory recorded regardless of whether it's
// used, change `recordTrajectory: false` below to `true` in the first call.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { simulate } from "@/physics/core";
import {
  SHOOTER_HEIGHT_CM,
  DEFAULT_BACKSPIN_RPS,
  BACKBOARD_FROM_BASELINE_M,
  RIM_HEIGHT_M,
  BACKBOARD_Y_ABOVE_RIM_M,
  BACKBOARD_H_M,
  BACKBOARD_W_M,
  BASELINE_TO_RIM_M,
} from "@/physics/constants";
import { DEFAULT_SWEEP_RANGES, expandRange, rangeStepCount } from "@/physics/sweepConfig";
import { simulateRebound, type MovementResult, type TurnDebug } from "@/rebound/movement";
import { contestLanding, isInboundsLanding, REACTION_S, SHOOTER_RECOVERY_S, PLAYER_SPEED_MPS } from "@/rebound/contest";
import { PLAYERS, PLAYER_RADIUS_M } from "@/rebound/players";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Args: <label> [--every N]. --every N: use every N-th shot of the sweep
// grid IN ITS FIXED (angle, aim, speed) ORDER — deterministic, not random
// sampling — for a fast approximate run. Default N=1 (full sweep, unchanged
// behaviour).
const rawArgs = process.argv.slice(2);
let label: string | undefined;
let everyN = 1;
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--every") {
    everyN = parseInt(rawArgs[++i], 10);
  } else if (label === undefined) {
    label = rawArgs[i];
  }
}
if (!label || !Number.isInteger(everyN) || everyN < 1) {
  console.error("Usage: npx vite-node scripts/reboundStats.ts -- <label> [--every N]");
  console.error("Example: npx vite-node scripts/reboundStats.ts -- before");
  console.error("Example: npx vite-node scripts/reboundStats.ts -- quick-sample --every 10");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Config: EXACTLY the app's desktop heat-map sweep — src/physics/sweepConfig.ts's
// DEFAULT_SWEEP_RANGES (not the mobile "coarse" variant: src/routes/index.tsx
// calls defaultSweepConfig(SHOOTER_HEIGHT_CM, isMobile), and desktop's
// isMobile=false selects DEFAULT_SWEEP_RANGES unmodified), plus the fixed
// shooter height and zero backspin the app now always uses.
// ---------------------------------------------------------------------------
const HEIGHT_CM = SHOOTER_HEIGHT_CM; // 190 — see src/physics/constants.ts
const SPIN_RPS = DEFAULT_BACKSPIN_RPS; // 0
const ANGLE_VALUES = expandRange(DEFAULT_SWEEP_RANGES.angle); // 35–65°, step 0.5°
const AIM_VALUES = expandRange(DEFAULT_SWEEP_RANGES.aim); // -12–12°, step 0.5°
const SPEED_VALUES = expandRange(DEFAULT_SWEEP_RANGES.speed); // 5.5–9.0 m/s, step 0.05
const EXCLUDE_MADE = DEFAULT_SWEEP_RANGES.excludeMade; // true

const TOTAL_SHOTS =
  rangeStepCount(DEFAULT_SWEEP_RANGES.angle) * rangeStepCount(DEFAULT_SWEEP_RANGES.aim) * rangeStepCount(DEFAULT_SWEEP_RANGES.speed);

// Blocked-detection thresholds, per the task spec.
const BLOCKED_SPEED_FRACTION = 0.5; // "moved less than 50% of PLAYER_SPEED_MPS x frame interval"
const BLOCKED_MIN_TOTAL_S = 0.1; // "blocked for >= 0.1s total" to count the shot for that player

function startTimeFor(playerId: string, tRim: number): number {
  // Replicates movement.ts's own private startTimeFor() — not exported, so
  // reproduced here from its exported building blocks (REACTION_S,
  // SHOOTER_RECOVERY_S) rather than duplicating movement.ts's source. See
  // movement.ts's own header comment for the FIBA rule this encodes.
  return playerId === "SHOOTER" ? tRim + REACTION_S + SHOOTER_RECOVERY_S : tRim + REACTION_S;
}

type WinnerBucket = "offense" | "defense" | "tie" | "out" | "none";

interface Tally {
  count: number;
  offense: number;
  defense: number;
  tie: number;
  out: number;
  outFloor: number; // split of `out`, NEW model only (outReason) — see tallyOutcome
  outPlayer: number;
  none: number;
  winsById: Record<string, number>;
}
function emptyTally(): Tally {
  return {
    count: 0,
    offense: 0,
    defense: 0,
    tie: 0,
    out: 0,
    outFloor: 0,
    outPlayer: 0,
    none: 0,
    winsById: Object.fromEntries(PLAYERS.map((p) => [p.id, 0])),
  };
}
function tallyOutcome(t: Tally, winnerTeam: WinnerBucket, winnerId: string | null, outReason?: "floor" | "player" | null) {
  t.count++;
  t[winnerTeam]++;
  if (winnerId) t.winsById[winnerId]++;
  if (winnerTeam === "out") {
    if (outReason === "floor") t.outFloor++;
    else if (outReason === "player") t.outPlayer++;
  }
}

// CHANGE 3, rule 5 (limitations-section diagnostic only — core.ts isn't
// modified): core.ts models the backboard as a single zero-thickness plane
// at BACKBOARD_Z_M (its own internal constant, rebuilt here the same way
// contest.ts's isInboundsLanding rebuilds core.ts's internals from the same
// exported building blocks) with no back face or supports, so a ball could
// in principle be computed as passing clean through to "behind" it. Counts
// shots where any recorded trajectory sample ends up back there.
const BACKBOARD_Z_M = BASELINE_TO_RIM_M - BACKBOARD_FROM_BASELINE_M;
const BACKBOARD_Y_M = RIM_HEIGHT_M + BACKBOARD_Y_ABOVE_RIM_M;
function trajectoryPassesBackboardBack(trajectory: Float32Array): boolean {
  const sampleCount = trajectory.length / 4;
  for (let i = 0; i < sampleCount; i++) {
    const x = trajectory[i * 4 + 1];
    const y = trajectory[i * 4 + 2];
    const z = trajectory[i * 4 + 3];
    if (
      z > BACKBOARD_Z_M &&
      Math.abs(x) <= BACKBOARD_W_M / 2 &&
      y >= BACKBOARD_Y_M - BACKBOARD_H_M / 2 &&
      y <= BACKBOARD_Y_M + BACKBOARD_H_M / 2
    ) {
      return true;
    }
  }
  return false;
}

const newTally = emptyTally();
const oldTally = emptyTally();

let totalOverlapViolations = 0;
let catchTimeSum = 0;
let catchTimeCount = 0;
const blockedShotsById: Record<string, number> = Object.fromEntries(PLAYERS.map((p) => [p.id, 0]));
const turnedShotsById: Record<string, number> = Object.fromEntries(PLAYERS.map((p) => [p.id, 0]));
let backboardBackShots = 0;

// For each player, for each frame interval inside (his own start time,
// catchTime), a frame counts toward "blocked time" if his displacement over
// that interval is under 50% of the distance he could have covered at
// PLAYER_SPEED_MPS, AND he is not already essentially at the ball's (fixed)
// floor landing point (PLAYER_RADIUS_M away or less) — i.e. he's stalled
// somewhere that isn't just "arrived." A shot counts as "player X blocked"
// if that accumulated time reaches >= BLOCKED_MIN_TOTAL_S.
function accumulateBlocked(movement: MovementResult, floorPoint: [number, number]) {
  if (movement.tRim === null || movement.catchTime === null) return; // no defined chase window
  const frameSize = 1 + PLAYERS.length * 2;
  const frameCount = movement.frames.length / frameSize;
  if (frameCount < 2) return;
  const frames = movement.frames;
  const [fx, fz] = floorPoint;

  for (let p = 0; p < PLAYERS.length; p++) {
    const startTime = startTimeFor(PLAYERS[p].id, movement.tRim);
    let blockedTime = 0;
    for (let i = 0; i < frameCount - 1; i++) {
      const t0 = frames[i * frameSize];
      const t1 = frames[(i + 1) * frameSize];
      if (t0 < startTime) continue;
      if (t1 > movement.catchTime) break; // frames are time-ordered; nothing later qualifies either
      const x0 = frames[i * frameSize + 1 + p * 2];
      const z0 = frames[i * frameSize + 2 + p * 2];
      const x1 = frames[(i + 1) * frameSize + 1 + p * 2];
      const z1 = frames[(i + 1) * frameSize + 2 + p * 2];
      const dt = t1 - t0;
      if (dt <= 0) continue;
      const moved = Math.hypot(x1 - x0, z1 - z0);
      const distToFloorPoint = Math.hypot(x0 - fx, z0 - fz);
      if (moved < BLOCKED_SPEED_FRACTION * PLAYER_SPEED_MPS * dt && distToFloorPoint > PLAYER_RADIUS_M) {
        blockedTime += dt;
      }
    }
    if (blockedTime >= BLOCKED_MIN_TOTAL_S) blockedShotsById[PLAYERS[p].id]++;
  }
}

// ---------------------------------------------------------------------------
// Main sweep
// ---------------------------------------------------------------------------
console.log(`rebound-stats [${label}]`);
console.log(
  `Config: angle ${DEFAULT_SWEEP_RANGES.angle.min}-${DEFAULT_SWEEP_RANGES.angle.max} step ${DEFAULT_SWEEP_RANGES.angle.step} | ` +
    `aim ${DEFAULT_SWEEP_RANGES.aim.min}-${DEFAULT_SWEEP_RANGES.aim.max} step ${DEFAULT_SWEEP_RANGES.aim.step} | ` +
    `speed ${DEFAULT_SWEEP_RANGES.speed.min}-${DEFAULT_SWEEP_RANGES.speed.max} step ${DEFAULT_SWEEP_RANGES.speed.step} | ` +
    `heightCm=${HEIGHT_CM} spinRps=${SPIN_RPS} excludeMade=${EXCLUDE_MADE}`,
);
console.log(`Total shots: ${TOTAL_SHOTS.toLocaleString()}`);
if (everyN > 1) {
  console.log(`--every ${everyN}: sampling every ${everyN}-th shot of the grid in fixed order (~${Math.ceil(TOTAL_SHOTS / everyN).toLocaleString()} shots)`);
}
console.log(
  `Qualifying filter (app's exact rule, src/physics/sweep.worker.ts): ` +
    `!(excludeMade && outcome==="made") && rimContacts>0 && contestPoint!==null && isInboundsLanding(contestPoint)`,
);

const startWall = Date.now();
let processed = 0; // counts every shot in the grid, sampled or not — keeps progress/ETA accurate against TOTAL_SHOTS
let sampled = 0; // counts only shots actually simulated (== processed when everyN === 1)
let lastPctPrinted = -1;

for (const angleDeg of ANGLE_VALUES) {
  for (const aimDeg of AIM_VALUES) {
    for (const speed of SPEED_VALUES) {
      processed++;

      if ((processed - 1) % everyN !== 0) {
        const pctSkip = Math.floor((processed / TOTAL_SHOTS) * 10) * 10;
        if (pctSkip !== lastPctPrinted && pctSkip > 0) {
          lastPctPrinted = pctSkip;
          const elapsedS = (Date.now() - startWall) / 1000;
          const etaS = (elapsedS / processed) * (TOTAL_SHOTS - processed);
          console.log(
            `  ${pctSkip}% (${processed.toLocaleString()}/${TOTAL_SHOTS.toLocaleString()}) — ` +
              `elapsed ${elapsedS.toFixed(0)}s, ETA ${etaS.toFixed(0)}s, qualifying so far: ${newTally.count.toLocaleString()}`,
          );
        }
        continue;
      }
      sampled++;

      // Pass 1: cheap, trajectory-free — byte-identical to the app's own
      // sweep.worker.ts call, used only to decide qualification.
      const cheap = simulate({ heightCm: HEIGHT_CM, angleDeg, aimDeg, speed, spinRps: SPIN_RPS }, { recordTrajectory: false });

      const isMade = cheap.outcome === "made";
      const qualifies =
        !(EXCLUDE_MADE && isMade) &&
        cheap.rimContacts > 0 &&
        cheap.contestPoint !== null &&
        isInboundsLanding(cheap.contestPoint[0], cheap.contestPoint[1]);

      if (qualifies) {
        // Pass 2: same ShotParams, now with trajectory — simulateRebound
        // needs it. Deterministic re-run; every other field is identical to
        // `cheap` above (core.ts: recordTrajectory never affects physics).
        const result = simulate({ heightCm: HEIGHT_CM, angleDeg, aimDeg, speed, spinRps: SPIN_RPS }, { recordTrajectory: true });
        const contestPoint = result.contestPoint!;
        const releaseToRimS = result.firstRimContactTime!; // rimContacts>0 guarantees this — see core.ts

        // --- OLD model: exactly index.tsx's contestSplit computation ---
        const oldResult = contestLanding(contestPoint[0], contestPoint[1], releaseToRimS);
        tallyOutcome(oldTally, oldResult.winnerTeam as WinnerBucket, oldResult.winnerId);

        // --- NEW model ---
        const turnDebug: TurnDebug = { turnedById: {} };
        const movement = simulateRebound(result, turnDebug);
        tallyOutcome(newTally, movement.winnerTeam, movement.winnerId, movement.outReason);
        totalOverlapViolations += movement.overlapViolations;
        if (movement.catchTime !== null) {
          catchTimeSum += movement.catchTime;
          catchTimeCount++;
        }
        if (result.floorPoint) accumulateBlocked(movement, result.floorPoint);
        for (const p of PLAYERS) {
          if (turnDebug.turnedById[p.id]) turnedShotsById[p.id]++;
        }
        if (trajectoryPassesBackboardBack(result.trajectory)) backboardBackShots++;
      }

      const pct = Math.floor((processed / TOTAL_SHOTS) * 10) * 10;
      if (pct !== lastPctPrinted && pct > 0) {
        lastPctPrinted = pct;
        const elapsedS = (Date.now() - startWall) / 1000;
        const etaS = (elapsedS / processed) * (TOTAL_SHOTS - processed);
        console.log(
          `  ${pct}% (${processed.toLocaleString()}/${TOTAL_SHOTS.toLocaleString()}) — ` +
            `elapsed ${elapsedS.toFixed(0)}s, ETA ${etaS.toFixed(0)}s, qualifying so far: ${newTally.count.toLocaleString()}`,
        );
      }
    }
  }
}

const elapsedS = (Date.now() - startWall) / 1000;
console.log(
  `Done. 100% (${processed.toLocaleString()}/${TOTAL_SHOTS.toLocaleString()}) in ${elapsedS.toFixed(1)}s` +
    (everyN > 1 ? ` — ${sampled.toLocaleString()} shots actually simulated (every ${everyN}-th)` : ""),
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function pct(n: number, denom: number): string {
  return denom > 0 ? ((n / denom) * 100).toFixed(2) + "%" : "n/a";
}

function printTally(name: string, t: Tally) {
  console.log(`\n-- ${name} --`);
  console.log(`  shots counted: ${t.count.toLocaleString()}`);
  console.log(`  offense: ${t.offense.toLocaleString()} (${pct(t.offense, t.count)})`);
  console.log(`  defense: ${t.defense.toLocaleString()} (${pct(t.defense, t.count)})`);
  console.log(`  tie:     ${t.tie.toLocaleString()} (${pct(t.tie, t.count)})`);
  console.log(`  out:     ${t.out.toLocaleString()} (${pct(t.out, t.count)})`);
  console.log(`    out/floor:  ${t.outFloor.toLocaleString()} (${pct(t.outFloor, t.count)})`);
  console.log(`    out/player: ${t.outPlayer.toLocaleString()} (${pct(t.outPlayer, t.count)})`);
  console.log(`  none:    ${t.none.toLocaleString()} (${pct(t.none, t.count)})`);
  console.log(`  wins per player:`);
  for (const p of PLAYERS) {
    const w = t.winsById[p.id];
    console.log(`    ${p.id.padEnd(8)} ${w.toLocaleString().padStart(8)}  (${pct(w, t.count)})`);
  }
}

console.log(`\n========== RESULTS [${label}] ==========`);
console.log(`Qualifying shots (same set fed to both models): ${newTally.count.toLocaleString()} of ${TOTAL_SHOTS.toLocaleString()}`);
printTally("NEW model (simulateRebound, movement.ts)", newTally);
printTally("OLD model (contestLanding, contest.ts — app's current panel)", oldTally);

const meanCatchTime = catchTimeCount > 0 ? catchTimeSum / catchTimeCount : null;
console.log(`\n-- NEW model only --`);
console.log(`  mean catchTime: ${meanCatchTime !== null ? meanCatchTime.toFixed(4) + "s" : "n/a"} (over ${catchTimeCount.toLocaleString()} shots with a catch)`);
console.log(`  total overlapViolations across all shots: ${totalOverlapViolations} (expected 0)`);
console.log(`  blocked (>= ${BLOCKED_MIN_TOTAL_S}s total, chase phase) per player:`);
for (const p of PLAYERS) {
  const n = blockedShotsById[p.id];
  console.log(`    ${p.id.padEnd(8)} ${n.toLocaleString().padStart(8)}  (${pct(n, newTally.count)})`);
}
console.log(`  turned (CHANGE 2) per player:`);
for (const p of PLAYERS) {
  const n = turnedShotsById[p.id];
  console.log(`    ${p.id.padEnd(8)} ${n.toLocaleString().padStart(8)}  (${pct(n, newTally.count)})`);
}
console.log(
  `  backboard-back (limitations only — core.ts has no back face/supports): ${backboardBackShots.toLocaleString()} (${pct(backboardBackShots, newTally.count)})`,
);

// ---------------------------------------------------------------------------
// JSON output
// ---------------------------------------------------------------------------
const outDir = path.join(__dirname, "output");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `rebound-stats-${label}.json`);

const json = {
  label,
  generatedAt: new Date().toISOString(),
  elapsedSeconds: elapsedS,
  config: {
    heightCm: HEIGHT_CM,
    spinRps: SPIN_RPS,
    angle: DEFAULT_SWEEP_RANGES.angle,
    aim: DEFAULT_SWEEP_RANGES.aim,
    speed: DEFAULT_SWEEP_RANGES.speed,
    excludeMade: EXCLUDE_MADE,
    totalShots: TOTAL_SHOTS,
    everyN,
    sampledShots: sampled,
  },
  qualifyingFilter:
    '!(excludeMade && outcome==="made") && rimContacts>0 && contestPoint!==null && isInboundsLanding(contestPoint)',
  qualifyingShots: newTally.count,
  new: newTally,
  old: oldTally,
  newOnly: {
    meanCatchTimeS: meanCatchTime,
    catchTimeSampleCount: catchTimeCount,
    totalOverlapViolations,
    blockedShotsById,
    blockedThreshold: { speedFraction: BLOCKED_SPEED_FRACTION, minTotalS: BLOCKED_MIN_TOTAL_S },
    turnedShotsById,
    backboardBackShots,
  },
};

fs.writeFileSync(outPath, JSON.stringify(json, null, 2));
console.log(`\nSaved: ${path.relative(process.cwd(), outPath)}`);
