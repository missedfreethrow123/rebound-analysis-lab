// Frame-by-frame rebound-contest movement: a replacement for contest.ts's
// closed-form contestLanding() in exactly one place — the single-shot
// playback (src/components/FreeThrowSim.tsx). contestLanding/startDelayFor/
// isAttackerEligible/PAIRING themselves are UNCHANGED and still drive the
// green/purple winner map (src/rebound/winnerField.ts) and the heat-map
// sweep's Offense/Defense split — this module never touches either.
//
// The problem this fixes: contestLanding lets every player run in a straight
// line to the ball's FINAL contest point, which real players can't know in
// advance. Here, every player only ever reacts to where the ball IS right
// now, stepped forward in fixed 5ms increments alongside the ball's own
// trajectory. No player ever reads a future trajectory sample or the ball's
// eventual contest/floor point.
//
// Three phases, in order, per player:
//   1. BOX-OUT (0 <= t < tRim, i.e. before the ball ever touches the rim):
//      each defender walks to a spot exactly touching-distance from their
//      PAIRED attacker, between that attacker and the rim — go-around
//      capable (slideStep — see its own comment), re-aiming at the
//      attacker's current position every step, never predicting where the
//      attacker is headed. The two non-shooter attackers walk straight at
//      the rim, stop at contact, no sliding. The shooter does not move at
//      all (FIBA: can't move until the ball touches the rim).
//   2. REACTION (t >= tRim, before each player's own start time): everyone
//      just stands still exactly where phase 1 left them — lane players for
//      0.3s after the rim, the shooter for 0.6s (FIBA: lane players may move
//      from ball release already passed in phase 1's own clock; what they're
//      actually waiting out here is their own reaction time to the rim hit).
//   3. ATTACKER CHASE + SIDE-SHUFFLE, DEFENDER SYNC (t >= a player's own
//      start time) — see below. Processed in a different order than phases
//      1/2: every step, ALL attackers move first (PLAYERS order), THEN all
//      defenders (PLAYERS order) — so a defender's sync copy reads his
//      attacker's brand-new displacement from the very same step, not last
//      step's.
//
// Collisions apply in every phase: two players' centres never close to less
// than 2*PLAYER_RADIUS_M, and every player's step is checked against every
// other player.
//
// ATTACKER CHASE + SIDE-SHUFFLE (phase 3, O_L/O_R/SHOOTER only) — replaces
// the earlier two models tried here: letting attackers (and, briefly,
// defenders) arc-slide around a blocker on a locked rotational side
// occasionally fell into a sustained mutual-circling deadlock once two
// players' targets nearly coincided (measured: up to 588.7° swept around a
// single blocker in one case). attackerChaseStep() never arcs: every step,
// try the straight line toward the ball's CURRENT floor point B (re-aimed
// every step, never predicted); if that's clear, take it. If a player X
// blocks it, shuffle straight SIDEWAYS instead — perpendicular to the
// attacker→X line, toward whichever side B is actually offset to (by the
// sign of a 2D cross product), capped at the perpendicular distance from B
// to that line (so the shuffle doesn't overshoot past alignment) and at
// ordinary blocked-stop distance against everyone else. If B is (within
// 1cm) already on the attacker→X line, there's no sideways offset to close
// — the attacker just pushes in place this step (zero displacement; still
// "in contact," still an obstacle for anyone else's own collision check).
// No arc, no locked rotational side, no persistent per-player state at all.
//
// DEFENDER SYNC (phase 3, D_L/D_R/D_3 only) — replaces the earlier "defender
// mirrors a point on the attacker's own contact circle" model, which froze:
// once a defender is already touching his attacker (which Phase 1's box-out
// always ends at), ANY new target also on that same circle makes the
// straight chord to it dip fractionally inside the circle, so the ordinary
// stop-at-contact collision math caps the step at exactly zero, forever.
// Defenders here never aim at a point at all while guarding — they simply
// COPY their paired attacker's own just-computed displacement this step
// (same direction, same distance; shortened at contact if copying it would
// overlap someone — the pair can then separate, and this defender keeps
// copying deltas afterwards regardless). This keeps a defender's position
// RELATIVE TO HIS ATTACKER frozen from wherever box-out left it — directly
// in front — without ever needing to aim at a specific point on a circle,
// so the freeze above is structurally impossible: copying a vector is never
// "blocked by the very thing the vector was aimed at." Two sub-phases, by
// ball height, never revisited once past:
//   - SYNC (defender's own reaction end <= t < tCatchable, this shot's first
//     post-tRim moment the ball's height drops to <= standing-reach catch
//     height): copy the paired attacker's delta, as above. D_3's attacker is
//     the shooter, frozen until tRim + SHOOTER_RECOVERY_S on top of
//     REACTION_S — so D_3 (whose own reaction already ended at tRim +
//     REACTION_S) stands still until then too, copying a zero vector.
//   - BALL (t >= tCatchable, permanently): straight at the ball's current
//     floor point, stop at contact — same primitive as phase 1's attackers,
//     no sliding.
// "Stays in front despite the attacker trying to get past", "doesn't retreat
// toward the ball himself", and "if the attacker runs away the defender goes
// with him but can't get in front" are NOT special-cased anywhere below —
// they fall straight out of copying the attacker's own displacement and
// moving by the ordinary blocked-stop primitive.
//
// OUT OF BOUNDS (FIBA Official Basketball Rules 2026, Article 23; see
// isPointOut/isPlayerOut below for the exact boundary + player tests):
// the ball is out only once it touches the floor (or is caught) on or beyond
// a boundary line; merely flying over one while still airborne is NOT out
// (23.1.2 first two bullets), and a player may freely stand out of bounds
// (23.1.1) — it only matters if THAT player is the one who ends up catching
// the ball (23.1.1 again: the ball is out-of-bounds when it touches a player
// who is out of bounds).

