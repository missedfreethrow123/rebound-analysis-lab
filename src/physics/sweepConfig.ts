// Sweep configuration: the parameter ranges swept, shared between the main
// thread (sweep.ts, which splits the angle range across workers and totals
// the planned shot count) and each worker (sweep.worker.ts, which expands its
// assigned angle slice plus the full aim/speed grid into concrete ShotParams).

import { DEFAULT_BACKSPIN_RPS } from "./constants";
import type { ShotResult } from "./core";

export interface RangeConfig {
  min: number;
  max: number;
  step: number;
}

export interface SweepConfig {
  heightCm: number; // fixed — taken from the slider at sweep time
  spinRps: number; // fixed — default DEFAULT_BACKSPIN_RPS
  angle: RangeConfig;
  aim: RangeConfig;
  speed: RangeConfig;
  record: "catchPoint" | "floorPoint";
  excludeMade: boolean;
}

// Bump whenever core.ts's physics changes — a cached sweep keyed without this
// would silently show a stale map next to the new single-shot physics.
export const PHYSICS_VERSION = 2;

export const DEFAULT_SWEEP_RANGES: Pick<SweepConfig, "angle" | "aim" | "speed" | "record" | "excludeMade"> = {
  angle: { min: 35, max: 65, step: 0.5 },
  aim: { min: -12, max: 12, step: 0.5 },
  speed: { min: 5.5, max: 9.0, step: 0.05 },
  record: "catchPoint",
  excludeMade: true,
};

export function defaultSweepConfig(heightCm: number): SweepConfig {
  return { heightCm, spinRps: DEFAULT_BACKSPIN_RPS, ...DEFAULT_SWEEP_RANGES };
}

// Expands a RangeConfig into concrete values [min, min+step, ..., max]. Index-
// based (value = min + i*step) rather than repeated addition, so float drift
// can't accumulate across thousands of steps; rounded to 6 decimals to keep
// e.g. 35.00000000004 from leaking into cache keys or displayed captions.
export function expandRange(range: RangeConfig): number[] {
  const count = rangeStepCount(range);
  const values = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    values[i] = Math.round((range.min + i * range.step) * 1e6) / 1e6;
  }
  return values;
}

export function rangeStepCount(range: RangeConfig): number {
  return Math.round((range.max - range.min) / range.step) + 1;
}

export function totalShotCount(config: SweepConfig): number {
  return rangeStepCount(config.angle) * rangeStepCount(config.aim) * rangeStepCount(config.speed);
}

// Splits `values` into up to `workerCount` contiguous, as-even-as-possible
// slices — used to hand each worker its own share of the angle range
// (HEATMAP_SPEC.md: "Split the angle range between them").
export function splitEvenly<T>(values: T[], workerCount: number): T[][] {
  const n = values.length;
  const count = Math.max(1, Math.min(workerCount, n));
  const base = Math.floor(n / count);
  const extra = n % count;
  const slices: T[][] = [];
  let offset = 0;
  for (let w = 0; w < count; w++) {
    const size = base + (w < extra ? 1 : 0);
    slices.push(values.slice(offset, offset + size));
    offset += size;
  }
  return slices;
}

export function pickRecordPoint(config: SweepConfig, result: ShotResult): [number, number] | null {
  return config.record === "catchPoint" ? result.catchPoint : result.floorPoint;
}
