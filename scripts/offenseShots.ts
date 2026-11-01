// Analysis script: every shot where the OFFENSE gets the rebound, plus a
// parameter-block summary table. Read-only w.r.t. src/ — this never imports
// anything that isn't already exported, and never modifies the player model
// (src/rebound/movement.ts) or physics (src/physics/core.ts). Standalone,
// same runner as scripts/reboundStats.ts — see the usage message below.
//
// Deterministic: simulate() and simulateRebound() are both pure functions of
// their inputs (see reboundStats.ts's own header for the citation), and this
// script never reads wall-clock time or randomness for anything that affects
// the numbers (only for progress/ETA logging).
//
// PERFORMANCE: same two-pass trick as reboundStats.ts — simulate() WITHOUT
// trajectory recording first (cheap, byte-identical to the app's own
// sweep.worker.ts call) to read outcome/rimContacts/firstRimContactTime; only
// when rimContacts > 0 (needed for rimHitAngleDeg, and — when the shot wasn't
// made — for simulateRebound) does it re-run simulate() WITH trajectory
// recording. recordTrajectory is documented in core.ts as a pure post-hoc
// toggle that never affects the physics integration itself, so the two calls
// are guaranteed byte-identical in every other field.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

import { simulate, type ShotResult } from "@/physics/core";
import { SHOOTER_HEIGHT_CM, DEFAULT_BACKSPIN_RPS, REBOUND_CATCH_HEIGHT_M } from "@/physics/constants";
import { DEFAULT_SWEEP_RANGES, expandRange, rangeStepCount } from "@/physics/sweepConfig";
import { simulateRebound } from "@/rebound/movement";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Args: [--every N]. --every N: use every N-th shot of the sweep grid IN ITS
// FIXED (angle, aim, speed) ORDER — deterministic, not random sampling — for
// a fast approximate test run. Default N=1 (full sweep — the deliverable
// run). Not part of the task spec itself; included only so a quick
// correctness check doesn't require an ~85-minute full run every time.
const rawArgs = process.argv.slice(2);
let everyN = 1;
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === "--every") everyN = parseInt(rawArgs[++i], 10);
}
if (!Number.isInteger(everyN) || everyN < 1) {
  console.error("Usage: npx vite-node scripts/offenseShots.ts [-- --every N]");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Config: EXACTLY reboundStats.ts's own grid (src/physics/sweepConfig.ts's
// DEFAULT_SWEEP_RANGES — the app's desktop heat-map sweep), plus the fixed
// shooter height and zero backspin the app now always uses.
// ---------------------------------------------------------------------------
const HEIGHT_CM = SHOOTER_HEIGHT_CM;
const SPIN_RPS = DEFAULT_BACKSPIN_RPS;
const ANGLE_VALUES = expandRange(DEFAULT_SWEEP_RANGES.angle);
const AIM_VALUES = expandRange(DEFAULT_SWEEP_RANGES.aim);
const SPEED_VALUES = expandRange(DEFAULT_SWEEP_RANGES.speed);

const TOTAL_SHOTS =
  rangeStepCount(DEFAULT_SWEEP_RANGES.angle) * rangeStepCount(DEFAULT_SWEEP_RANGES.aim) * rangeStepCount(DEFAULT_SWEEP_RANGES.speed);

// ---------------------------------------------------------------------------
// rimHitAngleDeg / rimSector
// ---------------------------------------------------------------------------
// Ball (x,y,z) at the trajectory sample nearest a given time — core.ts always
// records a collision moment (e.g. the first rim contact) as an exact
// sample, never decimated away, so for firstRimContactTime this IS the exact
// contact position, not an interpolated guess. Reused below for catchHeight
// too (there the target time, movement.ts's own catchTime, is also always an
// exact recorded-or-landed sample time on the SAME 5ms movement grid — this
// still does a nearest-sample lookup rather than assuming an exact float
// match, since catchTime is independently computed by simulateRebound's own
// loop rather than read back from this trajectory array).
function nearestSample(trajectory: Float32Array, targetT: number): { x: number; y: number; z: number } {
  const sampleCount = trajectory.length / 4;
  let bestI = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < sampleCount; i++) {
    const t = trajectory[i * 4];
    const diff = Math.abs(t - targetT);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestI = i;
    } else if (t > targetT && diff > bestDiff) {
      break; // samples are time-ordered; once we're moving away, we've passed it
    }
  }
  return { x: trajectory[bestI * 4 + 1], y: trajectory[bestI * 4 + 2], z: trajectory[bestI * 4 + 3] };
}