import type { ShotResult } from "@/physics/core";
import { REBOUND_CATCH_HEIGHT_M, COURT_WIDTH_M, BASELINE_TO_RIM_M, BALL_RADIUS_M } from "@/physics/constants";
import { PLAYER_SPEED_MPS, REACTION_S, SHOOTER_RECOVERY_S, PAIRING } from "./contest";
import { PLAYERS, PLAYER_RADIUS_M, type Team } from "./players";

const MOVEMENT_DT_S = 0.005; // fixed step
const MOVEMENT_MAX_AFTER_RIM_S = 10; // safety cap — stop looking for a catch this long after the rim
const MIN_SEPARATION_M = 2 * PLAYER_RADIUS_M; // 0.517 m — two players' centres never close nearer than this
const FRAME_STRIDE_STEPS = 2; // store every 2 steps (0.01 s) — see MOVEMENT_DT_S
// Float slack before counting a distance as an actual violation. Two
// players converging on the same point from opposite sides settle into a
// stable equilibrium a fraction of a millimetre short of exactly
// MIN_SEPARATION_M — two independent per-tick collision-cap computations,
// each referencing the other's position from a slightly different instant,
// don't converge to bit-identical results. This is benign numerical
// settling, not drift (confirmed stable across many consecutive ticks, never
// growing): a scan of 4,075 rim-touching shots across the sweep's full
// angle/aim/speed range found a worst case of ~2.4e-4 m (0.24mm). 1e-3 m
// (1mm) gives that a ~4x safety margin — still three orders of magnitude
// tighter than the metres-scale displacement a genuine logic bug in this
// file has produced during development, and far too small to be visible
// against a 0.2585m player radius.
const OVERLAP_EPSILON_M = 1e-3;
const TIE_EPSILON_M = 1e-6; // float slack for "exactly equal" catch distances
const SHUFFLE_PUSH_THRESHOLD_M = 0.01; // ATTACKER CHASE's "lateral offset < 1cm → push in place, don't shuffle"

export interface MovementResult {
  winnerTeam: Team | "tie" | "out" | "none";
  winnerId: string | null;
  // Which FIBA 23.1 rule produced "out" — null unless winnerTeam is "out".
  outReason: "floor" | "player" | null;
  catchTime: number | null; // seconds from release
  catchPoint: { x: number; z: number } | null;
  tRim: number | null;
  playerIds: string[]; // same order as PLAYERS
  frames: Float32Array; // flat [t, x0,z0, x1,z1, ... x5,z5] per stored frame
  overlapViolations: number;
}

function emptyResult(): MovementResult {
  return {
    winnerTeam: "none",
    winnerId: null,
    outReason: null,
    catchTime: null,
    catchPoint: null,
    tRim: null,
    playerIds: PLAYERS.map((p) => p.id),
    frames: new Float32Array(0),
    overlapViolations: 0,
  };
}

// Optional out-param for scripts/scratch verification only (e.g. "each
// attacker's total sideways shuffle distance") — filled in at the same
// moment, with the same values, the shuffle decision itself computes below.
// Does not change MovementResult's own shape.
export interface ShuffleDebug {
  shuffleDistanceById: Record<string, number>;
}

type Vec2 = { x: number; z: number };

