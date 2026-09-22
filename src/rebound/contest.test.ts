import { describe, expect, it } from "vitest";
import { contestLanding, isInboundsLanding, isAttackerEligible, startDelayFor, PAIRING, REACTION_S, SHOOTER_RECOVERY_S, PLAYER_SPEED_MPS } from "./contest";
import { PLAYERS } from "./players";

const dL = PLAYERS.find((p) => p.id === "D_L")!;
const dR = PLAYERS.find((p) => p.id === "D_R")!;
const d3 = PLAYERS.find((p) => p.id === "D_3")!;
const oL = PLAYERS.find((p) => p.id === "O_L")!;
const oR = PLAYERS.find((p) => p.id === "O_R")!;
const shooter = PLAYERS.find((p) => p.id === "SHOOTER")!;

describe("PAIRING (global minimum-total-distance matching)", () => {
  it("pairs each same-side block defender with the attacker directly behind them, and the third defender with the shooter", () => {
    // D_L/O_L share x=-2.45, D_R/O_R share x=+2.45 — those are each other's
    // closest possible partner by construction (same lane column). D_3 is
    // the only defender left over, so it pairs with the only attacker left
    // over, the shooter — regardless of which of D_L/D_R happens to render
    // on the screen's visual left or right (see players.ts's camera note).
    expect(PAIRING).toHaveLength(3);
    const byDefender = Object.fromEntries(PAIRING.map((p) => [p.defenderId, p.attackerId]));
    expect(byDefender["D_L"]).toBe("O_L");
    expect(byDefender["D_R"]).toBe("O_R");
    expect(byDefender["D_3"]).toBe("SHOOTER");
  });

  it("really is the minimum: no other 1-to-1 matching has a smaller total distance", () => {
    const defenders = [dL, dR, d3];
    const attackers = [oL, oR, shooter];
    const permute = (items: typeof attackers): (typeof attackers)[] =>
      items.length <= 1
        ? [items]
        : items.flatMap((item, i) => permute([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));

    const chosenTotal = PAIRING.reduce((sum, p) => sum + p.distance, 0);
    for (const perm of permute(attackers)) {
      const total = defenders.reduce((sum, d, i) => sum + Math.hypot(d.x - perm[i].x, d.z - perm[i].z), 0);
      expect(total).toBeGreaterThanOrEqual(chosenTotal - 1e-9);
    }
  });
});

describe("startDelayFor", () => {
  it("is REACTION_S for everyone except the shooter", () => {
    expect(startDelayFor("D_L")).toBeCloseTo(REACTION_S, 9);
    expect(startDelayFor("O_L")).toBeCloseTo(REACTION_S, 9);
    expect(startDelayFor("D_3")).toBeCloseTo(REACTION_S, 9);
  });

  it("is REACTION_S + SHOOTER_RECOVERY_S (0.6s) for the shooter", () => {
    expect(startDelayFor("SHOOTER")).toBeCloseTo(REACTION_S + SHOOTER_RECOVERY_S, 9);
    expect(startDelayFor("SHOOTER")).toBeCloseTo(0.6, 9);
  });
});

describe("isAttackerEligible (idealized box-out)", () => {
  it("an attacker is eligible only for landings farther from the rim than their own start", () => {
    const distToRim = Math.hypot(oL.x, oL.z);
    const farther = { x: oL.x, z: oL.z - 0.5 }; // more negative z = farther from rim
    const closer = { x: oL.x, z: oL.z + 0.5 }; // less negative z = closer to rim
    expect(Math.hypot(farther.x, farther.z)).toBeGreaterThan(distToRim);
    expect(Math.hypot(closer.x, closer.z)).toBeLessThan(distToRim);
    expect(isAttackerEligible(oL, farther)).toBe(true);
    expect(isAttackerEligible(oL, closer)).toBe(false);
  });
});

describe("contestLanding — idealized box-out with pairing (movement phase)", () => {
  it("a landing closer to the rim than every attacker is defense-only, and defense wins", () => {
    const result = contestLanding(0, 0);
    expect(result.winnerTeam).toBe("defense");
    const offenseArrivals = result.arrivals.filter((a) => a.team === "offense");
    expect(offenseArrivals.every((a) => !a.eligible)).toBe(true);
    const defenseArrivals = result.arrivals.filter((a) => a.team === "defense");
    expect(defenseArrivals.every((a) => a.eligible)).toBe(true);
  });

  it("a landing farther from the rim than a side attacker, right next to them, is one they're eligible for and can win", () => {
    // 0.1m farther from the rim than O_L's own start — same lane column, so
    // O_L is by far the closest player to it.
    const P = { x: oL.x, z: oL.z - 0.1 };
    const result = contestLanding(P.x, P.z);
    const oLArrival = result.arrivals.find((a) => a.id === "O_L")!;
    expect(oLArrival.eligible).toBe(true);
    expect(result.winnerTeam).toBe("offense");
    expect(result.winnerId).toBe("O_L");
  });

  it("the shooter is eligible past the free-throw line but their 0.6s recovery delay still loses to a nearer defender", () => {
    // Offset toward D_3 (the shooter's paired defender) and a bit past the
    // free-throw line in depth — eligible for the shooter (farther from the
    // rim than their own start) but D_3 sits right next to it with no start
    // delay, easily beating the shooter's 0.6s-delayed sprint from farther away.
    const P = { x: d3.x, z: shooter.z - 0.1 };
    const shooterDistToRim = Math.hypot(shooter.x, shooter.z);
    expect(Math.hypot(P.x, P.z)).toBeGreaterThan(shooterDistToRim);

    const result = contestLanding(P.x, P.z);
    const shooterArrival = result.arrivals.find((a) => a.id === "SHOOTER")!;
    expect(shooterArrival.eligible).toBe(true);
    expect(result.winnerId).not.toBe("SHOOTER");
    expect(result.winnerId).toBe("D_3");
    expect(result.winnerTeam).toBe("defense");
  });

  it("the shooter wins essentially nothing across a sample of REALISTIC rim-touching-miss landings", () => {
    // Realistic landings (per this app's own physics sweeps, checked earlier
    // this session) never fall farther from the rim than roughly the
    // free-throw line's own depth — deep isolated territory directly behind
    // the shooter (nobody else is ever out there) isn't a landing a real
    // rim-touching miss produces, so it's excluded from this sample by
    // capping z at the shooter's own depth.
    let shooterWins = 0;
    let sampled = 0;
    for (let x = -6; x <= 6; x += 0.5) {
      for (let z = shooter.z; z <= 1.5; z += 0.5) {
        if (!isInboundsLanding(x, z)) continue;
        sampled++;
        const result = contestLanding(x, z);
        if (result.winnerId === "SHOOTER") shooterWins++;
      }
    }
    expect(sampled).toBeGreaterThan(100);
    // "Essentially nothing": a small handful of cells right at the sample's
    // own depth cutoff (immediately beside the shooter) still go their way,
    // but well under 5% of the whole realistic landing area does.
    expect(shooterWins / sampled).toBeLessThan(0.05);
  });

  it("isInboundsLanding rejects points outside the sideline/baseline/half-court bounds", () => {
    expect(isInboundsLanding(0, 0)).toBe(true);
    expect(isInboundsLanding(10, 0)).toBe(false); // past the sideline
    expect(isInboundsLanding(0, 2)).toBe(false); // past the baseline (positive z, short side)
    expect(isInboundsLanding(0, -13)).toBe(false); // past half-court
  });

  it("a landing point outside the court has no contest", () => {
    const result = contestLanding(20, 0);
    expect(result.winnerTeam).toBe("out");
    expect(result.winnerId).toBeNull();
    expect(result.arrivals).toHaveLength(0);
  });

  it("arrival time is startDelayFor(id) plus travel time at PLAYER_SPEED_MPS", () => {
    // 3m further into the court (more negative z) than D_L, well inbounds.
    const landingX = dL.x;
    const landingZ = dL.z - 3;
    const dist = Math.hypot(landingX - dL.x, landingZ - dL.z);
    const result = contestLanding(landingX, landingZ);
    const dLArrival = result.arrivals.find((a) => a.id === "D_L")!;
    expect(dLArrival.arrival).toBeCloseTo(startDelayFor("D_L") + dist / PLAYER_SPEED_MPS, 9);
  });
});
