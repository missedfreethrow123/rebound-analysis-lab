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
// Pure and headless: no DOM, no Three.js, no requestAnimationFrame, no
// Math.random. Calling simulate() twice with the same ShotParams returns
// byte-identical output, and the function never reads wall-clock time — it is
// safe to run unchanged inside a Web Worker or during SSR.

import {
  GRAVITY_MPS2,
  BALL_RADIUS_M,
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
  AIR_DRAG_COEFF,
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
} from "./constants";

export interface ShotParams {
  heightCm: number; // player height
  angleDeg: number; // release angle above horizontal
  aimDeg: number; // horizontal aim, 0 = straight at the centre of the rim
  speed: number; // release speed, m/s
  spinRps: number; // backspin, revolutions per second (positive = backspin) — accepted but not
  // yet applied as a force; Phase 2 adds the Magnus term. Kept on the interface
  // now so the sweep worker protocol never has to change shape later.
}

export type Outcome = "made" | "rim_miss" | "backboard_miss" | "airball" | "out_of_bounds";

export interface ShotResult {
  outcome: Outcome;
  trajectory: Float32Array; // flat [t,x,y,z, t,x,y,z, ...] for animation, decimated
  rimContacts: number;
  floorPoint: [number, number] | null; // first floor contact, metres
  catchPoint: [number, number] | null; // where it descends through CATCH_HEIGHT_M after the *last* rim contact
  catchTime: number | null; // seconds from release
  catchSpeed: number | null; // m/s at that moment