// 0° = front of the rim (toward the shooter, -z), +90° = shooter's RIGHT
// (+x, core.ts's own axis convention), -90° = shooter's left, ±180° = back
// (toward the backboard, +z). atan2(x, -z) gives exactly this mapping:
// (x=0,z=-1)->0, (x=1,z=0)->90, (x=0,z=1)->180, (x=-1,z=0)->-90.
function rimHitAngleDegOf(x: number, z: number): number {
  return (Math.atan2(x, -z) * 180) / Math.PI;
}

const RIM_SECTORS = ["front", "front-right", "right", "back-right", "back", "back-left", "left", "front-left"] as const;
type RimSector = (typeof RIM_SECTORS)[number];
function rimSectorOf(angleDeg: number): RimSector {
  // 8 sectors of 45°, centred ON 0/45/90/...: round to the nearest multiple
  // of 45°, then index into RIM_SECTORS (defined in the same +45°-per-step
  // order starting at front=0°).
  const idx = (((Math.round(angleDeg / 45) % 8) + 8) % 8) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
  return RIM_SECTORS[idx];
}

// ---------------------------------------------------------------------------
// Parameter blocks: angle 2°, aim 1°, speed 0.1 m/s, aligned to round values.
// ---------------------------------------------------------------------------
const ANGLE_BLOCK_SIZE = 2;
const AIM_BLOCK_SIZE = 1;
const SPEED_BLOCK_SIZE = 0.1;
const ROUND_DP = 6; // float-dust cleanup after the /size*size floor

function round(v: number): number {
  return Math.round(v * 10 ** ROUND_DP) / 10 ** ROUND_DP;
}
function blockFloor(value: number, size: number): number {
  return round(Math.floor(round(value) / size + 1e-9) * size);
}

interface BlockStats {
  angleFrom: number;
  aimFrom: number;
  speedFrom: number;
  offenseShots: number;
  shotsInBlock: number;
  defense: number;
  out: number;
  made: number;
  no_rim: number;
  tie: number;
  none: number;
  offenseRimSectorCounts: Map<string, number>;
}
const blocks = new Map<string, BlockStats>();
function blockKeyOf(angleFrom: number, aimFrom: number, speedFrom: number): string {
  return `${angleFrom}|${aimFrom}|${speedFrom}`;
}

// ---------------------------------------------------------------------------
// Categorisation (FIBA, from the shooting team's point of view — see the
// task spec this was built from):
//   made     — outcome === "made" (1 point, but possession to the opponents)
//   no_rim   — rimContacts === 0 && outcome !== "made" (free-throw
//              violation, ball to the opponents: airballs AND
//              backboard-only misses — note core.ts's own `outcome` string
//              can read "backboard_miss" even when rimContacts > 0, since
//              its if/else chain checks backboardHit before rimContacts; so
//              this category is decided from rimContacts, never from the
//              outcome string)
//   offense/defense/out/tie/none — rimContacts > 0 && outcome !== "made":
//              simulateRebound's own winnerTeam, used as-is.
// ---------------------------------------------------------------------------
type Category = "offense" | "defense" | "out" | "made" | "no_rim" | "tie" | "none";

interface ShotRow {
  angleDeg: number;
  aimDeg: number;
  speedMps: number;
  category: Category;
  rimHitAngleDeg: number | null;
  rimSector: RimSector | null;
  winnerId: string | null;
  catchX: number | null;
  catchZ: number | null;
  catchTime: number | null;
  catchHeight: number | null;
  outReason: "floor" | "player" | null;
}

const allShots: ShotRow[] = [];
const offenseShots: ShotRow[] = [];