function dist2(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

// Ball (x, y, z) at time t, linearly interpolated between the recorded
// trajectory samples (core.ts's flat [t,x,y,z,...]); holds the final
// position after the last sample. `cursor` advances monotonically alongside
// the caller's own monotonically-increasing t, exactly like FreeThrowSim.tsx's
// own playback interpolation — O(1) amortized per call, not a rescan.
function makeBallSampler(trajectory: Float32Array) {
  const sampleCount = trajectory.length / 4;
  let cursor = 0;
  return function ballAt(t: number): { x: number; y: number; z: number } {
    if (sampleCount === 0) return { x: 0, y: 0, z: 0 };
    while (cursor < sampleCount - 2 && trajectory[(cursor + 1) * 4] <= t) cursor++;
    const i0 = cursor * 4;
    const i1 = Math.min(cursor + 1, sampleCount - 1) * 4;
    const t0 = trajectory[i0];
    const t1 = trajectory[i1];
    const segDur = t1 - t0;
    const frac = segDur > 0 ? Math.min(1, Math.max(0, (t - t0) / segDur)) : 1;
    return {
      x: trajectory[i0 + 1] + (trajectory[i1 + 1] - trajectory[i0 + 1]) * frac,
      y: trajectory[i0 + 2] + (trajectory[i1 + 2] - trajectory[i0 + 2]) * frac,
      z: trajectory[i0 + 3] + (trajectory[i1 + 3] - trajectory[i0 + 3]) * frac,
    };
  };
}

// First moment strictly after tRim that the ball's HEIGHT (not an
// interpolated guess — the actual recorded samples) drops to or below
// REBOUND_CATCH_HEIGHT_M, linearly interpolated between the two bracketing
// samples for the crossing instant itself. Infinity if the recorded
// trajectory never does (defenders then stay in SYNC mode for the whole
// simulated window — see DEFENDER SYNC above).
function computeTCatchable(trajectory: Float32Array, tRim: number): number {
  const sampleCount = trajectory.length / 4;
  let prevT: number | null = null;
  let prevY: number | null = null;
  for (let i = 0; i < sampleCount; i++) {
    const t = trajectory[i * 4];
    const y = trajectory[i * 4 + 2];
    if (t > tRim && y <= REBOUND_CATCH_HEIGHT_M) {
      if (prevT !== null && prevY !== null && prevY > REBOUND_CATCH_HEIGHT_M && t > prevT) {
        const frac = (prevY - REBOUND_CATCH_HEIGHT_M) / (prevY - y);
        return prevT + (t - prevT) * frac;
      }
      return t;
    }
    prevT = t;
    prevY = y;
  }
  return Infinity;
}

// How far (starting from `cur`, heading in the unit direction `dir`) you can
// go before your centre closes to exactly MIN_SEPARATION_M from `blocker` —
// Infinity if that never happens while moving forward. Standard
// point-vs-circle ray intersection; `blocker` is a fixed point for the
// purposes of a single step (every player's step this tick is computed
// against positions already settled earlier this same tick).
function maxStepBeforeCollision(cur: Vec2, dir: Vec2, blocker: Vec2): number {
  const relX = cur.x - blocker.x;
  const relZ = cur.z - blocker.z;
  const b = relX * dir.x + relZ * dir.z;
  const c = relX * relX + relZ * relZ - MIN_SEPARATION_M * MIN_SEPARATION_M;
  // Already (incorrectly) overlapping this blocker — the invariant
  // maintained below should prevent this; defensively refuse to close the
  // gap further rather than risk pushing deeper in.
  if (c < 0) return 0;
  // b = how much `dir` currently points FROM the blocker toward `cur`. b>=0
  // means this step heads away from (or tangent to) the blocker, so it can
  // never approach it further — no cap. Deciding this from b's sign, not
  // the resulting root's sign, matters right at contact: when the mover is
  // already exactly on the MIN_SEPARATION_M boundary (c===0) and heading
  // toward the blocker, the correct cap is exactly 0 (fully blocked right
  // now) — `root > 0 ? root : Infinity` would wrongly read that 0 as "no
  // collision" and let a fully-blocked mover take an unblocked step.
  if (b >= 0) return Infinity;
  const disc = b * b - c;
  if (disc < 0) return Infinity; // ray never reaches MIN_SEPARATION_M of this blocker
  // Stable quadratic solve for the smaller (first-contact) root. The naive
  // "-b - sqrt(disc)" form catastrophically cancels whenever the mover
  // starts almost exactly on the boundary (|b| ~ sqrt(disc)) — routine right
  // as two players reach touching distance — so compute it via the
  // numerically stable c / (-b + sqrt(disc)) instead (denominator is a sum
  // of two non-negatives here, since b < 0, so it's always well-conditioned
  // and strictly positive).
  return c / (-b + Math.sqrt(disc));
}

// ---------------------------------------------------------------------------
// OUT OF BOUNDS — FIBA Official Basketball Rules 2026, Article 23 (p. 29).
// Same recompute-from-exported-constants pattern contest.ts's own
// isInboundsLanding uses (core.ts's internal SIDELINE_X_M etc. aren't
// exported, so these are rebuilt from the constants they themselves derive
// from — not re-guessed). Deliberately NOT the same test as
// isInboundsLanding: 23.1 only the two sidelines and the endline BEHIND the
// basket are boundaries here — the half-court line is not (the court
// continues into the backcourt, same lane players can be shown chasing a
// long rebound there) — whereas isInboundsLanding (still used, unmodified,
// by contest.ts's OLD model) also treats the half-court line as a bound.
// ---------------------------------------------------------------------------
const SIDELINE_X_M = COURT_WIDTH_M / 2;
const ENDLINE_Z_M = BASELINE_TO_RIM_M;

// 23.1.2 / 2.5.1: a boundary line itself is out, not part of the court — "=" counts.
function isPointOut(x: number, z: number): boolean {
  return Math.abs(x) >= SIDELINE_X_M || z >= ENDLINE_Z_M;
}

// 23.1.1: a player is out-of-bounds when ANY part of him touches the floor
// on or beyond a boundary line — modelled as any part of his collision
// circle crossing it.
function isPlayerOut(p: Vec2): boolean {
  return Math.abs(p.x) + PLAYER_RADIUS_M >= SIDELINE_X_M || p.z + PLAYER_RADIUS_M >= ENDLINE_Z_M;
}

// 23.1.2 (first bullet): the ball is out-of-bounds the moment it touches the
// floor on or beyond a boundary line — but NOT merely for flying over one
// while still airborne (an inbounds player may still catch it; see this
// file's header). Scans the actual recorded trajectory SAMPLES in
// (tPrev, tNow], not makeBallSampler's interpolated position for an
// arbitrary t: core.ts always records a collision moment as an exact
// sample (never decimated away), so a bounce landing out of bounds between
// two 5ms simulation ticks must still be caught here — interpolating
// between the surrounding samples could land the reported (x,z) at that
// instant slightly inboard of where the ball actually touched.
function makeFloorOutOfBoundsScanner(trajectory: Float32Array) {
  const sampleCount = trajectory.length / 4;
  const FLOOR_TOUCH_Y = BALL_RADIUS_M + 0.001;
  let cursor = 0;
  return function scanFloorOutOfBounds(tPrev: number, tNow: number): boolean {
    let touchedOut = false;
    while (cursor < sampleCount) {
      const st = trajectory[cursor * 4];
      if (st > tNow) break;
      if (st > tPrev) {
        const sy = trajectory[cursor * 4 + 2];
        if (sy <= FLOOR_TOUCH_Y) {
          const sx = trajectory[cursor * 4 + 1];
          const sz = trajectory[cursor * 4 + 3];
          if (isPointOut(sx, sz)) touchedOut = true;
        }
      }
      cursor++;
    }
    return touchedOut;
  };
}

// Moves `cur` toward `target` at up to `maxDist` this step (never overshoots
// the target), shortened if needed so every blocker in `blockers` stays at
// least MIN_SEPARATION_M away. No sliding/routing around a blocker — a
// blocked player simply stops at contact. Used by: attackerBoxoutStep
// (phase 1), defenderSyncStep (copying a delta is "move toward cur+delta,
// capped at |delta|"), and defenderChaseStep's BALL mode.
function moveToward(cur: Vec2, target: Vec2, maxDist: number, blockers: Vec2[]): Vec2 {
  const dx = target.x - cur.x;
  const dz = target.z - cur.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-9) return { x: cur.x, z: cur.z };
  const dir: Vec2 = { x: dx / dist, z: dz / dist };
  let stepLen = Math.min(maxDist, dist);
  for (const b of blockers) {
    const cap = maxStepBeforeCollision(cur, dir, b);
    if (cap < stepLen) stepLen = cap;
  }
  stepLen = Math.max(0, stepLen);
  return { x: cur.x + dir.x * stepLen, z: cur.z + dir.z * stepLen };
}

