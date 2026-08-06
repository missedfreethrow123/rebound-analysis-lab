// Axis convention (matches the Three.js scene's world axes 1:1 — the
// rendering boundary just wraps these numbers into a THREE.Vector3, it never
// flips a sign or rescales a unit):
//   x — lateral court position, metres. +x = shooter's right when facing the hoop.
//   y — height above the floor, metres. +y = up.
//   z — court depth, metres. The rim's floor projection is z = 0; the shooter
//       releases from negative z (behind the free-throw line) and shoots toward +z.
//   Angles in ShotParams are degrees (UI-friendly); everything internal is radians.
//   Time is seconds, speed is m/s, spin is revolutions/second (positive = backspin).
//
// Spin convention: the ball's angular velocity is a genuine 3D vector (spinX,
// spinY, spinZ), not just the scalar spinRps — it's fixed in space at release
// (no gyroscopic precession modeled) and only changes afterward from the
// friction impulse of an actual rim/backboard/floor contact. At release, the
// axis is horizontal and perpendicular to the shot's horizontal direction,
// oriented so a positive spinRps is true backspin (the top of the ball moves
// opposite to the direction of travel) regardless of aim — see simulate()'s
// spinX/spinZ initialization for the derivation.
//
// Pure and headless: no DOM, no Three.js, no requestAnimationFrame, no
// Math.random. Calling simulate() twice with the same ShotParams returns
// byte-identical output, and the function never reads wall-clock time — it is
// safe to run unchanged inside a Web Worker or during SSR.

import {
  GRAVITY_MPS2,
  BALL_MASS_KG,
  BALL_RADIUS_M,
  BALL_INERTIA_KGM2,
  DRAG_ACCEL_COEFF,
  MAGNUS_ACCEL_COEFF,
  MAGNUS_LIFT_COEFF_MAX,
  MAGNUS_LIFT_COEFF_SLOPE,
  BASELINE_TO_RIM_M,
  BACKBOARD_FROM_BASELINE_M,
  FT_LINE_Z_M,
  RIM_HEIGHT_M,
  RIM_RADIUS_M,
  RIM_TUBE_RADIUS_M,
  BACKBOARD_W_M,
  BACKBOARD_H_M,
  BACKBOARD_Y_ABOVE_RIM_M,
  FLOOR_RESTITUTION,
  RIM_RESTITUTION,
  BACKBOARD_RESTITUTION,
  FRICTION_RIM,
  FRICTION_BACKBOARD,
  FRICTION_FLOOR,
  NET_DROP_M,
  NET_DRAG_RATE,
  CATCH_HEIGHT_M,
  COURT_WIDTH_M,
  HALF_COURT_LENGTH_M,
  WALL_MARGIN_X_M,
  WALL_MARGIN_Z_FAR_M,
  WALL_MARGIN_Z_NEAR_M,
  WALL_MAX_HEIGHT_M,
  SIM_FIXED_DT_S,
  SIM_MAX_DURATION_S,
  RIM_FINE_STEP_MARGIN_M,
  RIM_FINE_DT_S,
  TRAJECTORY_SAMPLE_INTERVAL_S,
  ROLLING_RESISTANCE_COEFF,
  ROLLING_CONTACT_EPSILON_M,
} from "./constants";

export interface ShotParams {
  heightCm: number; // player height
  angleDeg: number; // release angle above horizontal
  aimDeg: number; // horizontal aim, 0 = straight at the centre of the rim
  speed: number; // release speed, m/s
  spinRps: number; // backspin, revolutions per second (positive = backspin)
}

export interface SimulateOptions {
  // When false, skips building the trajectory sample array entirely (returns
  // an empty Float32Array) — the Phase 3 sweep doesn't animate anything and
  // would otherwise pay for the allocation for nothing.
  recordTrajectory?: boolean;
}

export type Outcome = "made" | "rim_miss" | "backboard_miss" | "airball" | "out_of_bounds";

