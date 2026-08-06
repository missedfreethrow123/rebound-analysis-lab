import { describe, expect, it } from "vitest";
import { applyContactImpulse, releaseHeightM, simulate, type ShotParams } from "./core";
import { BALL_INERTIA_KGM2, BALL_MASS_KG, FLOOR_RESTITUTION, FT_LINE_Z_M } from "./constants";

const params: ShotParams = {
  heightCm: 190,
  angleDeg: 52,
  aimDeg: 0,
  speed: 7.5,
  spinRps: 2.5,
};

describe("simulate", () => {
  it("is deterministic: identical input produces byte-identical output", () => {
    const r1 = simulate(params);
    const r2 = simulate(params);

    expect(r1.outcome).toBe(r2.outcome);
    expect(r1.rimContacts).toBe(r2.rimContacts);
    expect(r1.floorPoint).toEqual(r2.floorPoint);
    expect(r1.catchPoint).toEqual(r2.catchPoint);
    expect(r1.catchTime).toBe(r2.catchTime);
    expect(r1.catchSpeed).toBe(r2.catchSpeed);
    expect(r1.maxHeight).toBe(r2.maxHeight);
    expect(r1.travelDist).toBe(r2.travelDist);
    expect(Array.from(r1.trajectory)).toEqual(Array.from(r2.trajectory));
  });

  it("does not depend on wall-clock time or frame rate", () => {
    // core.ts must never read the clock — that's exactly the bug being fixed
    // (the old implementation derived its timestep from performance.now()
    // deltas). Make any read of it fail loudly instead of silently passing.
    const originalNow = performance.now;
    performance.now = () => {
      throw new Error("simulate() must not read wall-clock time");
    };
    try {
      expect(() => simulate(params)).not.toThrow();
    } finally {
      performance.now = originalNow;
    }
  });

  it("produces the same trajectory regardless of how long each call takes to run", () => {
    // A frame-rate-driven implementation would integrate a different amount
    // of physics time depending on how fast the loop calling it executes.
    // Interleave calls with artificial busy-work of varying duration and
    // confirm the physics output never changes.
    const fast = simulate(params);

    let busy = 0;
    for (let i = 0; i < 5_000_00; i++) busy += Math.sqrt(i);
    const slow = simulate(params);
    expect(busy).toBeGreaterThan(0); // keep the busy-work from being optimized away

    expect(fast.outcome).toBe(slow.outcome);
    expect(Array.from(fast.trajectory)).toEqual(Array.from(slow.trajectory));
  });

  it("always returns within SIM_MAX_DURATION_S and reports whether the cap was needed", () => {
    // Every restitution coefficient is < 1 and gravity is constant, so energy
    // strictly decreases every bounce and a real ShotParams can't fail to
    // settle — hitStepCap should be false in practice. What this test
    // actually guards is the *safety property*: simulate() is bounded no
    // matter what, which is what makes it safe to call from a Phase 3 worker
    // pool without an external watchdog timer.
    const SIM_MAX_DURATION_S = 15; // mirrors physics/constants.ts; simulate() must never exceed this
    const cases: ShotParams[] = [
      params,
      { heightCm: 190, angleDeg: 0, aimDeg: 0, speed: 0.01, spinRps: 0 }, // barely moving
      { heightCm: 140, angleDeg: 80, aimDeg: 0, speed: 4, spinRps: 0 }, // steep, slow
      { heightCm: 230, angleDeg: 20, aimDeg: 30, speed: 12, spinRps: 0 }, // shallow, fast, wide
    ];
    for (const c of cases) {
      const result = simulate(c);
      expect(typeof result.hitStepCap).toBe("boolean");
      const lastSampleTime = result.trajectory[result.trajectory.length - 4];
      // +1e-4 tolerance for Float32Array storage rounding of the double `t`,
      // not a relaxation of the cap itself — core.ts must never take a step
      // that pushes t past SIM_MAX_DURATION_S.
      expect(lastSampleTime).toBeLessThanOrEqual(SIM_MAX_DURATION_S + 1e-4);
    }
  });

  it("always records an exact trajectory sample at every collision, not just on the decimation schedule", () => {
    const result = simulate(params);
    const sampleTimes: number[] = [];
    for (let i = 0; i < result.trajectory.length; i += 4) sampleTimes.push(result.trajectory[i]);

    if (result.floorTime !== null) {
      // Float32Array storage loses a little precision vs. the double
      // floorTime, so compare with a tolerance well under one physics step (1ms).
      const hasExactSample = sampleTimes.some((t) => Math.abs(t - result.floorTime!) < 1e-4);
      expect(hasExactSample).toBe(true);
    }
  });

  it("opts.recordTrajectory: false skips the trajectory array but leaves every other field unchanged", () => {
    const withTrajectory = simulate(params);
    const withoutTrajectory = simulate(params, { recordTrajectory: false });

    expect(withoutTrajectory.trajectory.length).toBe(0);
    expect(withoutTrajectory.outcome).toBe(withTrajectory.outcome);
    expect(withoutTrajectory.rimContacts).toBe(withTrajectory.rimContacts);
    expect(withoutTrajectory.floorPoint).toEqual(withTrajectory.floorPoint);
    expect(withoutTrajectory.catchPoint).toEqual(withTrajectory.catchPoint);
    expect(withoutTrajectory.maxHeight).toBe(withTrajectory.maxHeight);
    expect(withoutTrajectory.travelDist).toBe(withTrajectory.travelDist);
    expect(withoutTrajectory.hitStepCap).toBe(withTrajectory.hitStepCap);
  });
});