function pairedAttackerId(defenderId: string): string {
  return PAIRING.find((p) => p.defenderId === defenderId)!.attackerId;
}

// Defender's box-out target: the point exactly MIN_SEPARATION_M from the
// paired attacker's CURRENT centre, on the line toward the rim (0,0) — i.e.
// touching distance, between the attacker and the basket. Phase 1 only.
function defenderBoxoutTarget(attackerPos: Vec2): Vec2 {
  const dx = -attackerPos.x;
  const dz = -attackerPos.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-9) return { x: attackerPos.x, z: attackerPos.z };
  return { x: attackerPos.x + (dx / dist) * MIN_SEPARATION_M, z: attackerPos.z + (dz / dist) * MIN_SEPARATION_M };
}

// ---------------------------------------------------------------------------
// GO-AROUND (sliding) — PHASE 1 DEFENDERS ONLY now (box-out). Phase 3 no
// longer uses this for anyone — see this file's header for why (the
// mutual-circling deadlock) and what replaced it (ATTACKER CHASE +
// SIDE-SHUFFLE, DEFENDER SYNC).
// ---------------------------------------------------------------------------
interface SlideState {
  blockerIdx: number | null;
  side: 1 | -1 | null; // +1 = CCW, -1 = CW (about the blocker's centre)
}
function freshSlideState(): SlideState {
  return { blockerIdx: null, side: null };
}

function angleOf(center: Vec2, p: Vec2): number {
  return Math.atan2(p.z - center.z, p.x - center.x);
}
function pointOnCircle(center: Vec2, radius: number, angle: number): Vec2 {
  return { x: center.x + radius * Math.cos(angle), z: center.z + radius * Math.sin(angle) };
}
// Smallest non-negative angle swept going CCW (increasing angle) from `from`
// to `to`, in [0, 2*PI).
function ccwDelta(from: number, to: number): number {
  const twoPi = Math.PI * 2;
  let d = (to - from) % twoPi;
  if (d < 0) d += twoPi;
  return d;
}

// One-time decision (made exactly at first contact with `blocker`, then
// locked until release — see moveWithSliding): of the two ways around the
// blocker's contact circle, which is shorter overall? For each rotational
// direction, find the tangent line from `target` to the circle that's
// reached FIRST going that way from `cur`, and sum the arc length to it plus
// the straight distance from there to `target`. Pick the smaller total.
function chooseSlideSide(cur: Vec2, center: Vec2, target: Vec2): 1 | -1 {
  const R = MIN_SEPARATION_M;
  const toTarget = { x: target.x - center.x, z: target.z - center.z };
  const d = Math.hypot(toTarget.x, toTarget.z);
  const thetaCur = angleOf(center, cur);

  // `target` sits AT or INSIDE the blocker's own contact circle — not a rare
  // edge case: a defender's box-out target is BY CONSTRUCTION exactly
  // MIN_SEPARATION_M from its own paired attacker (defenderBoxoutTarget), so
  // whenever that attacker is also the blocker being slid around (the usual
  // case), d is always ~R, never meaningfully greater. There's no external
  // tangent line here — the target point itself IS the only point "reached"
  // on the circle, so the choice is simply the shorter arc straight to its
  // own angular position (zero leftover straight segment either way).
  if (d <= R) {
    if (d < 1e-9) return 1; // truly degenerate (target exactly at the blocker's centre) — arbitrary but deterministic
    const thetaTarget = Math.atan2(toTarget.z, toTarget.x);
    const ccwTotal = ccwDelta(thetaCur, thetaTarget) * R;
    const cwTotal = ccwDelta(thetaTarget, thetaCur) * R;
    return ccwTotal <= cwTotal ? 1 : -1;
  }

  const alpha = Math.acos(R / d);
  const thetaV = Math.atan2(toTarget.z, toTarget.x);
  const theta1 = thetaV + alpha;
  const theta2 = thetaV - alpha;

  const d1ccw = ccwDelta(thetaCur, theta1);
  const d2ccw = ccwDelta(thetaCur, theta2);
  const ccwTheta = d1ccw <= d2ccw ? theta1 : theta2;
  const ccwArc = Math.min(d1ccw, d2ccw) * R;
  const ccwTangent = pointOnCircle(center, R, ccwTheta);
  const ccwTotal = ccwArc + Math.hypot(target.x - ccwTangent.x, target.z - ccwTangent.z);

  // Going CW from cur is the same as going CCW from -cur's perspective —
  // equivalently, the CW delta to theta_i is ccwDelta(theta_i, thetaCur).
  const d1cw = ccwDelta(theta1, thetaCur);
  const d2cw = ccwDelta(theta2, thetaCur);
  const cwTheta = d1cw <= d2cw ? theta1 : theta2;
  const cwArc = Math.min(d1cw, d2cw) * R;
  const cwTangent = pointOnCircle(center, R, cwTheta);
  const cwTotal = cwArc + Math.hypot(target.x - cwTangent.x, target.z - cwTangent.z);

  return ccwTotal <= cwTotal ? 1 : -1;
}

