// Winner-map field: which team wins a rebound landing at each point on the
// floor, sampled over a grid. Pure function of the fixed player positions and
// the idealized box-out eligibility rule (src/rebound/contest.ts) — NOT of
// any swept shot data, so unlike the heat-map sweep this needs no Worker and
// can be recomputed synchronously any time it's needed.
//
// Region: x spans the full court width's near-basket portion, z runs from
// 8m out in front of the rim (past the free-throw line) back to the baseline
// — see BASELINE_TO_RIM_M below for why the far (baseline-side) edge uses
// that constant instead of a hardcoded 1.575.

import { BASELINE_TO_RIM_M } from "@/physics/constants";
import { contestLanding } from "./contest";

export const WINNER_FIELD_X_MIN = -7.5;
export const WINNER_FIELD_X_MAX = 7.5;
export const WINNER_FIELD_Z_MIN = -8; // 8m out in front of the rim, past the free-throw line
export const WINNER_FIELD_Z_MAX = BASELINE_TO_RIM_M; // the baseline itself — the field's far edge

export const WINNER_FIELD_CELL_SIZE_M = 0.15;
export const WINNER_FIELD_CELL_SIZE_MOBILE_M = 0.3; // coarser on mobile, same idea as the existing coarse sweep

// One byte per cell: 0 = offense, 1 = defense, 2 = neutral (tie or, at this
// region's edges, technically out of bounds — see contestLanding).
export const WINNER_FIELD_OFFENSE = 0;
export const WINNER_FIELD_DEFENSE = 1;
export const WINNER_FIELD_NEUTRAL = 2;

export interface WinnerField {
  nx: number;
  ny: number;
  cellSizeM: number;
  xMin: number;
  zMin: number;
  cells: Uint8Array; // nx*ny, index iy*nx+ix, iy=0 at zMin (matches worldToCell's row convention direction is irrelevant here — this module owns its own indexing)
}

export function computeWinnerField(cellSizeM: number): WinnerField {
  const nx = Math.max(1, Math.round((WINNER_FIELD_X_MAX - WINNER_FIELD_X_MIN) / cellSizeM));
  const ny = Math.max(1, Math.round((WINNER_FIELD_Z_MAX - WINNER_FIELD_Z_MIN) / cellSizeM));
  const cells = new Uint8Array(nx * ny);

  for (let iy = 0; iy < ny; iy++) {
    const z = WINNER_FIELD_Z_MIN + (iy + 0.5) * cellSizeM;
    for (let ix = 0; ix < nx; ix++) {
      const x = WINNER_FIELD_X_MIN + (ix + 0.5) * cellSizeM;
      const result = contestLanding(x, z);
      const code =
        result.winnerTeam === "offense"
          ? WINNER_FIELD_OFFENSE
          : result.winnerTeam === "defense"
            ? WINNER_FIELD_DEFENSE
            : WINNER_FIELD_NEUTRAL;
      cells[iy * nx + ix] = code;
    }
  }

  return { nx, ny, cellSizeM, xMin: WINNER_FIELD_X_MIN, zMin: WINNER_FIELD_Z_MIN, cells };
}