describe("Phase 2 physics", () => {
  // A vertical drop, expressed through the public ShotParams shape: angleDeg
  // 90 with speed 0 gives zero initial velocity in every direction, and
  // heightCm is chosen so releaseHeightM(heightCm) is exactly 2.0m.
  const dropHeightM = 2.0;
  const dropHeightCm = (dropHeightM / 1.25) * 100;
  const straightDrop: ShotParams = { heightCm: dropHeightCm, angleDeg: 90, aimDeg: 0, speed: 0, spinRps: 0 };

  it("a 2.0m drop with zero spin rebounds to ~1.22m (floor restitution 0.78)", () => {
    // Sanity-check the heightCm -> release-height inverse before relying on it.
    expect(releaseHeightM(dropHeightCm)).toBeCloseTo(dropHeightM, 9);

    const result = simulate(straightDrop);
    expect(result.floorTime).not.toBeNull();

    // Peak height in the ~1s after the first floor contact.
    const traj = result.trajectory;
    let peak = 0;
    for (let i = 0; i < traj.length; i += 4) {
      const t = traj[i];
      const y = traj[i + 2];
      if (t > result.floorTime! && t < result.floorTime! + 1.0 && y > peak) peak = y;
    }

    // e^2 * 2.0 = 0.78^2 * 2.0 = 1.2168m in vacuum; air drag over the fall and
    // rebound pulls the real figure a little under that (measured ~1.19m), so
    // this allows a wider band than a pure-vacuum test would.
    expect(peak).toBeGreaterThan(1.1);
    expect(peak).toBeLessThan(1.25);
  });

  it("a straight-down drop bounces straight up with no horizontal drift", () => {
    const result = simulate(straightDrop);
    expect(result.floorPoint).not.toBeNull();
    const [x, z] = result.floorPoint!;
    expect(x).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(FT_LINE_Z_M, 6);

    // No sample ever drifts off the release x/z either, not just the landing point.
    const traj = result.trajectory;
    for (let i = 0; i < traj.length; i += 4) {
      expect(traj[i + 1]).toBeCloseTo(0, 6); // x
    }
  });

  it("kinetic + potential energy never increases during unobstructed flight", () => {
    // Reconstructing velocity by finite-differencing simulate()'s decimated
    // trajectory is too noisy right around a bounce (see applyContactImpulse's
    // export comment), so this checks the smooth part of several realistic
    // shots using only same-width periodic-interval sample pairs, which keeps
    // the finite-difference numerically honest.
    const shots: ShotParams[] = [
      { heightCm: 190, angleDeg: 52, aimDeg: 0, speed: 7.5, spinRps: 2.5 },
      { heightCm: 160, angleDeg: 40, aimDeg: -8, speed: 6.0, spinRps: 4.0 },
      { heightCm: 220, angleDeg: 60, aimDeg: 10, speed: 8.5, spinRps: 0 },
      { heightCm: 190, angleDeg: 35, aimDeg: 6, speed: 9.0, spinRps: 3.5 },
    ];
    const PERIODIC_INTERVAL_S = 0.01;
    const ENERGY_NOISE_TOLERANCE_J = 0.05; // observed finite-difference noise floor is ~0.02J

    for (const shot of shots) {
      const result = simulate(shot);
      const traj = result.trajectory;
      let prevEnergy: number | null = null;
      for (let i = 0; i < traj.length - 4; i += 4) {
        const t0 = traj[i];
        const y0 = traj[i + 2];
        const t1 = traj[i + 4];
        const dt = t1 - t0;
        if (Math.abs(dt - PERIODIC_INTERVAL_S) > 0.001) {
          prevEnergy = null; // irregular interval (adjacent to a forced collision sample) — skip
          continue;
        }
        const vx = (traj[i + 5] - traj[i + 1]) / dt;
        const vy = (traj[i + 6] - traj[i + 2]) / dt;
        const vz = (traj[i + 7] - traj[i + 3]) / dt;
        const energy = 0.5 * BALL_MASS_KG * (vx * vx + vy * vy + vz * vz) + BALL_MASS_KG * 9.81 * y0;
        if (prevEnergy !== null) {
          expect(energy).toBeLessThanOrEqual(prevEnergy + ENERGY_NOISE_TOLERANCE_J);
        }
        prevEnergy = energy;
      }
    }
  });

  it("a single rim/backboard/floor contact never increases translational + rotational energy", () => {
    // Direct, artifact-free test of applyContactImpulse itself, covering the
    // "across any bounce" half of the energy invariant that simulate()'s
    // decimated trajectory can't reliably verify (see the test above).
    const kineticPlusRotational = (velX: number, velY: number, velZ: number, spinX: number, spinY: number, spinZ: number) =>
      0.5 * BALL_MASS_KG * (velX * velX + velY * velY + velZ * velZ) + 0.5 * BALL_INERTIA_KGM2 * (spinX * spinX + spinY * spinY + spinZ * spinZ);

    const normals: [number, number, number][] = [
      [0, 1, 0], // floor
      [0, 0, -1], // backboard
      [0.6, 0.4, -0.6928], // an arbitrary unit-ish rim contact normal (normalized below)
    ];

    let cases = 0;
    for (const [nx0, ny0, nz0] of normals) {
      const nLen = Math.hypot(nx0, ny0, nz0);
      const nx = nx0 / nLen;
      const ny = ny0 / nLen;
      const nz = nz0 / nLen;
      for (let trial = 0; trial < 40; trial++) {
        // Deterministic pseudo-random incoming velocity/spin, biased toward
        // "approaching" the surface so applyContactImpulse actually does something.
        const seed = trial * 7 + nx * 13 + ny * 17 + nz * 19;
        const rnd = (k: number) => {
          const v = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453;
          return v - Math.floor(v);
        };
        const velX = (rnd(1) - 0.5) * 20;
        const velY = -Math.abs(rnd(2)) * 20 - 0.1; // biased downward/inward
        const velZ = (rnd(3) - 0.5) * 20;
        const spinX = (rnd(4) - 0.5) * 40;
        const spinY = (rnd(5) - 0.5) * 40;
        const spinZ = (rnd(6) - 0.5) * 40;

        const before = kineticPlusRotational(velX, velY, velZ, spinX, spinY, spinZ);
        const after = applyContactImpulse(velX, velY, velZ, spinX, spinY, spinZ, nx, ny, nz, FLOOR_RESTITUTION, 0.5);
        const afterEnergy = kineticPlusRotational(after.velX, after.velY, after.velZ, after.spinX, after.spinY, after.spinZ);

        expect(afterEnergy).toBeLessThanOrEqual(before + 1e-9);
        cases++;
      }
    }
    expect(cases).toBe(normals.length * 40);
  });

  it("simulate(p) called twice returns identical catchPoint values", () => {
    // A dedicated check for the Phase 2 spec's specific wording, on top of
    // the broader determinism test above (which already covers this).
    const rimMissParams: ShotParams = { heightCm: 190, angleDeg: 50, aimDeg: 0, speed: 6.78, spinRps: 2.5 };
    const r1 = simulate(rimMissParams);
    const r2 = simulate(rimMissParams);
    expect(r1.catchPoint).toEqual(r2.catchPoint);
  });

  it("a well-aimed free throw returns outcome: 'made'", () => {
    // Found by sweeping angle/speed at aim=0 under the Phase 2 physics
    // (drag, Magnus, and rim friction all shift where "made" lands compared
    // to the pre-Phase-2 model in core.v1.golden.json).
    const wellAimed: ShotParams = { heightCm: 190, angleDeg: 50, aimDeg: 0, speed: 7.2, spinRps: 2.5 };
    const result = simulate(wellAimed);
    expect(result.outcome).toBe("made");
  });

  it("catchPoint is defined for every miss, not just rim-touching ones", () => {
    const airball: ShotParams = { heightCm: 190, angleDeg: 45, aimDeg: 0, speed: 5.5, spinRps: 2.5 };
    const airballResult = simulate(airball, { recordTrajectory: false });
    expect(airballResult.outcome).toBe("airball");
    expect(airballResult.rimContacts).toBe(0);
    expect(airballResult.catchPoint).not.toBeNull();

    // speed 7.65 at this angle used to be the "backboard-only miss" fixture
    // here, but it actually rattles back off the backboard and drops through
    // the hoop — a made basket, not a miss (see the made-shot detection fix
    // in core.ts, which used to require rimContacts === 0 to count as made,
    // silently misclassifying rattle-ins like this one as backboard_miss).
    // This angle/speed genuinely never goes in, so it's a real backboard-only miss.
    const backboardOnly: ShotParams = { heightCm: 190, angleDeg: 40, aimDeg: 0, speed: 8.3, spinRps: 2.5 };
    const backboardResult = simulate(backboardOnly, { recordTrajectory: false });
    expect(backboardResult.outcome).toBe("backboard_miss");
    expect(backboardResult.rimContacts).toBe(0);
    expect(backboardResult.catchPoint).not.toBeNull();
  });

  it("a rim or backboard contact re-arms the catch point instead of keeping a pre-bounce guess", () => {
    // The default slider shot touches the rim multiple times, then the
    // backboard, then drops through the hoop — made, not a miss (see the
    // made-shot detection fix in core.ts: this used to be misclassified as
    // backboard_miss because "made" required zero prior rim/backboard
    // contact, even though the ball genuinely goes in after rattling
    // around). catchPoint should reflect the descent *after* whichever bounce
    // came last, not an early candidate invalidated by a later one.
    const result = simulate({ heightCm: 190, angleDeg: 52, aimDeg: 0, speed: 7.5, spinRps: 2.5 }, { recordTrajectory: false });
    expect(result.outcome).toBe("made");
    expect(result.rimContacts).toBeGreaterThan(0);
    expect(result.catchPoint).not.toBeNull();
    expect(result.catchTime).not.toBeNull();
    expect(result.floorTime).not.toBeNull();
    // The catch point must come down before the ball reaches the floor.
    expect(result.catchTime!).toBeLessThan(result.floorTime!);
  });
});
