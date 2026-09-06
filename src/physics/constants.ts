// Single source of truth for every constant the physics core (core.ts) depends
// on. The rendering layer (FreeThrowSim.tsx) imports the same values for its
// court/rim/backboard geometry so the two can never drift apart — if this file
// changes, both the simulation and what's drawn on screen change together.
//
// All spatial values are plain SI metres. FreeThrowSim.tsx's COURT_SCALE/M()
// helper (a cosmetic render-scale multiplier, currently always 1) is applied
// on top of these when building scene geometry; it must never be used here.
//
// PHASE 2: dynamics constants below (mass, drag, restitution, friction, rim
// tube) now match the physically-derived values from HEATMAP_SPEC.md, with
// one deliberate deviation: FLOOR_RESTITUTION is 0.8, not the spec's 0.85 —
// the spec's 0.85 was derived against a ball-center drop-height convention,
// but this sim (and the "drop from 2.0m, rebound to ~1.45m" style test) uses
// the ball's actual bottom-surface contact height, which needs a lower e to
// reproduce the same real-world rebound fraction. 0.8 is the directly
// measured value for that convention (a real 2.0m drop test); see
// core.test.ts's drop test, which checks the sim reproduces it: e=0.8 gives
// a ~1.28m rebound from a 2.0m drop in vacuum (e^2 * 2.0 = 1.28m), with air
// drag pulling the simulated figure a little under that. Court-geometry
// constants (BASELINE_TO_RIM_M,
// BACKBOARD_FROM_BASELINE_M, LANE_LENGTH_M) are intentionally NOT changed to
// the spec's alternate figures — they already reproduce the standard ~4.225m
// free-throw-line-to-rim distance; see the note below FT_LINE_Z_M.

export const GRAVITY_MPS2 = -9.81; // m/s^2, signed — added directly to vertical velocity each step

export const BALL_MASS_KG = 0.62;
export const BALL_RADIUS_M = 0.12;
// Hollow sphere moment of inertia: I = (2/3) m r^2. A basketball's mass is
// concentrated in its rubber/leather shell, not distributed like a solid
// sphere, so the hollow-sphere formula (not solid sphere's (2/5)mr^2) is the
// right model — this directly sets how much a given friction impulse changes
// spin vs. linear velocity in the rim/backboard/floor collisions below.
export const BALL_INERTIA_KGM2 = (2 / 3) * BALL_MASS_KG * BALL_RADIUS_M * BALL_RADIUS_M;

export const AIR_DENSITY_KGM3 = 1.2;
export const BALL_AREA_M2 = Math.PI * BALL_RADIUS_M * BALL_RADIUS_M;
// Air drag (was F_drag = -0.5*rho*Cd*A*|v|*v, ~13% of the ball's weight at a
// typical 7.5 m/s release) has been removed entirely — flight is now
// drag-free (gravity + Magnus lift only). AIR_DENSITY_KGM3/BALL_AREA_M2 stay,
// since Magnus lift below still uses them.

// F_magnus = 0.5 * rho * Cl * A * |v|^2 * (omega_hat x v_hat), lift
// coefficient Cl = min(0.25, 0.55*S) where S = spin_angular_speed * r / |v|
// is the spin ratio. MAGNUS_ACCEL_COEFF is the constant part of a_magnus =
// MAGNUS_ACCEL_COEFF * Cl * |v|^2 * (omega_hat x v_hat).
export const MAGNUS_ACCEL_COEFF = (0.5 * AIR_DENSITY_KGM3 * BALL_AREA_M2) / BALL_MASS_KG;
export const MAGNUS_LIFT_COEFF_MAX = 0.25;
export const MAGNUS_LIFT_COEFF_SLOPE = 0.55; // Cl = min(MAGNUS_LIFT_COEFF_MAX, MAGNUS_LIFT_COEFF_SLOPE * S)

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
export const RIM_RADIUS_M = 0.2286; // 18in / 45.7cm inner diameter (FIBA/NBA regulation)
export const RIM_TUBE_RADIUS_M = 0.009;
export const BACKBOARD_W_M = 1.8;
export const BACKBOARD_H_M = 1.05;
export const BACKBOARD_Y_ABOVE_RIM_M = 0.375; // backboard center sits this far above rim height

export const FLOOR_RESTITUTION = 0.8; // measured directly (drop test), not the spec's 0.85 — see PHASE 2 note above
export const RIM_RESTITUTION = 0.8; // measured directly, same convention as FLOOR_RESTITUTION — was 0.55
export const BACKBOARD_RESTITUTION = 0.8; // measured directly, same convention as FLOOR_RESTITUTION — was 0.7

export const FRICTION_RIM = 0.4;
export const FRICTION_BACKBOARD = 0.5;
export const FRICTION_FLOOR = 0.5;

// Ball passing cleanly through the hoop opening loses horizontal speed to the
// net — real nets absorb a made shot's forward momentum, which is why swishes
// drop almost straight down instead of sailing on past the rim.
export const NET_DROP_M = 0.4; // matches the drawn net cone height below the rim
export const NET_DRAG_RATE = 40;

// Backspin removed: every shot (single-shot and the sweep, until a spin
// slider exists) now releases with zero spin. The ball can still pick up
// spin later from rim/backboard/floor friction on a contact — that transfer
// mechanism and the Magnus lift it feeds are untouched, only the shooter's
// own release spin was taken out.
export const DEFAULT_BACKSPIN_RPS = 0;

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

// Not in HEATMAP_SPEC.md's constants table — found necessary via testing, not
// planned. Once a ball is rolling without slipping, the Coulomb friction
// impulse in applyContactImpulse converges to ~zero (there's no sliding left
// to dissipate), and nothing else decelerates horizontal motion except
// negligible air drag at these speeds — so a rolling ball could roll for the
// entire SIM_MAX_DURATION_S without settling (observed: up to ~24% of
// realistic shots exceeding 200 floor bounces, ~7% hitting the hard cap).
// Real courts have rolling resistance (floor/ball deformation losses) that
// the pure impulse model doesn't capture. This applies a constant
// deceleration (coefficient * g, a standard rolling-resistance model) to
// horizontal velocity only while the ball is resting on the floor —
// unrelated to and not a replacement for FRICTION_FLOOR, which governs the
// impulse at an actual bounce. 0.025 is a typical real-world rolling
// resistance coefficient for a ball on a hard court.
export const ROLLING_RESISTANCE_COEFF = 0.025;
export const ROLLING_CONTACT_EPSILON_M = 0.002; // how close to the floor counts as "resting on it," not airborne

// Rim collision accuracy: at ~8 m/s and a 1 ms step the ball can move ~8mm per
// step, which is small relative to the ball's own radius but not negligible
// against the thin 9mm rim tube — a fixed 1ms step can resolve a rim contact
// up to a full step late (position snapped back to the surface, but the exact
// contact time/point is approximate). Within RIM_FINE_STEP_MARGIN_M of the
// rim's collision shell, core.ts substeps down to RIM_FINE_DT_S instead.
export const RIM_FINE_STEP_MARGIN_M = 0.05;
export const RIM_FINE_DT_S = 0.0001; // 0.1 ms

// Trajectory sample spacing for animation playback (decimated; the physics
// integration itself always runs at SIM_FIXED_DT_S or finer near the rim).
export const TRAJECTORY_SAMPLE_INTERVAL_S = 0.01;