// The shared sliding primitive (PHASE 1 DEFENDERS ONLY now): moves `cur`
// along the contact circle (centre = blocker, radius = MIN_SEPARATION_M) by
// up to `maxDist` of arc, in the locked `side` direction. Steps along the
// tangent at the current angle, then re-projects back onto the circle, so
// centre distance from `blocker` stays exactly MIN_SEPARATION_M every step
// (never drifts in or out). If the tangent step would bring `cur` within
// MIN_SEPARATION_M of a DIFFERENT player in `otherBlockerIdx`/`pos`, the
// step is shortened (the short tangent segment is treated as its own chord
// for this check — accurate to O(step^2), negligible at this step's actual
// size) to the first such contact, and that player's index is returned as
// `interruptedBy` so the caller can switch the lock to them.
function slideStep(
  cur: Vec2,
  blocker: Vec2,
  side: 1 | -1,
  maxDist: number,
  otherBlockerIdx: number[],
  pos: Vec2[],
): { pos: Vec2; interruptedBy: number | null } {
  const R = MIN_SEPARATION_M;
  const radial = { x: cur.x - blocker.x, z: cur.z - blocker.z };
  const radialLen = Math.hypot(radial.x, radial.z) || R;
  const radialUnit = { x: radial.x / radialLen, z: radial.z / radialLen };
  // Tangent direction: +90 deg from the radial for CCW (side=1), -90 deg for CW (side=-1).
  const tangent: Vec2 = side === 1 ? { x: -radialUnit.z, z: radialUnit.x } : { x: radialUnit.z, z: -radialUnit.x };

  const rawX = cur.x + tangent.x * maxDist;
  const rawZ = cur.z + tangent.z * maxDist;
  const toRaw = { x: rawX - blocker.x, z: rawZ - blocker.z };
  const toRawLen = Math.hypot(toRaw.x, toRaw.z) || R;
  let newPos: Vec2 = { x: blocker.x + (toRaw.x / toRawLen) * R, z: blocker.z + (toRaw.z / toRawLen) * R };

  let interruptedBy: number | null = null;
  const chordX = newPos.x - cur.x;
  const chordZ = newPos.z - cur.z;
  const chordLen = Math.hypot(chordX, chordZ);
  if (chordLen > 1e-9) {
    const dir: Vec2 = { x: chordX / chordLen, z: chordZ / chordLen };
    let bestFrac = 1;
    let bestIdx: number | null = null;
    for (const idx of otherBlockerIdx) {
      const cap = maxStepBeforeCollision(cur, dir, pos[idx]);
      if (cap < chordLen) {
        const frac = Math.max(0, cap / chordLen);
        if (frac < bestFrac) {
          bestFrac = frac;
          bestIdx = idx;
        }
      }
    }
    if (bestIdx !== null) {
      newPos = { x: cur.x + dir.x * chordLen * bestFrac, z: cur.z + dir.z * chordLen * bestFrac };
      interruptedBy = bestIdx;
    }
  }
  return { pos: newPos, interruptedBy };
}

// Shared orchestration for the one remaining go-around call site (PHASE 1
// DEFENDERS). EVERY step, first checks whether a straight line at `target`
// (up to this step's distance) is clear of EVERYONE in `blockerIdx` — not
// just whatever's currently locked. This single check does double duty:
// it's the normal "try a direct step" path when nothing is locked, AND it's
// the release condition for an active lock (checking against everyone, not
// only the locked blocker, is a strictly stronger and more robust release
// test — relying on just the locked blocker's own near-tangent math is
// numerically fragile exactly when, as is typical here, `target` sits ON
// that blocker's own circle, so the "clear" segment to it is vanishingly
// short). If something blocks: already locked onto that same thing → keep
// sliding, side unchanged; otherwise (freshly blocked, or blocked by someone
// new) → lock onto it and choose a side now.
function moveWithSliding(
  cur: Vec2,
  target: Vec2,
  maxDist: number,
  blockerIdx: number[],
  pos: Vec2[],
  slideState: SlideState,
): Vec2 {
  const dx = target.x - cur.x;
  const dz = target.z - cur.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-9) {
    slideState.blockerIdx = null;
    slideState.side = null;
    return { x: cur.x, z: cur.z };
  }
  const dir: Vec2 = { x: dx / dist, z: dz / dist };
  const desired = Math.min(maxDist, dist);

  let minCap = Infinity;
  let blockingIdx: number | null = null;
  for (const i of blockerIdx) {
    const cap = maxStepBeforeCollision(cur, dir, pos[i]);
    if (cap < minCap) {
      minCap = cap;
      blockingIdx = i;
    }
  }

  if (blockingIdx === null || minCap >= desired) {
    // Clear (or we reach the target before touching anyone) — go straight,
    // released from any prior lock.
    slideState.blockerIdx = null;
    slideState.side = null;
    const stepLen = Math.max(0, desired);
    return { x: cur.x + dir.x * stepLen, z: cur.z + dir.z * stepLen };
  }

  // The straight chord to `target` can be "blocked" by the very blocker
  // `target` sits on top of — a defender's box-out target is always exactly
  // MIN_SEPARATION_M from the attacker it's walking toward
  // (defenderBoxoutTarget), and a chord between two points that are BOTH on
  // the same circle always lies on/inside it, for every point in between,
  // right up to (not just near) the endpoints. That's not a real
  // obstruction — it's what "arrive exactly at touching distance" looks
  // like — so once the target is within this step's reach, finish the
  // approach directly rather than sliding further, as long as nothing ELSE
  // (any blocker other than the one `target` is touching) is actually in
  // the way.
  if (dist <= maxDist && Math.abs(dist2(target, pos[blockingIdx]) - MIN_SEPARATION_M) < 1e-6) {
    let clearOfEveryoneElse = true;
    for (const i of blockerIdx) {
      if (i === blockingIdx) continue;
      if (maxStepBeforeCollision(cur, dir, pos[i]) < dist) {
        clearOfEveryoneElse = false;
        break;
      }
    }
    if (clearOfEveryoneElse) {
      slideState.blockerIdx = null;
      slideState.side = null;
      return { x: target.x, z: target.z };
    }
  }

  if (slideState.blockerIdx === blockingIdx) {
    // Still blocked by the SAME locked blocker — keep sliding, side unchanged.
    const others = blockerIdx.filter((i) => i !== blockingIdx);
    const { pos: newPos, interruptedBy } = slideStep(cur, pos[blockingIdx], slideState.side!, maxDist, others, pos);
    if (interruptedBy !== null) {
      slideState.blockerIdx = interruptedBy;
      slideState.side = chooseSlideSide(newPos, pos[interruptedBy], target);
    }
    return newPos;
  }

  // Newly blocked (first contact, or blocked by someone different from
  // whatever was locked before) — lock onto `blockingIdx` and choose a side
  // now, using whatever step distance remains after reaching contact.
  const contactLen = Math.max(0, minCap);
  const contactPos: Vec2 = { x: cur.x + dir.x * contactLen, z: cur.z + dir.z * contactLen };

  // The "block" and "arrival" can coincide: a defender's box-out target
  // always sits exactly MIN_SEPARATION_M from the attacker it's walking
  // toward (defenderBoxoutTarget), so the straight approach's collision cap
  // and the target itself are frequently (within float noise) the SAME
  // point. Without this check, the leftover step budget (maxDist minus the
  // tiny contactLen) would get spent sliding further around the blocker
  // we've already arrived next to, for no reason. Stop here instead.
  if (Math.hypot(target.x - contactPos.x, target.z - contactPos.z) < 1e-6) {
    slideState.blockerIdx = null;
    slideState.side = null;
    return contactPos;
  }

  slideState.blockerIdx = blockingIdx;
  slideState.side = chooseSlideSide(contactPos, pos[blockingIdx], target);
  const remaining = maxDist - contactLen;
  if (remaining <= 0) return contactPos;

  const others = blockerIdx.filter((i) => i !== blockingIdx);
  const { pos: newPos, interruptedBy } = slideStep(contactPos, pos[blockingIdx], slideState.side, remaining, others, pos);
  if (interruptedBy !== null) {
    slideState.blockerIdx = interruptedBy;
    slideState.side = chooseSlideSide(newPos, pos[interruptedBy], target);
  }
  return newPos;
}

