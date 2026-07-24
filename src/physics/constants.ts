// Single source of truth for every constant the physics core (core.ts) depends
// on. The rendering layer (FreeThrowSim.tsx) imports the same values for its
// court/rim/backboard geometry so the two can never drift apart — if this file
// changes, both the simulation and what's drawn on screen change together.
//
// All spatial values are plain SI metres. FreeThrowSim.tsx's COURT_SCALE/M()
// helper (a cosmetic render-scale multiplier, currently always 1) is applied
// on top of these when building scene geometry; it must never be used here.
//
// PHASE 1: these are the pre-existing tuning values, ported as-is from the
// original inline implementation in FreeThrowSim.tsx with no behavior change.
// Phase 2 replaces the drag/restitution/rim-collision values with physically
// derived ones (see HEATMAP_SPEC.md) — floor restitution becomes 0.78 (not the
// spec's 0.85, adjusted for the ball-center vs ball-surface measurement
// convention), backboard/rim tube values move to the spec's table, and
// AIR_DRAG_COEFF is replaced by a derived 0.5*rho*Cd*A/m form.

export const GRAVITY_MPS2 = -9.81; // m/s^2, signed — added directly to vertical velocity each step

export const BALL_RADIUS_M = 0.117; // size 6-ish ball, matches the rendered mesh

// Court geometry (FIBA half-court), metres. The rim's floor projection is the
// (x=0, z=0) reference point for every distance below.
export const COURT_WIDTH_M = 15;
export const HALF_COURT_LENGTH_M = 14;
export const BASELINE_TO_RIM_M = 1.575; // baseline to rim-center floor projection (FIBA)
export const BACKBOARD_FROM_BASELINE_M = 1.2; // backboard set in from the baseline
export const LANE_LENGTH_M = 5.8; // baseline to free-throw line

// Free-throw line distance from the rim, derived (not hardcoded) from the two
// baseline distances above: 1.575 - 5.8 = -4.225, i.e. ~4.225 m from the FT
// line to the rim's floor projection. That matches the commonly cited FIBA
// figure for this distance. A different, equally common derivation chain
// (4.57 m backboard-to-FT-line / 15 ft, minus the 0.375 m backboard-to-rim
// offset) nets ~4.19 m instead — both are within the rulebook's own rounding
// tolerance of each other. We keep this derivation since it falls directly out
// of BASELINE_TO_RIM_M and LANE_LENGTH_M, which are independently correct and
// already used for court-line rendering, rather than introducing a third,
// independently-sourced measurement.
export const FT_LINE_Z_M = BASELINE_TO_RIM_M - LANE_LENGTH_M; // negative: behind the rim

export const RIM_HEIGHT_M = 3.05;
export const RIM_RADIUS_M = 0.225; // 45cm inner diameter (FIBA)
export const RIM_TUBE_RADIUS_M = 0.02;
export const BACKBOARD_W_M = 1.8;
export const BACKBOARD_H_M = 1.05;
export const BACKBOARD_Y_ABOVE_RIM_M = 0.375; // backboard center sits this far above rim height

export const FLOOR_RESTITUTION = 0.75;
export const RIM_RESTITUTION = 0.55;
export const BACKBOARD_RESTITUTION = 0.8;
export const AIR_DRAG_COEFF = 0.01; // fudge-factor quadratic drag; Phase 2 replaces with a derived form

// Ball passing cleanly through the hoop opening loses horizontal speed to the
// net — real nets absorb a made shot's forward momentum, which is why swishes
// drop almost straight down instead of sailing on past the rim.
export const NET_DROP_M = 0.4; // matches the drawn net cone height below the rim
export const NET_DRAG_RATE = 40;

export const DEFAULT_BACKSPIN_RPS = 2.5; // used by both single-shot and the sweep until a spin slider exists

// Height at which a rebounder is considered to "catch" the ball after it comes
// off the rim — roughly chest/reach height.
export const CATCH_HEIGHT_M = 1.5;

// Safety bounds so a wild shot can't integrate forever / fly to infinity.
// These are a containment box around the real court (not the real out-of-
// bounds lines — see core.ts for the out_of_bounds outcome, which uses the
// true sideline/baseline/half-court distances instead).
export const WALL_MARGIN_X_M = 0.5;
export const WALL_MARGIN_Z_FAR_M = 1; // beyond the half-court line
export const WALL_MARGIN_Z_NEAR_M = 1.5; // behind the baseline
export const WALL_MAX_HEIGHT_M = 8;

export const SIM_FIXED_DT_S = 0.001; // 1 ms, semi-implicit Euler — never derived from frame timing
export const SIM_MAX_DURATION_S = 15; // hard cap so a non-settling shot can't loop forever
