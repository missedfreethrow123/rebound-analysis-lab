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
});