// ATTACKERS O_L/O_R, phase 1: walk straight at the rim, stop at contact, no
// sliding.
function attackerBoxoutStep(cur: Vec2, blockers: Vec2[]): Vec2 {
  return moveToward(cur, { x: 0, z: 0 }, PLAYER_SPEED_MPS * MOVEMENT_DT_S, blockers);
}

// DEFENDERS, phase 1: go-around capable — see moveWithSliding.
function defenderBoxoutStep(cur: Vec2, attackerPos: Vec2, blockerIdx: number[], pos: Vec2[], slideState: SlideState): Vec2 {
  return moveWithSliding(cur, defenderBoxoutTarget(attackerPos), PLAYER_SPEED_MPS * MOVEMENT_DT_S, blockerIdx, pos, slideState);
}

// ATTACKERS O_L/O_R/SHOOTER, phase 3 — see this file's header (ATTACKER
// CHASE + SIDE-SHUFFLE). Never slides/arcs. Returns both the resulting
// position AND the actual displacement this step (`delta`) — paired
// defenders in the SAME tick copy exactly this vector (see DEFENDER SYNC).
function attackerChaseStep(
  cur: Vec2,
  ballXZ: Vec2,
  blockerIdx: number[],
  pos: Vec2[],
): { pos: Vec2; delta: Vec2; shuffleDist: number } {
  const maxDist = PLAYER_SPEED_MPS * MOVEMENT_DT_S;
  const dx = ballXZ.x - cur.x;
  const dz = ballXZ.z - cur.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-9) return { pos: { x: cur.x, z: cur.z }, delta: { x: 0, z: 0 }, shuffleDist: 0 }; // already standing on B

  const dir: Vec2 = { x: dx / dist, z: dz / dist };
  const desired = Math.min(maxDist, dist);

  let minCap = Infinity;
  let blockingIdx: number | null = null;
  for (const i of blockerIdx) {
    const cap = maxStepBeforeCollision(cur, dir, pos[i]);
    if (cap < minCap) {
      minCap = cap;
      blockingIdx = i;
    }
  }

  if (blockingIdx === null || minCap >= desired) {
    // Clear path straight at B.
    const newPos: Vec2 = { x: cur.x + dir.x * desired, z: cur.z + dir.z * desired };
    return { pos: newPos, delta: { x: newPos.x - cur.x, z: newPos.z - cur.z }, shuffleDist: 0 };
  }

  // Blocked by X = pos[blockingIdx] — shuffle sideways instead of stopping.
  const X = pos[blockingIdx];
  const toX: Vec2 = { x: X.x - cur.x, z: X.z - cur.z }; // attacker -> X
  const toB: Vec2 = { x: ballXZ.x - cur.x, z: ballXZ.z - cur.z }; // attacker -> B
  const toXLen = Math.hypot(toX.x, toX.z);
  // 2D cross product (z-component, treating (x,z) as the plane): its sign
  // says which side of the attacker->X line B is on; its magnitude divided
  // by |toX| is B's perpendicular distance from that line (the "lateral
  // offset" to close).
  const cross = toX.x * toB.z - toX.z * toB.x;
  const lateralOffset = toXLen > 1e-9 ? Math.abs(cross) / toXLen : 0;

  if (lateralOffset < SHUFFLE_PUSH_THRESHOLD_M) {
    // B is (within 1cm) already on the attacker->X line — no sideways
    // offset to close. Push in place: zero displacement this step, but
    // still "in contact" for everyone else's own collision check.
    return { pos: { x: cur.x, z: cur.z }, delta: { x: 0, z: 0 }, shuffleDist: 0 };
  }

  // Perpendicular to toX, rotated toward whichever side B is actually on.
  const l: Vec2 =
    cross > 0 ? { x: -toX.z / toXLen, z: toX.x / toXLen } : { x: toX.z / toXLen, z: -toX.x / toXLen };

  // The shuffle direction `l` is, by construction, tangent to X's own
  // contact circle at `cur`'s CURRENT position on it — exactly like
  // slideStep's own tangent step (see that function's comment), this is
  // numerically fragile against X specifically: `cur` sits at (within float
  // noise) exactly MIN_SEPARATION_M from X already, so the ordinary
  // ray-vs-circle cap check, which is sensitive to that exact boundary,
  // returns a cap of 0 against X almost every time (float residual in the
  // "tangent" direction reads as "already closing the gap") — freezing the
  // shuffle completely, the very same degeneracy an earlier version of this
  // file hit by aiming a non-sliding step at a point on a blocker's own
  // circle. Checked against everyone ELSE, same as slideStep's
  // otherBlockerIdx.
  const shuffleDesired = Math.min(maxDist, lateralOffset); // "do not overshoot zero lateral offset"
  let shuffleCap = shuffleDesired;
  for (const i of blockerIdx) {
    if (i === blockingIdx) continue;
    const cap = maxStepBeforeCollision(cur, l, pos[i]);
    if (cap < shuffleCap) shuffleCap = cap;
  }
  shuffleCap = Math.max(0, shuffleCap);
  const newPos: Vec2 = { x: cur.x + l.x * shuffleCap, z: cur.z + l.z * shuffleCap };
  return { pos: newPos, delta: { x: newPos.x - cur.x, z: newPos.z - cur.z }, shuffleDist: shuffleCap };
}

