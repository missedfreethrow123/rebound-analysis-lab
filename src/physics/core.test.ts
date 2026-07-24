import { describe, expect, it } from "vitest";
import { simulate, type ShotParams } from "./core";

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
      expect(lastSampleTime).toBeLessThanOrEqual(SIM_MAX_DURATION_S);
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
