// "Top 10 zonas" — the team's pre-picked best parameter zones for drawing an
// offensive rebound, each a (angle, aim, speed) centre ± one human shooting
// error, sampled as the 5x5x5 = 125 grid points inside that range. Pure data
// + a pure runner (no React, no Three.js) — reuses categorizeShot (which
// itself reuses simulate()/simulateRebound(), no second physics copy).

import { categorizeShot, type CategorizedShot, type ShotCategory } from "./categorize";

export const ANGLE_ERROR_DEG = 1.3;
export const AIM_ERROR_DEG = 1.3;
export const SPEED_ERROR_MPS = 0.13;

const ANGLE_STEP_OFFSETS = [-1.0, -0.5, 0, 0.5, 1.0]; // degrees
const AIM_STEP_OFFSETS = [-1.0, -0.5, 0, 0.5, 1.0]; // degrees
const SPEED_STEP_OFFSETS = [-0.1, -0.05, 0, 0.05, 0.1]; // m/s
const SHOTS_PER_ZONE = ANGLE_STEP_OFFSETS.length * AIM_STEP_OFFSETS.length * SPEED_STEP_OFFSETS.length; // 125

export interface Top10Zone {
  angleDeg: number;
  aimDeg: number;
  speedMps: number;
  color: string;
}

// Hard-coded exactly as specified — the team's own sweep result.
export const TOP10_ZONES: Top10Zone[] = [
  { angleDeg: 26.5, aimDeg: 0.0, speedMps: 8.8, color: "#1f77b4" },
  { angleDeg: 29.0, aimDeg: 1.0, speedMps: 8.25, color: "#ff7f0e" },
  { angleDeg: 27.0, aimDeg: 2.5, speedMps: 8.65, color: "#2ca02c" },
  { angleDeg: 30.5, aimDeg: 1.5, speedMps: 8.0, color: "#d62728" },
  { angleDeg: 27.0, aimDeg: -2.5, speedMps: 8.65, color: "#9467bd" },
  { angleDeg: 28.5, aimDeg: -2.5, speedMps: 8.35, color: "#8c564b" },
  { angleDeg: 26.0, aimDeg: 2.5, speedMps: 8.9, color: "#e377c2" },
  { angleDeg: 27.5, aimDeg: 0.0, speedMps: 8.55, color: "#7f7f7f" },
  { angleDeg: 32.0, aimDeg: 1.5, speedMps: 7.75, color: "#bcbd22" },
  { angleDeg: 30.0, aimDeg: -2.5, speedMps: 8.1, color: "#17becf" },
];

// Expected per-zone breakdown from the team's sweep (the mandatory check).
// Not listed in the source table (offense/defense/out/none/made always sum
// to 125): no_rim, tie and jump_ball are implicitly 0 for every zone.
interface ExpectedCounts {
  offense: number;
  defense: number;
  out: number;
  none: number;
  made: number;
}
const EXPECTED_COUNTS: ExpectedCounts[] = [
  { offense: 95, defense: 27, out: 0, none: 1, made: 2 },
  { offense: 89, defense: 30, out: 3, none: 2, made: 1 },
  { offense: 85, defense: 26, out: 14, none: 0, made: 0 },
  { offense: 85, defense: 40, out: 0, none: 0, made: 0 },
  { offense: 84, defense: 34, out: 7, none: 0, made: 0 },
  { offense: 82, defense: 42, out: 1, none: 0, made: 0 },
  { offense: 81, defense: 23, out: 21, none: 0, made: 0 },
  { offense: 81, defense: 40, out: 0, none: 2, made: 2 },
  { offense: 78, defense: 47, out: 0, none: 0, made: 0 },
  { offense: 77, defense: 47, out: 1, none: 0, made: 0 },
];

export interface Top10ZoneShot extends CategorizedShot {
  zoneIndex: number;
}

export type ZoneCounts = Record<ShotCategory, number>;

function emptyZoneCounts(): ZoneCounts {
  return { offense: 0, defense: 0, out: 0, none: 0, made: 0, no_rim: 0, tie: 0, jump_ball: 0 };
}