// DEFENDERS, phase 3, SYNC mode (own reaction end <= t < tCatchable) — see
// this file's header. Moves `cur` by exactly `delta` (the paired attacker's
// own just-computed displacement this same step), shortened at contact if
// that would overlap someone. `moveToward` toward cur+delta, capped at
// exactly |delta|, does precisely this — "move by this vector, capped at
// collision" is the same operation as "move toward this point, capped at
// collision" when the cap distance equals the vector's own length.
function defenderSyncStep(cur: Vec2, delta: Vec2, blockers: Vec2[]): Vec2 {
  const dist = Math.hypot(delta.x, delta.z);
  if (dist < 1e-9) return { x: cur.x, z: cur.z };
  const target: Vec2 = { x: cur.x + delta.x, z: cur.z + delta.z };
  return moveToward(cur, target, dist, blockers);
}

// DEFENDERS, phase 3, BALL mode (t >= tCatchable, permanently) — see this
// file's header. Straight at the ball's current floor point, stop at
// contact, never slides/arcs.
function defenderChaseStep(cur: Vec2, ballXZ: Vec2, blockers: Vec2[]): Vec2 {
  return moveToward(cur, ballXZ, PLAYER_SPEED_MPS * MOVEMENT_DT_S, blockers);
}

function startTimeFor(playerId: string, tRim: number): number {
  return playerId === "SHOOTER" ? tRim + REACTION_S + SHOOTER_RECOVERY_S : tRim + REACTION_S;
}