export interface ShotResult {
  outcome: Outcome;
  trajectory: Float32Array; // flat [t,x,y,z, t,x,y,z, ...] for animation, decimated except collision moments, which are always sampled exactly (see core.ts)
  rimContacts: number;
  floorPoint: [number, number] | null; // first floor contact, metres
  catchPoint: [number, number] | null; // where it last descends through CATCH_HEIGHT_M before landing — defined for every miss (airball, backboard-only, or rim-touching), not just rim contacts; null only if the ball never reaches CATCH_HEIGHT_M while still airborne (e.g. an already-low trajectory)
  catchTime: number | null; // seconds from release
  catchSpeed: number | null; // m/s at that moment

  // Additional fields beyond the spec's minimum ShotResult contract, needed by
  // the existing single-shot stats panel (Phase 1 must not change what the
  // user sees). Derived from the same full-resolution integration, not a
  // second physics pass, so they stay exact rather than approximated from the
  // decimated trajectory samples.
  maxHeight: number;
  backboardHit: boolean;
  floorBounces: number;
  travelDist: number;
  floorTime: number | null; // seconds from release to first floor contact
  floorImpactSpeed: number | null; // m/s, measured the same way the original UI did: *after* the floor's restitution/friction is applied, not the raw incoming speed
  firstImpactTime: number | null; // seconds from release to the first contact with rim, backboard, or floor (whichever comes first) — lets a UI preview truncate the flight the same way the pre-refactor implementation did, without a second physics pass

  // True if the simulation hit SIM_MAX_DURATION_S (the hard cap) without ever
  // settling below the stop threshold. Should never happen in practice —
  // every restitution coefficient is < 1, so energy strictly decreases each
  // bounce and gravity guarantees a floor contact — but the cap exists so a
  // pathological input can't hang a sweep worker, and this flag makes it
  // visible if the cap is ever actually hit rather than failing silently.
  hitStepCap: boolean;
}

const RIM_Z_M = 0;
const BACKBOARD_Z_M = BASELINE_TO_RIM_M - BACKBOARD_FROM_BASELINE_M;
const BACKBOARD_Y_M = RIM_HEIGHT_M + BACKBOARD_Y_ABOVE_RIM_M;
const SIDELINE_X_M = COURT_WIDTH_M / 2;
const HALF_COURT_Z_M = BASELINE_TO_RIM_M - HALF_COURT_LENGTH_M;
const BASELINE_Z_M = BASELINE_TO_RIM_M;

const WALL_X_MIN = -SIDELINE_X_M - WALL_MARGIN_X_M;
const WALL_X_MAX = SIDELINE_X_M + WALL_MARGIN_X_M;
const WALL_Z_MIN = HALF_COURT_Z_M - WALL_MARGIN_Z_FAR_M;
const WALL_Z_MAX = BASELINE_Z_M + WALL_MARGIN_Z_NEAR_M;

// Effective mass for a hollow sphere's tangential (friction) impulse:
// 1/m_eff = 1/m + R^2/I, and I = (2/3) m R^2 ⇒ R^2/I = 3/(2m) ⇒ m_eff = (2/5) m.
const TANGENT_EFFECTIVE_MASS_KG = (2 / 5) * BALL_MASS_KG;

// A hard cap on loop iterations regardless of step size, independent of
// SIM_MAX_DURATION_S / dt — the near-rim fine-stepping (RIM_FINE_DT_S) can in
// a pathological case take 10x more iterations to cover the same simulated
// time, so this bounds wall-clock cost even if that happened for the entire
// flight (it doesn't, in practice: fine-stepping only activates within a few
// centimetres of the rim).
const MAX_ITERATIONS = Math.ceil(SIM_MAX_DURATION_S / RIM_FINE_DT_S) + 1000;

// Exported so the rendering layer can place the idle ball / camera at exactly
// the same release point simulate() uses, without a second copy of the formula.
export function releaseHeightM(heightCm: number): number {
  return (heightCm / 100) * 1.25; // release point sits above the player's head
}

