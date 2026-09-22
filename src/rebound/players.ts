// Rebound-contest roster: FIBA free-throw rebounding alignment. Positions are
// expressed in the SAME (x, z) system src/physics/core.ts already uses for
// every shot/landing computation — reused here, not re-derived.
//
// IMPORTANT sign-convention note: the spec this was built from described z as
// "distance from the rim into the court" with the shooter at a POSITIVE z
// (e.g. z = +4.225 at the free-throw line). That is backwards for this
// codebase. core.ts's own header comment says it plainly: "the shooter
// releases from negative z ... and shoots toward +z" — confirmed by its
// exported FT_LINE_Z_M = BASELINE_TO_RIM_M - LANE_LENGTH_M = 1.575 - 5.8 =
// -4.225. So here, POSITIVE z is the short ~1.575 m stretch behind the rim
// toward the baseline/backboard, and NEGATIVE z is the playing side, out
// toward the free-throw line and half-court. Every z below is the spec's
// magnitude with the sign flipped to match — the shooter sits at exactly
// FT_LINE_Z_M (-4.225), which is the cross-check that this flip is correct.

export type Team = "offense" | "defense";

export interface Player {
  id: string;
  team: Team;
  x: number;
  z: number;
}

// Colours: offense = green, defense = purple. Defined once, reused by both
// the one-shot contest visualisation and the heat-map winner map/dots.
export const OFFENSE_COLOR = 0x22c55e;
export const DEFENSE_COLOR = 0x8b5cf6;

export const PLAYERS: Player[] = [
  // Defenders — purple. Block spaces nearest the rim.
  { id: "D_L", team: "defense", x: -2.45, z: -0.73 },
  { id: "D_R", team: "defense", x: 2.45, z: -0.73 },

  // Attackers — green. Second spaces + the shooter.
  { id: "O_L", team: "offense", x: -2.45, z: -1.63 },
  { id: "O_R", team: "offense", x: 2.45, z: -1.63 },
  { id: "SHOOTER", team: "offense", x: 0.0, z: -4.225 },

  // Third defender — FIBA allows up to 3 defensive rebounders along the
  // lane; this is the one in the third (outermost) marked space, nearest the
  // free-throw line, on the VISUAL right (see the camera-mirroring note
  // below for why that's x: -2.45, not "D_R"'s own +2.45). z sits ~0.9m
  // further from the basket than the visual-right attacker, between it
  // (-1.63) and the shooter (-4.225).
  //
  // CAMERA-MIRRORING DISCOVERY: the main perspective camera and the
  // orthographic top-down camera both render world +x on the screen's LEFT
  // and -x on the RIGHT (confirmed via pixel-level analysis of rendered
  // screenshots, cross-checked against z-based perspective depth ordering).
  // This is a PRE-EXISTING property of the camera setup, not introduced
  // here — D_L/D_R's own "L"/"R" suffixes have never corresponded to actual
  // screen side; it went unnoticed because the original 4-defender+attacker
  // layout was symmetric. So the disc that's actually VISUALLY on the right
  // is the x: -2.45 one (currently labelled "D_L"/"O_L"), not x: +2.45
  // ("D_R"/"O_R"). Named "D_3" (not "D_R2"/"D_L2") deliberately, to avoid
  // implying a pairing with either mislabeled side.
  { id: "D_3", team: "defense", x: -2.45, z: -2.53 },
];