export function simulateRebound(result: ShotResult, debugOut?: ShuffleDebug): MovementResult {
  if (debugOut) {
    for (const p of PLAYERS) debugOut.shuffleDistanceById[p.id] = 0;
  }
  if (result.rimContacts === 0 || result.outcome === "made" || result.firstRimContactTime === null) {
    return emptyResult();
  }
  const tRim = result.firstRimContactTime;
  const ballAt = makeBallSampler(result.trajectory);
  const tCatchable = computeTCatchable(result.trajectory, tRim);

  const pos: Vec2[] = PLAYERS.map((p) => ({ x: p.x, z: p.z }));
  const idToIndex = new Map(PLAYERS.map((p, i) => [p.id, i]));
  const defenderIdx = PLAYERS.map((p, i) => (p.team === "defense" ? i : -1)).filter((i) => i >= 0);
  const attackerIdx = PLAYERS.map((p, i) => (p.team === "offense" ? i : -1)).filter((i) => i >= 0);
  // Phase 1 (box-out): defenders first, then attackers (PLAYERS order within
  // each group) — unchanged from before.
  const phase1Order = [...defenderIdx, ...attackerIdx];

  const otherPositions = (idx: number, pool: number[]): Vec2[] => pool.filter((i) => i !== idx).map((i) => pos[i]);
  const allOtherPositions = (idx: number): Vec2[] => otherPositions(idx, [...defenderIdx, ...attackerIdx]);
  const allOtherIdx = (idx: number): number[] => [...defenderIdx, ...attackerIdx].filter((i) => i !== idx);

  // One slide lock per DEFENDER only now (phase 1 box-out) — see this file's
  // GO-AROUND header comment. Attackers never slide any more (any phase), so
  // their slots here are allocated but never touched.
  const slideStates: SlideState[] = PLAYERS.map(() => freshSlideState());

  // DEFENDER SYNC's per-tick read of "my paired attacker's displacement this
  // same step" — reset to zero at the top of every tick, filled in by the
  // attacker loop (which always runs first), read by the defender loop
  // right after. See this file's header.
  const attackerDeltaThisStep: Vec2[] = PLAYERS.map(() => ({ x: 0, z: 0 }));

  const scanFloorOutOfBounds = makeFloorOutOfBoundsScanner(result.trajectory);

  const frames: number[] = [];
  const pushFrame = (t: number) => {
    frames.push(t);
    for (const p of pos) frames.push(p.x, p.z);
  };
  pushFrame(0); // initial positions, before any movement

  let overlapViolations = 0;
  const tallyOverlaps = () => {
    for (let i = 0; i < PLAYERS.length; i++) {
      for (let j = i + 1; j < PLAYERS.length; j++) {
        if (dist2(pos[i], pos[j]) < MIN_SEPARATION_M - OVERLAP_EPSILON_M) overlapViolations++;
      }
    }
  };

  const maxT = tRim + MOVEMENT_MAX_AFTER_RIM_S;
  let winnerTeam: MovementResult["winnerTeam"] = "none";
  let winnerId: string | null = null;
  let outReason: "floor" | "player" | null = null;
  let catchTime: number | null = null;
  let catchPoint: { x: number; z: number } | null = null;

  let step = 0;
  let decided = false;
  while (true) {
    step++;
    const t = step * MOVEMENT_DT_S;

    if (t < tRim) {
      // PHASE 1 — box-out.
      for (const idx of phase1Order) {
        const player = PLAYERS[idx];
        if (player.id === "SHOOTER") continue; // doesn't move until the rim is touched
        if (player.team === "defense") {
          const attackerPos = pos[idToIndex.get(pairedAttackerId(player.id))!];
          pos[idx] = defenderBoxoutStep(pos[idx], attackerPos, allOtherIdx(idx), pos, slideStates[idx]);
        } else {
          pos[idx] = attackerBoxoutStep(pos[idx], allOtherPositions(idx));
        }
      }
    } else {
      // PHASE 2 (reaction, implicit below) / PHASE 3: ALL attackers move
      // first (chase + side-shuffle), THEN all defenders (sync copy / ball
      // chase) — so a defender's sync copy reads his attacker's brand-new
      // displacement from this very step. See this file's header.
      for (const idx of attackerIdx) {
        attackerDeltaThisStep[idx] = { x: 0, z: 0 }; // reset every tick; stays zero if still reacting
      }
      for (const idx of attackerIdx) {
        const player = PLAYERS[idx];
        const myChaseStart = startTimeFor(player.id, tRim);
        if (t < myChaseStart) continue; // still reacting — stay put, delta stays 0
        const ball = ballAt(t);
        const { pos: newPos, delta, shuffleDist } = attackerChaseStep(pos[idx], { x: ball.x, z: ball.z }, allOtherIdx(idx), pos);
        pos[idx] = newPos;
        attackerDeltaThisStep[idx] = delta;
        if (debugOut) debugOut.shuffleDistanceById[player.id] += shuffleDist;
      }
      for (const idx of defenderIdx) {
        const player = PLAYERS[idx];
        const myChaseStart = startTimeFor(player.id, tRim); // always tRim + REACTION_S — never SHOOTER
        if (t < myChaseStart) continue; // still reacting — stay put

        if (t < tCatchable) {
          const attackerPlayerIdx = idToIndex.get(pairedAttackerId(player.id))!;
          const delta = attackerDeltaThisStep[attackerPlayerIdx];
          pos[idx] = defenderSyncStep(pos[idx], delta, allOtherPositions(idx));
        } else {
          const ball = ballAt(t);
          pos[idx] = defenderChaseStep(pos[idx], { x: ball.x, z: ball.z }, allOtherPositions(idx));
        }
      }
    }

    tallyOverlaps();

    if (t > tRim) {
      // RULE 1 (FIBA 23.1.2, first bullet): the ball is out-of-bounds the
      // moment it touches the floor on or beyond a boundary line — checked
      // against the actual trajectory samples this step covers, not the
      // interpolated position (see makeFloorOutOfBoundsScanner).
      if (scanFloorOutOfBounds(t - MOVEMENT_DT_S, t)) {
        winnerTeam = "out";
        outReason = "floor";
        decided = true;
      } else {
        const ball = ballAt(t);
        if (ball.y <= REBOUND_CATCH_HEIGHT_M) {
          const candidates = PLAYERS.map((p, i) => ({ i, dist: dist2(pos[i], { x: ball.x, z: ball.z }) })).filter(
            (c) => c.dist <= PLAYER_RADIUS_M,
          );
          if (candidates.length > 0) {
            candidates.sort((a, b) => a.dist - b.dist); // stable: ties keep PLAYERS order
            const minDist = candidates[0].dist;
            const tiedAtMin = candidates.filter((c) => Math.abs(c.dist - minDist) < TIE_EPSILON_M);
            const teamsAtMin = new Set(tiedAtMin.map((c) => PLAYERS[c.i].team));
            if (teamsAtMin.size > 1) {
              winnerTeam = "tie";
              winnerId = null;
              catchTime = t;
              catchPoint = { x: ball.x, z: ball.z };
            } else {
              const winnerIdx = candidates[0].i;
              // RULE 2 (FIBA 23.1.1): the ball is also out-of-bounds if the
              // first (nearest) player to satisfy the catch condition is
              // himself standing out of bounds when he takes it — no
              // eligibility ban otherwise, so this is the only thing that
              // can turn an otherwise-valid catch into "out" here.
              if (isPlayerOut(pos[winnerIdx])) {
                winnerTeam = "out";
                outReason = "player";
                winnerId = null;
                // No catchTime/catchPoint — same as the floor case above,
                // this was never a valid catch.
              } else {
                winnerTeam = PLAYERS[winnerIdx].team;
                winnerId = PLAYERS[winnerIdx].id;
                catchTime = t;
                catchPoint = { x: ball.x, z: ball.z };
              }
            }
            decided = true;
          }
        }
      }
    }

    const isStride = step % FRAME_STRIDE_STEPS === 0;
    if (isStride) pushFrame(t);
    if (decided || t >= maxT) {
      if (!isStride) pushFrame(t);
      break;
    }
  }

  return {
    winnerTeam,
    winnerId,
    outReason,
    catchTime,
    catchPoint,
    tRim,
    playerIds: PLAYERS.map((p) => p.id),
    frames: Float32Array.from(frames),
    overlapViolations,
  };
}
