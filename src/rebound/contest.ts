// Rebound-contest model: pure logic, no Three.js, no DOM — runs identically
// for a single shot's contest point and inside the heat-map sweep (a Web
// Worker). Reuses the SAME point the heat map already computes (contestPoint
// from src/physics/core.ts's simulate() — the ball's standing-reach catch
// point in the air, not its floor landing; see REBOUND_CATCH_HEIGHT_M and
// contestPoint's own comment there); this module never re-derives flight/
// bounce physics, only decides who reaches that point first.
//
// MOVEMENT PHASE (idealized box-out): supersedes Phase 2's flat delta-t
// handicap (BOXOUT_DELAY_S/startOffsetFor are gone — every attacker's start
// delay is now REACTION_S, same as a defender, except the shooter's own
// extra recovery delay; see startDelayFor). The handicap is no longer a
// uniform time penalty — it's an ELIGIBILITY rule (isAttackerEligible):
// an attacker who is closer to the rim than the ball's landing point is
// considered perfectly boxed out and cannot win that landing at all,
// regardless of speed or distance. Defenders are always eligible. This is
// the IDEALIZED box-out — it does not model which specific defender is
// nearby, a corridor, or a chase; that's for a later phase. Defender→
// attacker PAIRING is computed and stored (see PAIRING) but, as specified,
// doesn't change this phase's numeric result — every attacker is boxed out
// identically regardless of who they're paired with. It exists so a later
// "go-around" phase has it ready.

import { COURT_WIDTH_M, HALF_COURT_LENGTH_M, BASELINE_TO_RIM_M } from "@/physics/constants";
import { PLAYERS, type Team } from "./players";

export const PLAYER_SPEED_MPS = 3.5;
export const REACTION_S = 0.3; // everyone
export const SHOOTER_RECOVERY_S = 0.3; // extra, shooter only — just released the shot

// Per-player start delay from t_rim (the ball's first rim contact). Only the
// shooter is special-cased — every other player (both teams) uses REACTION_S
// alone. Keyed by id rather than team since "the shooter" is a specific
// attacker, not a team-wide rule.
export function startDelayFor(playerId: string): number {
  return playerId === "SHOOTER" ? REACTION_S + SHOOTER_RECOVERY_S : REACTION_S;
}

// Rim's floor projection — (0,0) in this court frame (core.ts: RIM_Z_M = 0,
// and the hoop assembly is always centered on x = 0). Not imported from
// core.ts (which doesn't export it) since it's just the frame's origin.
function distanceToRim(x: number, z: number): number {
  return Math.hypot(x, z);
}

// Idealized box-out eligibility: an attacker can only contest a landing that
// is farther from the rim than they are — a ball that comes down "in front
// of" them (closer to the basket) is one the idealized defense has already
// boxed them off of. Applies identically to all three attackers, including
// the shooter (their eligibility and their start-delay penalty are two
// separate, independent rules — see startDelayFor). Never depends on any
// defender's position: no corridor test, no "is a defender in the way".
export function isAttackerEligible(attacker: { x: number; z: number }, P: { x: number; z: number }): boolean {
  return distanceToRim(P.x, P.z) > distanceToRim(attacker.x, attacker.z);
}

// Defender → attacker pairing (src/rebound/players.ts's fixed roster: 3
// defenders, 3 attackers incl. the shooter), chosen as the 1-to-1 matching
// that minimizes the SUM of the 3 defender→attacker straight-line distances.
// Computed once at module load from the fixed start positions — never
// depends on a landing point — by brute-forcing all 3! = 6 permutations
// (small enough that no matching library is warranted). Stored for a later
// "go-around" phase; this phase's eligibility rule (isAttackerEligible)
// never reads it — see this file's header note.
export interface Pairing {
  defenderId: string;
  attackerId: string;
  distance: number;
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const result: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) result.push([items[i], ...tail]);
  }
  return result;
}