  // Additional fields beyond the spec's minimum ShotResult contract, needed by
  // the existing single-shot stats panel (Phase 1 must not change what the
  // user sees). Derived from the same full-resolution 1 ms integration, not a
  // second physics pass, so they stay exact rather than approximated from the
  // decimated trajectory samples.
  maxHeight: number;
  backboardHit: boolean;
  floorBounces: number;
  travelDist: number;
  floorTime: number | null; // seconds from release to first floor contact
  floorImpactSpeed: number | null; // m/s, measured the same way the original UI did: *after* the floor's restitution/friction is applied, not the raw incoming speed
  firstImpactTime: number | null; // seconds from release to the first contact with rim, backboard, or floor (whichever comes first) — lets a UI preview truncate the flight the same way the pre-refactor implementation did, without a second physics pass
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

const TRAJECTORY_SAMPLE_EVERY_N_STEPS = 10; // 10 ms per animation sample; the integration itself always runs at SIM_FIXED_DT_S

// Exported so the rendering layer can place the idle ball / camera at exactly
// the same release point simulate() uses, without a second copy of the formula.
export function releaseHeightM(heightCm: number): number {
  return (heightCm / 100) * 1.25; // release point sits above the player's head
}

export function simulate(p: ShotParams): ShotResult {
  const angle = (p.angleDeg * Math.PI) / 180;
  const aim = (p.aimDeg * Math.PI) / 180;
  const horizontalSpeed = p.speed * Math.cos(angle);

  let posX = 0;
  let posY = releaseHeightM(p.heightCm);
  let posZ = FT_LINE_Z_M;
  let velX = horizontalSpeed * Math.sin(aim);
  let velY = p.speed * Math.sin(angle);
  let velZ = horizontalSpeed * Math.cos(aim);

  const dt = SIM_FIXED_DT_S;
  const maxSteps = Math.round(SIM_MAX_DURATION_S / dt);
  const sampleCap = Math.ceil(maxSteps / TRAJECTORY_SAMPLE_EVERY_N_STEPS) + 2;
  const trajectory = new Float32Array(sampleCap * 4);
  let sampleCount = 0;
  const pushSample = (t: number) => {
    const o = sampleCount * 4;
    trajectory[o] = t;
    trajectory[o + 1] = posX;
    trajectory[o + 2] = posY;
    trajectory[o + 3] = posZ;
    sampleCount++;
  };
  pushSample(0);

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

  let awaitingCatch = false;
  let catchPoint: [number, number] | null = null;
  let catchTime: number | null = null;
  let catchSpeed: number | null = null;

  let flying = true;
  let step = 0;

  for (; step < maxSteps && flying; step++) {
    const prevX = posX;
    const prevY = posY;
    const prevZ = posZ;

    // Drag: fudge-factor quadratic form ported as-is from the original inline
    // physics (Phase 2 replaces this with a derived 0.5*rho*Cd*A/m form).
    const speed = Math.hypot(velX, velY, velZ);
    if (speed > 0) {
      const drag = (AIR_DRAG_COEFF * speed * speed) / speed;
      velX -= velX * drag * dt;
      velY -= velY * drag * dt;
      velZ -= velZ * drag * dt;
    }
    velY += GRAVITY_MPS2 * dt;

    posX += velX * dt;
    posY += velY * dt;
    posZ += velZ * dt;

    // Net resistance: damps horizontal speed while descending through the net
    // cone, same as the original applyNetResistance().
    {
      const dxz = Math.hypot(posX, posZ - RIM_Z_M);
      if (velY < 0 && dxz < RIM_RADIUS_M - BALL_RADIUS_M && posY < RIM_HEIGHT_M && posY > RIM_HEIGHT_M - NET_DROP_M) {
        const damp = Math.exp(-NET_DRAG_RATE * dt);
        velX *= damp;
        velZ *= damp;
      }
    }

    // Swish detection: a clean, still-uncontested descent through the hoop
    // opening, before any rim or backboard contact.
    if (!madeShot && rimContacts === 0 && !backboardHit) {
      const dxz = Math.hypot(posX, posZ - RIM_Z_M);
      const crossedRimHeight = prevY >= RIM_HEIGHT_M && posY < RIM_HEIGHT_M;
      if (velY < 0 && dxz < RIM_RADIUS_M - BALL_RADIUS_M && crossedRimHeight) {
        madeShot = true;
      }
    }

    // Backboard: flat plane at z = BACKBOARD_Z_M. Crossing test (instead of a
    // fixed epsilon shell) so a fast ball can't tunnel through in one step.
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
          velZ = -velZ * BACKBOARD_RESTITUTION;
          velX *= 0.9;
          velY *= 0.9;
          backboardHit = true;
          if (firstImpactTime === null) firstImpactTime = (step + 1) * dt;
        }
      }
    }

    // Rim: sphere vs. torus (ring circle of RIM_RADIUS_M at RIM_HEIGHT_M, tube
    // radius RIM_TUBE_RADIUS_M). Contact normal is nearest-ring-point -> ball
    // center; resolved with a restitution-only impulse (Phase 2 adds friction
    // coupled to spin here).
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
          const vn = velX * nxN + velY * nyN + velZ * nzN;
          if (vn < 0) {
            velX -= (1 + RIM_RESTITUTION) * vn * nxN;
            velY -= (1 + RIM_RESTITUTION) * vn * nyN;
            velZ -= (1 + RIM_RESTITUTION) * vn * nzN;
          }
          rimContacts++;
          awaitingCatch = true;
          catchPoint = null;
          catchTime = null;
          catchSpeed = null;
          if (firstImpactTime === null) firstImpactTime = (step + 1) * dt;
        }
      }
    }

    // Floor.
    if (posY - BALL_RADIUS_M < 0) {
      posY = BALL_RADIUS_M;
      if (velY < 0) {
        velY = -velY * FLOOR_RESTITUTION;
        velX *= 0.8;
        velZ *= 0.8;
        floorBounces++;
        if (floorPoint === null) {
          floorPoint = [posX, posZ];
          floorTime = (step + 1) * dt;
          floorImpactSpeed = Math.hypot(velX, velY, velZ);
          if (firstImpactTime === null) firstImpactTime = floorTime;
        }
      }
    }

    // Catch point: first descent through CATCH_HEIGHT_M after the most recent
    // rim contact (invalidated and re-armed by any later rim contact above).
    if (awaitingCatch) {
      const crossedCatchHeight = prevY >= CATCH_HEIGHT_M && posY < CATCH_HEIGHT_M;
      if (velY < 0 && crossedCatchHeight) {
        catchPoint = [posX, posZ];
        catchTime = (step + 1) * dt;
        catchSpeed = Math.hypot(velX, velY, velZ);
        awaitingCatch = false;
      }
    }

    // Walls: containment box only, so a wild shot can't integrate forever —
    // NOT the real out-of-bounds lines (see the outcome classification below).
    if (posX - BALL_RADIUS_M < WALL_X_MIN) {
      posX = WALL_X_MIN + BALL_RADIUS_M;
      velX = -velX * 0.6;
    }
    if (posX + BALL_RADIUS_M > WALL_X_MAX) {
      posX = WALL_X_MAX - BALL_RADIUS_M;
      velX = -velX * 0.6;
    }
    if (posZ - BALL_RADIUS_M < WALL_Z_MIN) {
      posZ = WALL_Z_MIN + BALL_RADIUS_M;
      velZ = -velZ * 0.6;
    }
    if (posZ + BALL_RADIUS_M > WALL_Z_MAX) {
      posZ = WALL_Z_MAX - BALL_RADIUS_M;
      velZ = -velZ * 0.6;
    }
    if (posY + BALL_RADIUS_M > WALL_MAX_HEIGHT_M) {
      posY = WALL_MAX_HEIGHT_M - BALL_RADIUS_M;
      velY = -Math.abs(velY) * 0.6;
    }

    travelDist += Math.hypot(posX - prevX, posY - prevY, posZ - prevZ);
    if (posY > maxHeight) maxHeight = posY;

    if ((step + 1) % TRAJECTORY_SAMPLE_EVERY_N_STEPS === 0) {
      pushSample((step + 1) * dt);
    }

    if (Math.hypot(velX, velY, velZ) < 0.3 && posY < BALL_RADIUS_M + 0.01) {
      flying = false;
    }
  }

  // Always end the sample array on the ball's final resting/cutoff state, even
  // if that doesn't land on a decimation boundary.
  if (sampleCount === 0 || trajectory[(sampleCount - 1) * 4] !== step * dt) {
    pushSample(step * dt);
  }

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
    trajectory: trajectory.slice(0, sampleCount * 4),
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
  };
}