// Resolves one contact's impulse: a restitution-only normal impulse (as
// before), plus a Coulomb-clamped tangential (friction) impulse evaluated at
// the actual contact point on the ball's surface (center - R*n), so it
// couples into both the linear velocity AND the spin via a proper
// impulse-torque relation. This is the one place all three collision sites
// (rim, backboard, floor) share, so their friction/spin behavior can't drift
// apart from each other.
//
// Exported (in addition to being used internally) so core.test.ts can verify
// the energy behavior of a single contact directly — reconstructing velocity
// by finite-differencing simulate()'s decimated trajectory samples around a
// bounce is too numerically noisy for that (the position "push-out"
// correction at a contact isn't real motion, and the pre/post-contact
// sampling intervals have very different widths), so this is the only
// reliable way to test the invariant directly.
export function applyContactImpulse(
  velX: number,
  velY: number,
  velZ: number,
  spinX: number,
  spinY: number,
  spinZ: number,
  nx: number,
  ny: number,
  nz: number,
  restitution: number,
  friction: number,
): { velX: number; velY: number; velZ: number; spinX: number; spinY: number; spinZ: number } {
  const vn = velX * nx + velY * ny + velZ * nz;
  if (vn >= 0) {
    return { velX, velY, velZ, spinX, spinY, spinZ };
  }

  // Normal impulse (restitution) — a per-unit-mass velocity delta, same
  // formula as before; a ball bouncing off a fixed/infinitely-massive
  // obstacle doesn't need BALL_MASS_KG for this part, it cancels out.
  const j = -(1 + restitution) * vn;
  let vx = velX + j * nx;
  let vy = velY + j * ny;
  let vz = velZ + j * nz;

  // Contact point velocity = v + spin x r, where r is the vector from the
  // ball's center to the point on its surface touching the obstacle
  // (center - R*n). Its component along n is always ~0 (spin can't move the
  // surface toward/away from the obstacle), so subtracting the normal
  // projection isolates the sliding (tangential) velocity that friction acts against.
  const rx = -BALL_RADIUS_M * nx;
  const ry = -BALL_RADIUS_M * ny;
  const rz = -BALL_RADIUS_M * nz;
  const pvx = vx + (spinY * rz - spinZ * ry);
  const pvy = vy + (spinZ * rx - spinX * rz);
  const pvz = vz + (spinX * ry - spinY * rx);
  const pvn = pvx * nx + pvy * ny + pvz * nz;
  const tx = pvx - pvn * nx;
  const ty = pvy - pvn * ny;
  const tz = pvz - pvn * nz;
  const tMag = Math.hypot(tx, ty, tz);

  let sx = spinX;
  let sy = spinY;
  let sz = spinZ;

  if (tMag > 1e-9) {
    const tHatX = tx / tMag;
    const tHatY = ty / tMag;
    const tHatZ = tz / tMag;
    const normalImpulse = BALL_MASS_KG * j;
    // Impulse that would fully cancel sliding (roll without slip), clamped by
    // Coulomb's law: |J_t| <= mu * |J_n|.
    const impulseToStick = TANGENT_EFFECTIVE_MASS_KG * tMag;
    const tangentImpulse = Math.min(friction * normalImpulse, impulseToStick);

    const jx = -tangentImpulse * tHatX;
    const jy = -tangentImpulse * tHatY;
    const jz = -tangentImpulse * tHatZ;
    vx += jx / BALL_MASS_KG;
    vy += jy / BALL_MASS_KG;
    vz += jz / BALL_MASS_KG;

    // Torque impulse: dL = r x J, dω = dL / I.
    const dLx = ry * jz - rz * jy;
    const dLy = rz * jx - rx * jz;
    const dLz = rx * jy - ry * jx;
    sx += dLx / BALL_INERTIA_KGM2;
    sy += dLy / BALL_INERTIA_KGM2;
    sz += dLz / BALL_INERTIA_KGM2;
  }

  return { velX: vx, velY: vy, velZ: vz, spinX: sx, spinY: sy, spinZ: sz };
}