const categoryCountsAll: Record<Category, number> = { offense: 0, defense: 0, out: 0, made: 0, no_rim: 0, tie: 0, none: 0 };
const winnerIdCounts: Record<string, number> = {};
const offenseRimSectorCounts: Record<string, number> = {};

console.log(`offense-shots analysis`);
console.log(
  `Grid: angle ${DEFAULT_SWEEP_RANGES.angle.min}-${DEFAULT_SWEEP_RANGES.angle.max} step ${DEFAULT_SWEEP_RANGES.angle.step} | ` +
    `aim ${DEFAULT_SWEEP_RANGES.aim.min}-${DEFAULT_SWEEP_RANGES.aim.max} step ${DEFAULT_SWEEP_RANGES.aim.step} | ` +
    `speed ${DEFAULT_SWEEP_RANGES.speed.min}-${DEFAULT_SWEEP_RANGES.speed.max} step ${DEFAULT_SWEEP_RANGES.speed.step} | ` +
    `heightCm=${HEIGHT_CM} spinRps=${SPIN_RPS}`,
);
console.log(`Total shots: ${TOTAL_SHOTS.toLocaleString()}`);
if (everyN > 1) console.log(`--every ${everyN}: TEST RUN, not the full sweep (~${Math.ceil(TOTAL_SHOTS / everyN).toLocaleString()} shots)`);

const startWall = Date.now();
let processed = 0;
let lastPctPrinted = -1;

for (const angleDeg of ANGLE_VALUES) {
  for (const aimDeg of AIM_VALUES) {
    for (const speed of SPEED_VALUES) {
      processed++;
      if ((processed - 1) % everyN === 0) {
        const cheap = simulate({ heightCm: HEIGHT_CM, angleDeg, aimDeg, speed, spinRps: SPIN_RPS }, { recordTrajectory: false });

        let category: Category;
        let rimHitAngleDeg: number | null = null;
        let rimSector: RimSector | null = null;
        let winnerId: string | null = null;
        let catchX: number | null = null;
        let catchZ: number | null = null;
        let catchTime: number | null = null;
        let catchHeight: number | null = null;
        let outReason: "floor" | "player" | null = null;

        if (cheap.outcome === "made") {
          category = "made";
          if (cheap.rimContacts > 0) {
            // Rim-and-in: still want rimHitAngleDeg, needs the trajectory.
            const withTraj = simulate({ heightCm: HEIGHT_CM, angleDeg, aimDeg, speed, spinRps: SPIN_RPS }, { recordTrajectory: true });
            const hit = nearestSample(withTraj.trajectory, withTraj.firstRimContactTime!);
            rimHitAngleDeg = rimHitAngleDegOf(hit.x, hit.z);
            rimSector = rimSectorOf(rimHitAngleDeg);
          }
        } else if (cheap.rimContacts === 0) {
          category = "no_rim";
        } else {
          const result: ShotResult = simulate({ heightCm: HEIGHT_CM, angleDeg, aimDeg, speed, spinRps: SPIN_RPS }, { recordTrajectory: true });
          const hit = nearestSample(result.trajectory, result.firstRimContactTime!);
          rimHitAngleDeg = rimHitAngleDegOf(hit.x, hit.z);
          rimSector = rimSectorOf(rimHitAngleDeg);

          const movement = simulateRebound(result);
          category = movement.winnerTeam; // "offense" | "defense" | "tie" | "out" | "none" — matches Category 1:1
          winnerId = movement.winnerId;
          outReason = movement.outReason;
          if (movement.catchTime !== null && movement.catchPoint !== null) {
            catchTime = movement.catchTime;
            catchX = movement.catchPoint.x;
            catchZ = movement.catchPoint.z;
            catchHeight = nearestSample(result.trajectory, movement.catchTime).y;
          }
        }

        const row: ShotRow = {
          angleDeg,
          aimDeg,
          speedMps: speed,
          category,
          rimHitAngleDeg,
          rimSector,
          winnerId,
          catchX,
          catchZ,
          catchTime,
          catchHeight,
          outReason,
        };
        allShots.push(row);
        categoryCountsAll[category]++;
        if (category === "offense" && winnerId) winnerIdCounts[winnerId] = (winnerIdCounts[winnerId] ?? 0) + 1;

        const angleFrom = blockFloor(angleDeg, ANGLE_BLOCK_SIZE);
        const aimFrom = blockFloor(aimDeg, AIM_BLOCK_SIZE);
        const speedFrom = blockFloor(speed, SPEED_BLOCK_SIZE);
        const bKey = blockKeyOf(angleFrom, aimFrom, speedFrom);
        let b = blocks.get(bKey);
        if (!b) {
          b = {
            angleFrom,
            aimFrom,
            speedFrom,
            offenseShots: 0,
            shotsInBlock: 0,
            defense: 0,
            out: 0,
            made: 0,
            no_rim: 0,
            tie: 0,
            none: 0,
            offenseRimSectorCounts: new Map(),
          };
          blocks.set(bKey, b);
        }
        b.shotsInBlock++;
        b[category === "offense" ? "offenseShots" : category === "defense" ? "defense" : category]++;
        if (category === "offense") {
          offenseShots.push(row);
          if (rimSector) {
            offenseRimSectorCounts[rimSector] = (offenseRimSectorCounts[rimSector] ?? 0) + 1;
            b.offenseRimSectorCounts.set(rimSector, (b.offenseRimSectorCounts.get(rimSector) ?? 0) + 1);
          }
        }
      }

      const pct = Math.floor((processed / TOTAL_SHOTS) * 20) * 5;
      if (pct !== lastPctPrinted && pct > 0) {
        lastPctPrinted = pct;
        const elapsedS = (Date.now() - startWall) / 1000;
        const etaS = (elapsedS / processed) * (TOTAL_SHOTS - processed);
        console.log(
          `  ${pct}% (${processed.toLocaleString()}/${TOTAL_SHOTS.toLocaleString()}) — elapsed ${elapsedS.toFixed(0)}s, ETA ${etaS.toFixed(0)}s, offense so far: ${categoryCountsAll.offense.toLocaleString()}`,
        );
      }
    }
  }
}