export interface CountMismatch {
  zoneIndex: number; // 0-based
  outcome: keyof ExpectedCounts | "no_rim" | "tie" | "jump_ball";
  expected: number;
  got: number;
}

export interface Top10ZonesResult {
  shots: Top10ZoneShot[]; // all 1250 shots, all outcomes
  countsByZone: ZoneCounts[];
  mismatches: CountMismatch[];
}

// Rounded to the grid (angle/aim to 0.5, speed to 0.05) so each shot is
// bit-for-bit the input the original sweep used — avoids float-dust drift
// from repeated +offset arithmetic (e.g. 8.8 - 0.1 landing on 8.699999...).
// The second round (to 1e-6) cleans up the dust Math.round(v/step)*step can
// itself reintroduce for a step like 0.05 that has no exact binary
// representation (e.g. 174*0.05 === 8.700000000000001, not 8.7) — same
// technique scripts/offenseShots.ts's own round() uses.
function roundToStep(v: number, step: number): number {
  return Math.round((Math.round(v / step) * step) * 1e6) / 1e6;
}

// Generator form: yields one shot at a time (1250 total, 10 zones x 125),
// so a caller (the React component) can spread the work across multiple
// animation frames / setTimeout ticks instead of blocking the main thread
// for the whole run in one go. runTop10Zones below (a plain synchronous
// wrapper, used by scripts/tests) just drains this fully in one call.
export function* iterateTop10ZoneShots(heightCm: number, spinRps: number): Generator<Top10ZoneShot, void, void> {
  for (let zoneIndex = 0; zoneIndex < TOP10_ZONES.length; zoneIndex++) {
    const zone = TOP10_ZONES[zoneIndex];
    for (const angleOff of ANGLE_STEP_OFFSETS) {
      const angleDeg = roundToStep(zone.angleDeg + angleOff, 0.5);
      for (const aimOff of AIM_STEP_OFFSETS) {
        const aimDeg = roundToStep(zone.aimDeg + aimOff, 0.5);
        for (const speedOff of SPEED_STEP_OFFSETS) {
          const speedMps = roundToStep(zone.speedMps + speedOff, 0.05);
          const shot = categorizeShot(angleDeg, aimDeg, speedMps, heightCm, spinRps);
          yield { ...shot, zoneIndex };
        }
      }
    }
  }
}

// Tallies per-zone category counts and checks them against the team's
// expected breakdown (the mandatory check) — shared by the synchronous and
// chunked runners so the comparison logic exists in exactly one place.
export function finalizeTop10Zones(shots: Top10ZoneShot[]): { countsByZone: ZoneCounts[]; mismatches: CountMismatch[] } {
  const countsByZone: ZoneCounts[] = TOP10_ZONES.map(() => emptyZoneCounts());
  for (const shot of shots) countsByZone[shot.zoneIndex][shot.category]++;

  const mismatches: CountMismatch[] = [];
  for (let zoneIndex = 0; zoneIndex < TOP10_ZONES.length; zoneIndex++) {
    const got = countsByZone[zoneIndex];
    const exp = EXPECTED_COUNTS[zoneIndex];
    const fields: (keyof ExpectedCounts)[] = ["offense", "defense", "out", "none", "made"];
    for (const f of fields) {
      if (got[f] !== exp[f]) mismatches.push({ zoneIndex, outcome: f, expected: exp[f], got: got[f] });
    }
    for (const f of ["no_rim", "tie", "jump_ball"] as const) {
      if (got[f] !== 0) mismatches.push({ zoneIndex, outcome: f, expected: 0, got: got[f] });
    }
  }

  return { countsByZone, mismatches };
}

// Synchronous, blocking convenience wrapper — fine for a Node script or a
// test, but NOT what the browser UI uses (see iterateTop10ZoneShots above).
export function runTop10Zones(heightCm: number, spinRps: number): Top10ZonesResult {
  const shots = [...iterateTop10ZoneShots(heightCm, spinRps)];
  return { shots, ...finalizeTop10Zones(shots) };
}

export { SHOTS_PER_ZONE };