export function simulate(p: ShotParams, opts?: SimulateOptions): ShotResult {
  const recordTrajectory = opts?.recordTrajectory ?? true;

  const angle = (p.angleDeg * Math.PI) / 180;
  const aim = (p.aimDeg * Math.PI) / 180;
  const horizontalSpeed = p.speed * Math.cos(angle);

  let posX = 0;
  let posY = releaseHeightM(p.heightCm);
  let posZ = FT_LINE_Z_M;
  let velX = horizontalSpeed * Math.sin(aim);
  let velY = p.speed * Math.sin(angle);
  let velZ = horizontalSpeed * Math.cos(aim);

  // Spin axis at release: horizontal, perpendicular to the shot's horizontal
  // direction (sin(aim), 0, cos(aim)), oriented so positive spinRps is true
  // backspin regardless of aim. Derivation: the top of the ball (at +R along
  // y from center) must move opposite the direction of travel for backspin;
  // solving omega x (0,R,0) = (0,0,-k) for k>0 gives omega along
  // (-cos(aim), 0, sin(aim)). Fixed in space from here — only a collision's
  // friction impulse changes it after this.
  const spinAngularSpeed0 = 2 * Math.PI * p.spinRps; // rad/s
  let spinX = -Math.cos(aim) * spinAngularSpeed0;
  let spinY = 0;
  let spinZ = Math.sin(aim) * spinAngularSpeed0;

  const dt = SIM_FIXED_DT_S;
  const fineDt = RIM_FINE_DT_S;

  const trajectorySamples: number[] = [];
  let lastSampledT = -1;
  // Records the current position at simulated time `time` as an animation
  // sample, unless that exact instant was already recorded. Called both
  // periodically (decimation) and unconditionally on every collision, so a
  // bounce is always an exact vertex in the sampled polyline — interpolating
  // between two decimated samples straddling a bounce would otherwise cut the
  // corner and visually skate the ball straight through the rim/floor/backboard.
  const maybeSample = (time: number) => {
    if (!recordTrajectory) return;
    if (lastSampledT >= 0 && Math.abs(time - lastSampledT) < 1e-9) return;
    trajectorySamples.push(time, posX, posY, posZ);
    lastSampledT = time;
  };
  maybeSample(0);
  let lastPeriodicSampleT = 0;

  let rimContacts = 0;
  let backboardHit = false;
  let madeShot = false;
  let floorPoint: [number, number] | null = null;
  let floorBounces = 0;
  let floorTime: number | null = null;
  let floorImpactSpeed: number | null = null;
  let firstImpactTime: number | null = null;
  let maxHeight = posY;
  let travelDist = 0;

  // Defined for every miss, not just rim-touching ones: armed from release, so
  // an airball or backboard-only miss still gets a catch point on its way
  // down. A rim or backboard contact re-arms it (clearing any earlier
  // candidate), since the ball's path just changed and the catch point should
  // reflect where it *actually* comes down, not a pre-bounce guess. Stops
  // being armed once the ball reaches the floor (see the floor block below) —
  // there's no more catching it after that.
  let awaitingCatch = true;
  let catchPoint: [number, number] | null = null;
  let catchTime: number | null = null;
  let catchSpeed: number | null = null;

  let flying = true;
  let t = 0;
  let iterations = 0;
  // Set when the loop stops because the *next* step would overshoot
  // SIM_MAX_DURATION_S, as opposed to stopping because it settled. Tracked
  // separately from `t >= SIM_MAX_DURATION_S` because we deliberately never
  // let t cross that line in the first place (see the break below) — without
  // this flag, a shot that was genuinely still flying at the cap would be
  // indistinguishable from one that settled in the same last step.
  let cappedByDuration = false;

  while (flying && iterations < MAX_ITERATIONS) {
    iterations++;

    // Step size: fine (0.1ms) within RIM_FINE_STEP_MARGIN_M of the rim's
    // collision shell, so a fast ball can't resolve a rim contact a whole
    // coarse step late; the normal 1ms step everywhere else. The backboard
    // and floor don't need this — their flat-plane crossing tests already
    // catch the exact transition regardless of step size.
    const dxzToAxis = Math.hypot(posX, posZ - RIM_Z_M);
    const distToRingCenterline = Math.hypot(dxzToAxis - RIM_RADIUS_M, posY - RIM_HEIGHT_M);
    const nearRim = distToRingCenterline < BALL_RADIUS_M + RIM_TUBE_RADIUS_M + RIM_FINE_STEP_MARGIN_M;
    const h = nearRim ? fineDt : dt;

    // Never take a step that would push t past the cap — otherwise the final
    // sample's timestamp can land fractionally beyond SIM_MAX_DURATION_S.
    if (t + h > SIM_MAX_DURATION_S) {
      cappedByDuration = true;
      break;
    }

    const prevX = posX;
    const prevY = posY;
    const prevZ = posZ;

    // Drag and Magnus lift both scale with the ball's current speed, so both
    // are skipped (a no-op either way) when it's at rest.
    const speed = Math.hypot(velX, velY, velZ);
    if (speed > 1e-9) {
      // Drag: F = -0.5*rho*Cd*A*|v|*v ⇒ a = -DRAG_ACCEL_COEFF*|v|*v.
      const dragAccel = DRAG_ACCEL_COEFF * speed;
      velX -= dragAccel * velX * h;
      velY -= dragAccel * velY * h;
      velZ -= dragAccel * velZ * h;

      // Magnus lift, using the CURRENT spin state — friction from a
      // rim/backboard/floor contact can add spin to a ball launched with
      // spinRps = 0, and that should start producing lift immediately after.
      const spinMag = Math.hypot(spinX, spinY, spinZ);
      if (spinMag > 1e-9) {
        const spinRatio = (spinMag * BALL_RADIUS_M) / speed;
        const liftCoeff = Math.min(MAGNUS_LIFT_COEFF_MAX, MAGNUS_LIFT_COEFF_SLOPE * spinRatio);
        const vHatX = velX / speed;
        const vHatY = velY / speed;
        const vHatZ = velZ / speed;
        const oHatX = spinX / spinMag;
        const oHatY = spinY / spinMag;
        const oHatZ = spinZ / spinMag;
        // omega_hat x v_hat
        const crossX = oHatY * vHatZ - oHatZ * vHatY;
        const crossY = oHatZ * vHatX - oHatX * vHatZ;
        const crossZ = oHatX * vHatY - oHatY * vHatX;
        const magnusAccelMag = MAGNUS_ACCEL_COEFF * liftCoeff * speed * speed;
        velX += magnusAccelMag * crossX * h;
        velY += magnusAccelMag * crossY * h;
        velZ += magnusAccelMag * crossZ * h;
      }
    }
    velY += GRAVITY_MPS2 * h;

    posX += velX * h;
    posY += velY * h;
    posZ += velZ * h;
    t += h;

    // Net resistance: damps horizontal speed while descending through the net
    // cone, same as the original applyNetResistance().
    {
      const dxz = Math.hypot(posX, posZ - RIM_Z_M);
      if (velY < 0 && dxz < RIM_RADIUS_M - BALL_RADIUS_M && posY < RIM_HEIGHT_M && posY > RIM_HEIGHT_M - NET_DROP_M) {
        const damp = Math.exp(-NET_DRAG_RATE * h);
        velX *= damp;
        velZ *= damp;
      }
    }

    // Made-shot detection: any downward descent through the hoop opening —
    // a clean, uncontested swish, or the ball rattling off the rim and/or
    // backboard first and then dropping through. Previously gated on
    // rimContacts === 0 && !backboardHit (a swish-only check), which meant a
    // shot that touched the rim before falling in was scored the same as a
    // miss (rim_miss/backboard_miss below) even though it went in the hoop.
    // rimContacts/backboardHit stay tracked as metadata regardless (see their
    // own field comments) — they no longer gate whether this counts as made.
    if (!madeShot) {
      const dxz = Math.hypot(posX, posZ - RIM_Z_M);
      const crossedRimHeight = prevY >= RIM_HEIGHT_M && posY < RIM_HEIGHT_M;
      if (velY < 0 && dxz < RIM_RADIUS_M - BALL_RADIUS_M && crossedRimHeight) {
        madeShot = true;
      }
    }

    // Backboard: flat plane at z = BACKBOARD_Z_M, outward normal (0,0,-1).
    // Crossing test (instead of a fixed epsilon shell) so a fast ball can't
    // tunnel through in one step.
    {
      const withinX = Math.abs(posX) < BACKBOARD_W_M / 2 + BALL_RADIUS_M;
      const withinY =
        posY > BACKBOARD_Y_M - BACKBOARD_H_M / 2 - BALL_RADIUS_M && posY < BACKBOARD_Y_M + BACKBOARD_H_M / 2 + BALL_RADIUS_M;
      if (withinX && withinY) {
        const front = BACKBOARD_Z_M;
        const wasInFront = prevZ + BALL_RADIUS_M <= front;
        const isPast = posZ + BALL_RADIUS_M > front;
        if (wasInFront && isPast && velZ > 0) {
          posZ = front - BALL_RADIUS_M;
          const resolved = applyContactImpulse(velX, velY, velZ, spinX, spinY, spinZ, 0, 0, -1, BACKBOARD_RESTITUTION, FRICTION_BACKBOARD);
          velX = resolved.velX;
          velY = resolved.velY;
          velZ = resolved.velZ;
          spinX = resolved.spinX;
          spinY = resolved.spinY;
          spinZ = resolved.spinZ;
          backboardHit = true;
          // Re-arm the catch point: the ball's path just changed, so any
          // earlier candidate (from before this bounce) no longer reflects
          // where it actually comes down.
          awaitingCatch = true;
          catchPoint = null;
          catchTime = null;
          catchSpeed = null;
          if (firstImpactTime === null) firstImpactTime = t;
          maybeSample(t);
        }
      }
    }

    // Rim: sphere vs. torus (ring circle of RIM_RADIUS_M at RIM_HEIGHT_M, tube
    // radius RIM_TUBE_RADIUS_M). Contact normal is nearest-ring-point -> ball
    // center.
    {
      const dxz = Math.hypot(posX, posZ - RIM_Z_M);
      if (dxz > 1e-6) {
        const nx = (posX / dxz) * RIM_RADIUS_M;
        const nz = RIM_Z_M + ((posZ - RIM_Z_M) / dxz) * RIM_RADIUS_M;
        const ny = RIM_HEIGHT_M;
        const dx = posX - nx;
        const dy = posY - ny;
        const dz = posZ - nz;
        const d = Math.hypot(dx, dy, dz);
        const minD = BALL_RADIUS_M + RIM_TUBE_RADIUS_M;
        if (d < minD && d > 1e-6) {
          const nxN = dx / d;
          const nyN = dy / d;
          const nzN = dz / d;
          const push = minD - d;
          posX += nxN * push;
          posY += nyN * push;
          posZ += nzN * push;
          const resolved = applyContactImpulse(velX, velY, velZ, spinX, spinY, spinZ, nxN, nyN, nzN, RIM_RESTITUTION, FRICTION_RIM);
          velX = resolved.velX;
          velY = resolved.velY;
          velZ = resolved.velZ;
          spinX = resolved.spinX;
          spinY = resolved.spinY;
          spinZ = resolved.spinZ;
          rimContacts++;
          awaitingCatch = true;
          catchPoint = null;
          catchTime = null;
          catchSpeed = null;
          if (firstImpactTime === null) firstImpactTime = t;
          maybeSample(t);
        }
      }
    }

    // Floor: plane at y=0, outward normal (0,1,0).
    if (posY - BALL_RADIUS_M < 0) {
      posY = BALL_RADIUS_M;
      if (velY < 0) {
        const resolved = applyContactImpulse(velX, velY, velZ, spinX, spinY, spinZ, 0, 1, 0, FLOOR_RESTITUTION, FRICTION_FLOOR);
        velX = resolved.velX;
        velY = resolved.velY;
        velZ = resolved.velZ;
        spinX = resolved.spinX;
        spinY = resolved.spinY;
        spinZ = resolved.spinZ;
        floorBounces++;
        if (floorPoint === null) {
          floorPoint = [posX, posZ];
          floorTime = t;
          floorImpactSpeed = Math.hypot(velX, velY, velZ);
          if (firstImpactTime === null) firstImpactTime = floorTime;
        }
        maybeSample(t);
      }
    }

    // Rolling resistance: only while actually resting on the floor (not
    // mid-bounce), decelerate horizontal motion so a rolling ball settles in
    // finite time instead of coasting for the rest of SIM_MAX_DURATION_S once
    // friction alone has brought it to a stable roll (see ROLLING_RESISTANCE_COEFF).
    if (posY - BALL_RADIUS_M < ROLLING_CONTACT_EPSILON_M) {
      const horizSpeed = Math.hypot(velX, velZ);
      if (horizSpeed > 1e-9) {
        const decel = ROLLING_RESISTANCE_COEFF * -GRAVITY_MPS2;
        // Clamp so a single step can't overshoot past zero and reverse direction.
        const reduction = Math.min(horizSpeed, decel * h);
        const scale = (horizSpeed - reduction) / horizSpeed;
        velX *= scale;
        velZ *= scale;
      }
    }

    // Catch point: descent through CATCH_HEIGHT_M, defined for every miss —
    // armed from release (re-armed by any rim/backboard contact above), and
    // stops once the ball reaches the floor (floorPoint set): after that
    // there's no more catching it, only bouncing.
    if (awaitingCatch && floorPoint === null) {
      const crossedCatchHeight = prevY >= CATCH_HEIGHT_M && posY < CATCH_HEIGHT_M;
      if (velY < 0 && crossedCatchHeight) {
        catchPoint = [posX, posZ];
        catchTime = t;
        catchSpeed = Math.hypot(velX, velY, velZ);
        awaitingCatch = false;
      }
    }

    // Walls: containment box only, so a wild shot can't integrate forever —
    // NOT the real out-of-bounds lines (see the outcome classification below).
    // Also a genuine velocity discontinuity like the real collisions above, so
    // it gets the same forced sample for the same reason (see maybeSample).
    let hitWall = false;
    if (posX - BALL_RADIUS_M < WALL_X_MIN) {
      posX = WALL_X_MIN + BALL_RADIUS_M;
      velX = -velX * 0.6;
      hitWall = true;
    }
    if (posX + BALL_RADIUS_M > WALL_X_MAX) {
      posX = WALL_X_MAX - BALL_RADIUS_M;
      velX = -velX * 0.6;
      hitWall = true;
    }
    if (posZ - BALL_RADIUS_M < WALL_Z_MIN) {
      posZ = WALL_Z_MIN + BALL_RADIUS_M;
      velZ = -velZ * 0.6;
      hitWall = true;
    }
    if (posZ + BALL_RADIUS_M > WALL_Z_MAX) {
      posZ = WALL_Z_MAX - BALL_RADIUS_M;
      velZ = -velZ * 0.6;
      hitWall = true;
    }
    if (posY + BALL_RADIUS_M > WALL_MAX_HEIGHT_M) {
      posY = WALL_MAX_HEIGHT_M - BALL_RADIUS_M;
      velY = -Math.abs(velY) * 0.6;
      hitWall = true;
    }
    if (hitWall) maybeSample(t);

    travelDist += Math.hypot(posX - prevX, posY - prevY, posZ - prevZ);
    if (posY > maxHeight) maxHeight = posY;

    if (t - lastPeriodicSampleT >= TRAJECTORY_SAMPLE_INTERVAL_S) {
      maybeSample(t);
      lastPeriodicSampleT = t;
    }

    if (Math.hypot(velX, velY, velZ) < 0.3 && posY < BALL_RADIUS_M + 0.01) {
      flying = false;
    }
  }

  // The loop is unconditionally bounded (by cappedByDuration and by
  // iterations) regardless of `flying`, so simulate() always returns —
  // hitStepCap just reports whether either bound is what actually stopped it.
  const hitStepCap = flying && (cappedByDuration || iterations >= MAX_ITERATIONS);

  // Always end the sample array on the ball's final resting/cutoff state,
  // even if that doesn't land on the periodic schedule.
  maybeSample(t);

  let outcome: Outcome;
  if (madeShot) {
    outcome = "made";
  } else if (backboardHit) {
    outcome = "backboard_miss";
  } else if (rimContacts > 0) {
    outcome = "rim_miss";
  } else if (floorPoint && (Math.abs(floorPoint[0]) > SIDELINE_X_M || floorPoint[1] > BASELINE_Z_M || floorPoint[1] < HALF_COURT_Z_M)) {
    outcome = "out_of_bounds";
  } else {
    outcome = "airball";
  }

  return {
    outcome,
    trajectory: recordTrajectory ? Float32Array.from(trajectorySamples) : new Float32Array(0),
    rimContacts,
    floorPoint,
    catchPoint,
    catchTime,
    catchSpeed,
    maxHeight,
    backboardHit,
    floorBounces,
    travelDist,
    floorTime,
    floorImpactSpeed,
    firstImpactTime,
    hitStepCap,
  };
}