const elapsedS = (Date.now() - startWall) / 1000;
console.log(`Done in ${elapsedS.toFixed(1)}s.`);

// ---------------------------------------------------------------------------
// offense_shots sort: angleDeg, then aimDeg, then speedMps
// ---------------------------------------------------------------------------
offenseShots.sort((a, b) => a.angleDeg - b.angleDeg || a.aimDeg - b.aimDeg || a.speedMps - b.speedMps);

// ---------------------------------------------------------------------------
// offense_blocks: only blocks with >=1 offense shot, sorted by offenseShots
// desc then offensePct desc.
// ---------------------------------------------------------------------------
interface BlockRow {
  angleFrom: number;
  angleTo: number;
  aimFrom: number;
  aimTo: number;
  speedFrom: number;
  speedTo: number;
  offenseShots: number;
  shotsInBlock: number;
  offensePct: number;
  defense: number;
  out: number;
  made: number;
  no_rim: number;
  topRimSector: string;
}
const blockRows: BlockRow[] = [];
for (const b of blocks.values()) {
  if (b.offenseShots < 1) continue;
  let topSector = "";
  let topCount = -1;
  for (const [sector, count] of b.offenseRimSectorCounts) {
    if (count > topCount) {
      topCount = count;
      topSector = sector;
    }
  }
  blockRows.push({
    angleFrom: b.angleFrom,
    angleTo: round(b.angleFrom + ANGLE_BLOCK_SIZE),
    aimFrom: b.aimFrom,
    aimTo: round(b.aimFrom + AIM_BLOCK_SIZE),
    speedFrom: b.speedFrom,
    speedTo: round(b.speedFrom + SPEED_BLOCK_SIZE),
    offenseShots: b.offenseShots,
    shotsInBlock: b.shotsInBlock,
    offensePct: (b.offenseShots / b.shotsInBlock) * 100,
    defense: b.defense,
    out: b.out,
    made: b.made,
    no_rim: b.no_rim,
    topRimSector: topSector,
  });
}
blockRows.sort((a, b) => b.offenseShots - a.offenseShots || b.offensePct - a.offensePct);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function pct(n: number, denom: number): string {
  return denom > 0 ? ((n / denom) * 100).toFixed(2) + "%" : "n/a";
}