function computePairing(): Pairing[] {
  const defenders = PLAYERS.filter((p) => p.team === "defense");
  const attackers = PLAYERS.filter((p) => p.team === "offense");

  let best: Pairing[] | null = null;
  let bestTotal = Infinity;
  for (const perm of permutations(attackers)) {
    let total = 0;
    const pairing: Pairing[] = [];
    for (let i = 0; i < defenders.length; i++) {
      const d = defenders[i];
      const a = perm[i];
      const distance = Math.hypot(d.x - a.x, d.z - a.z);
      total += distance;
      pairing.push({ defenderId: d.id, attackerId: a.id, distance });
    }
    if (total < bestTotal) {
      bestTotal = total;
      best = pairing;
    }
  }
  return best!;
}

export const PAIRING: Pairing[] = computePairing();

// Same court-bounds derivation core.ts uses internally for its own
// out-of-bounds check (SIDELINE_X_M/BASELINE_Z_M/HALF_COURT_Z_M there are not
// exported, so these are recomputed from the exported constants they're
// themselves derived from — not re-guessed).
const SIDELINE_X_M = COURT_WIDTH_M / 2;
const BASELINE_Z_M = BASELINE_TO_RIM_M;
const HALF_COURT_Z_M = BASELINE_TO_RIM_M - HALF_COURT_LENGTH_M;

export type WinnerTeam = Team | "out" | "tie";

export interface ContestArrival {
  id: string;
  team: Team;
  arrival: number; // seconds from t_rim
  eligible: boolean; // false for a boxed-out attacker (rule 3); always true for a defender
}

export interface ContestResult {
  P: { x: number; z: number };
  winnerTeam: WinnerTeam;
  winnerId: string | null; // null for "out" and "tie"
  // ALL 6 players, each with their own arrival time and eligibility — NOT
  // filtered down to eligible-only or sorted, so a consumer (the one-shot
  // animation) can tell a boxed-out attacker from one who's simply slower.
  // Winner selection below still only ever considers eligible entries.
  arrivals: ContestArrival[];
}

// A landing point outside the court's playing area isn't a real rebound —
// the ball is gone (out of bounds), so there is no contest for it. Mirrors
// core.ts's own out_of_bounds test (same three bounds), just expressed from
// the exported constants since core.ts doesn't export its internal ones.
export function isInboundsLanding(x: number, z: number): boolean {
  return Math.abs(x) <= SIDELINE_X_M && z <= BASELINE_Z_M && z >= HALF_COURT_Z_M;
}

// Single-shot (or single-cell) contest: who gets to the landing point first,
// among players actually eligible for it (rule 3). Closed-form, not a
// frame-by-frame simulation — every player moves at the same PLAYER_SPEED_MPS,
// so arrival time is exact from start delay + straight-line distance.
export function contestLanding(x: number, z: number): ContestResult {
  const P = { x, z };
  if (!isInboundsLanding(x, z)) {
    return { P, winnerTeam: "out", winnerId: null, arrivals: [] };
  }

  const arrivals: ContestArrival[] = PLAYERS.map((p) => {
    const dist = Math.hypot(p.x - x, p.z - z);
    const eligible = p.team === "defense" || isAttackerEligible(p, P);
    return { id: p.id, team: p.team, arrival: startDelayFor(p.id) + dist / PLAYER_SPEED_MPS, eligible };
  });

  // Defenders are always eligible (3 of them), so this is never empty.
  const eligible = arrivals.filter((a) => a.eligible).sort((a, b) => a.arrival - b.arrival);
  const best = eligible[0];
  const second = eligible[1];
  if (second && Math.abs(second.arrival - best.arrival) < 1e-6 && second.team !== best.team) {
    return { P, winnerTeam: "tie", winnerId: null, arrivals };
  }
  return { P, winnerTeam: best.team, winnerId: best.id, arrivals };
}
