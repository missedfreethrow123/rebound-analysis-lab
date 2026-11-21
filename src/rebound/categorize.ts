// Shared shot categorisation: the SAME branching scripts/offenseShots.ts
// uses for its own sweep (made / no_rim / jump_ball / offense / defense /
// out / tie / none), factored out here so a browser-side feature (the
// "Top 10 zonas" view) can reuse it without a second copy of the logic and
// without pulling scripts/offenseShots.ts's Node-only imports (fs, path,
// exceljs) into the client bundle. Reuses simulate() and simulateRebound()
// exactly as-is — this module contains no physics or movement logic of its
// own, only the categorisation decision tree built on top of them.
//
// FIBA rules this already encodes (via ShotResult's own fields — see
// core.ts): Art. 44.2.3/31.1.1 (a ball that touches the floor before ever
// touching the rim is a violation → no_rim, even if it grazes the rim
// later — see rimBeforeFloor) and Art. 12.4 (a ball that lodges between the
// ring and backboard is a jump ball, not a rebound — see lodged).

import { simulate, type ShotResult } from "@/physics/core";
import { simulateRebound } from "./movement";
import type { Team } from "./players";

export type ShotCategory = Team | "out" | "tie" | "none" | "made" | "no_rim" | "jump_ball";

export interface CategorizedShot {
  angleDeg: number;
  aimDeg: number;
  speedMps: number;
  category: ShotCategory;
  winnerId: string | null;
  // The point the winning player collects the ball (ball at/below
  // REBOUND_CATCH_HEIGHT_M) — movement.ts's own MovementResult.catchPoint.
  // null unless a player actually won the rebound (offense/defense/tie).
  catchPoint: { x: number; z: number } | null;
  // Where the ball FIRST touches the rim's own centre-line (core.ts's
  // firstRimContact) — present whenever rimContacts > 0, regardless of
  // category (including no_rim shots that grazed the rim after the floor).
  firstRimContact: { x: number; z: number } | null;
}

export function categorizeShot(angleDeg: number, aimDeg: number, speedMps: number, heightCm: number, spinRps: number): CategorizedShot {
  const result: ShotResult = simulate({ heightCm, angleDeg, aimDeg, speed: speedMps, spinRps }, { recordTrajectory: true });

  const firstRimContact = result.firstRimContact ? { x: result.firstRimContact[0], z: result.firstRimContact[1] } : null;

  let category: ShotCategory;
  let winnerId: string | null = null;
  let catchPoint: { x: number; z: number } | null = null;

  if (result.outcome === "made") {
    category = "made";
  } else if (result.rimContacts === 0 || !result.rimBeforeFloor) {
    // No rim contact at all, OR the ball touched the floor before ever
    // touching the rim (FIBA 44.2.3/31.1.1) — a violation, not a valid
    // rim-touching miss, even if the rim is grazed later.
    category = "no_rim";
  } else if (result.lodged) {
    // FIBA 12.4: lodged between ring and backboard — a jump ball, not a
    // rebound. Only reachable with rimBeforeFloor true (the branch above
    // already routed the floor-first case to no_rim).
    category = "jump_ball";
  } else {
    const movement = simulateRebound(result);
    category = movement.winnerTeam;
    winnerId = movement.winnerId;
    catchPoint = movement.catchPoint;
  }

  return { angleDeg, aimDeg, speedMps, category, winnerId, catchPoint, firstRimContact };
}
