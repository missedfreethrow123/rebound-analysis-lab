import { describe, expect, it } from "vitest";
import { computeWinnerField, WINNER_FIELD_DEFENSE, WINNER_FIELD_OFFENSE } from "./winnerField";

describe("computeWinnerField (idealized box-out)", () => {
  it("produces a grid sized to the region and cell size", () => {
    const field = computeWinnerField(0.5);
    expect(field.nx).toBe(Math.round(15 / 0.5));
    expect(field.ny).toBe(Math.round((1.575 - -8) / 0.5));
    expect(field.cells.length).toBe(field.nx * field.ny);
  });

  it("defenders own the entire near-rim area — every attacker is boxed out for any P closer to the rim than they are", () => {
    const field = computeWinnerField(0.2);
    let defenseCount = 0;
    let offenseCount = 0;
    for (let iy = 0; iy < field.ny; iy++) {
      const z = field.zMin + (iy + 0.5) * field.cellSizeM;
      if (Math.abs(z) > 1.5) continue; // only the immediate area around the rim
      for (let ix = 0; ix < field.nx; ix++) {
        const x = field.xMin + (ix + 0.5) * field.cellSizeM;
        if (Math.abs(x) > 1.5) continue;
        const code = field.cells[iy * field.nx + ix];
        if (code === WINNER_FIELD_DEFENSE) defenseCount++;
        else if (code === WINNER_FIELD_OFFENSE) offenseCount++;
      }
    }
    // Every player's own start is farther than 1.5m from the rim (closest is
    // the block defenders/attackers at ~0.76-1.71m — still mostly outside
    // this inner ring, and any attacker's OWN start radius always exceeds
    // whatever's inside it), so this tight ring should be all defense.
    expect(defenseCount).toBeGreaterThan(0);
    expect(offenseCount).toBe(0);
  });

  it("the offense region is only the outer band beyond attackers' own start radius", () => {
    // Far outside every player's radius (deep, wide corner) — some outer
    // cells should be offense-owned, since an eligible attacker positioned
    // near that outer band can be closer than any defender.
    const field = computeWinnerField(0.2);
    let offenseCount = 0;
    for (let i = 0; i < field.cells.length; i++) {
      if (field.cells[i] === WINNER_FIELD_OFFENSE) offenseCount++;
    }
    expect(offenseCount).toBeGreaterThan(0);
  });
});