const totalAll = allShots.length;
const rimTouchingMisses = categoryCountsAll.offense + categoryCountsAll.defense + categoryCountsAll.out + categoryCountsAll.tie + categoryCountsAll.none;

console.log(`\n========== SUMMARY ==========`);
console.log(`Total shots simulated: ${totalAll.toLocaleString()}`);
console.log(`\nOutcome category, over ALL shots:`);
for (const cat of ["offense", "defense", "out", "made", "no_rim", "tie", "none"] as Category[]) {
  console.log(`  ${cat.padEnd(8)} ${categoryCountsAll[cat].toLocaleString().padStart(8)}  (${pct(categoryCountsAll[cat], totalAll)})`);
}
console.log(`\nOutcome category, over rim-touching misses only (offense+defense+out+tie+none = ${rimTouchingMisses.toLocaleString()}):`);
for (const cat of ["offense", "defense", "out", "tie", "none"] as Category[]) {
  console.log(`  ${cat.padEnd(8)} ${categoryCountsAll[cat].toLocaleString().padStart(8)}  (${pct(categoryCountsAll[cat], rimTouchingMisses)})`);
}

if (offenseShots.length > 0) {
  const angles = offenseShots.map((s) => s.angleDeg);
  const aims = offenseShots.map((s) => s.aimDeg);
  const speeds = offenseShots.map((s) => s.speedMps);
  console.log(`\nOffense shots: ${offenseShots.length.toLocaleString()}`);
  console.log(`  angle: ${Math.min(...angles)} - ${Math.max(...angles)}`);
  console.log(`  aim:   ${Math.min(...aims)} - ${Math.max(...aims)}`);
  console.log(`  speed: ${Math.min(...speeds)} - ${Math.max(...speeds)}`);
  console.log(`  by winnerId:`);
  for (const id of Object.keys(winnerIdCounts).sort()) {
    console.log(`    ${id.padEnd(10)} ${winnerIdCounts[id].toLocaleString().padStart(8)}  (${pct(winnerIdCounts[id], offenseShots.length)})`);
  }
  console.log(`  by rimSector:`);
  for (const sector of RIM_SECTORS) {
    const n = offenseRimSectorCounts[sector] ?? 0;
    console.log(`    ${sector.padEnd(12)} ${n.toLocaleString().padStart(8)}  (${pct(n, offenseShots.length)})`);
  }
}

const blocksAtOrAbove50 = blockRows.filter((b) => b.offensePct >= 50).length;
console.log(`\noffense_blocks rows: ${blockRows.length.toLocaleString()} (blocks with >=1 offense shot)`);
console.log(`  of which offensePct >= 50%: ${blocksAtOrAbove50.toLocaleString()}`);

console.log(`\nTop 10 blocks by offenseShots:`);
console.log(`  ${"angle".padEnd(12)}${"aim".padEnd(10)}${"speed".padEnd(13)}${"offense".padStart(8)}${"total".padStart(7)}${"offense%".padStart(10)}  topRimSector`);
for (const b of blockRows.slice(0, 10)) {
  const angleStr = `[${b.angleFrom},${b.angleTo})`;
  const aimStr = `[${b.aimFrom},${b.aimTo})`;
  const speedStr = `[${b.speedFrom.toFixed(1)},${b.speedTo.toFixed(1)})`;
  console.log(
    `  ${angleStr.padEnd(12)}${aimStr.padEnd(10)}${speedStr.padEnd(13)}${String(b.offenseShots).padStart(8)}${String(b.shotsInBlock).padStart(7)}${(b.offensePct.toFixed(1) + "%").padStart(10)}  ${b.topRimSector}`,
  );
}

console.log(`\nRuntime: ${elapsedS.toFixed(1)}s`);

// Sanity check vs the last "sync-sample" reboundStats.ts run (--every 10,
// 1,642 qualifying shots): offense/defense/out % among rim-touching misses
// should match within normal sampling difference (sync-sample is a 1-in-10
// SAMPLE of the same grid; this script — at --every 1 — is the full
// population).
console.log(`\nSanity check vs sync-sample (reboundStats.ts, --every 10, rim-touching misses only):`);
console.log(`  sync-sample: offense 16.02%  defense 80.21%  out 3.71%`);
console.log(
  `  this run:    offense ${pct(categoryCountsAll.offense, rimTouchingMisses)}  defense ${pct(categoryCountsAll.defense, rimTouchingMisses)}  out ${pct(categoryCountsAll.out, rimTouchingMisses)}`,
);

// ---------------------------------------------------------------------------
// Output files
// ---------------------------------------------------------------------------
const outDir = path.join(__dirname, "output");
fs.mkdirSync(outDir, { recursive: true });

async function writeXlsx() {
  const wb = new ExcelJS.Workbook();

  const ws1 = wb.addWorksheet("offense_shots");
  ws1.columns = [
    { header: "angleDeg", key: "angleDeg", width: 10 },
    { header: "aimDeg", key: "aimDeg", width: 10 },
    { header: "speedMps", key: "speedMps", width: 10 },
    { header: "winnerId", key: "winnerId", width: 10 },
    { header: "rimSector", key: "rimSector", width: 14 },
    { header: "rimHitAngleDeg", key: "rimHitAngleDeg", width: 16 },
    { header: "catchX", key: "catchX", width: 10 },
    { header: "catchZ", key: "catchZ", width: 10 },
    { header: "catchTime", key: "catchTime", width: 10 },
    { header: "catchHeight", key: "catchHeight", width: 12 },
  ];
  ws1.addRows(offenseShots);

  const ws2 = wb.addWorksheet("offense_blocks");
  ws2.columns = [
    { header: "angleFrom", key: "angleFrom", width: 10 },
    { header: "angleTo", key: "angleTo", width: 10 },
    { header: "aimFrom", key: "aimFrom", width: 10 },
    { header: "aimTo", key: "aimTo", width: 10 },
    { header: "speedFrom", key: "speedFrom", width: 10 },
    { header: "speedTo", key: "speedTo", width: 10 },
    { header: "offenseShots", key: "offenseShots", width: 13 },
    { header: "shotsInBlock", key: "shotsInBlock", width: 13 },
    { header: "offensePct", key: "offensePct", width: 11 },
    { header: "defense", key: "defense", width: 9 },
    { header: "out", key: "out", width: 7 },
    { header: "made", key: "made", width: 7 },
    { header: "no_rim", key: "no_rim", width: 8 },
    { header: "topRimSector", key: "topRimSector", width: 14 },
  ];
  ws2.addRows(blockRows);

  const outPath = path.join(outDir, "offense_shots.xlsx");
  await wb.xlsx.writeFile(outPath);
  return outPath;
}

function csvEscape(v: string): string {
  return /[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function writeAllShotsCsv(): string {
  const cols: (keyof ShotRow)[] = [
    "angleDeg",
    "aimDeg",
    "speedMps",
    "category",
    "rimHitAngleDeg",
    "rimSector",
    "winnerId",
    "catchX",
    "catchZ",
    "catchTime",
    "catchHeight",
    "outReason",
  ];
  const lines: string[] = [cols.join(";")];
  for (const row of allShots) {
    lines.push(cols.map((c) => (row[c] === null ? "" : csvEscape(String(row[c])))).join(";"));
  }
  const outPath = path.join(outDir, "all_shots.csv");
  fs.writeFileSync(outPath, lines.join("\n"));
  return outPath;
}

(async () => {
  const xlsxPath = await writeXlsx();
  const csvPath = writeAllShotsCsv();
  const xlsxSize = fs.statSync(xlsxPath).size;
  const csvSize = fs.statSync(csvPath).size;
  console.log(`\nSaved:`);
  console.log(`  ${path.relative(process.cwd(), xlsxPath)}  (${(xlsxSize / 1024).toFixed(1)} KB) — sheets: offense_shots, offense_blocks`);
  console.log(`  ${path.relative(process.cwd(), csvPath)}  (${(csvSize / 1024 / 1024).toFixed(2)} MB) — all_shots, ';'-separated`);
})();
