// Turns a SweepGrid's counts into RGBA pixels for the heat map texture. Pure
// math only — no Canvas/ImageData/DOM — so the color ramp, sqrt transform,
// and blur kernel are unit-testable without a browser environment. The
// rendering layer (FreeThrowSim.tsx) wraps this output in an actual
// CanvasTexture.

import type { SweepGrid } from "../physics/sweepGrid";

export type HeatmapLayer = "all" | "rimTouch";

export interface HeatmapPixelOptions {
  // Which per-cell counts to visualize. "rimTouch" is the toggleable layer
  // from Phase 3's rimTouchCounts metadata — same grid, same colour ramp,
  // different source counts. Not a filter on the underlying sweep data.
  layer?: HeatmapLayer;
  // Number of 3x3 Gaussian-ish blur passes applied to the raw counts before
  // the sqrt/colour transform. HEATMAP_SPEC.md: "smooth with a small
  // Gaussian kernel (3x3 or 5x5)" — two 3x3 passes approximate a wider kernel
  // more cheaply than a true 5x5 convolution.
  blurPasses?: number;
}

const DEFAULT_BLUR_PASSES = 1;

// Separable-ish 3x3 blur with edge clamping (samples past the grid edge
// reuse the edge cell instead of wrapping or zero-padding, so the court
// boundary doesn't fade to black).
function blur3x3(src: Float32Array<ArrayBufferLike>, nx: number, ny: number): Float32Array<ArrayBufferLike> {
  const out = new Float32Array(nx * ny);
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const weights = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  const weightSum = 16;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      let acc = 0;
      let w = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const sx = clamp(ix + dx, 0, nx - 1);
          const sy = clamp(iy + dy, 0, ny - 1);
          const weight = weights[(dy + 1) * 3 + (dx + 1)];
          acc += src[sy * nx + sx] * weight;
          w += weight;
        }
      }
      out[iy * nx + ix] = acc / (w || weightSum);
    }
  }
  return out;
}

// Single-hue sequential ramp (HEATMAP_SPEC.md: "single-hue sequential ramp,
// light to dark. No rainbow"): a warm orange hue (matches the rim), constant
// hue, lightness ramping from pale to dark as density increases. Empty cells
// are fully transparent so the court art underneath is untouched; alpha
// ramps up alongside darkness so faint density is still visible without
// overwhelming the court lines drawn on top.
const HEATMAP_HUE_DEG = 18; // warm orange-red
const HEATMAP_SATURATION = 0.85;
const LIGHTNESS_AT_MIN = 0.92; // pale, near-white at the lowest nonzero density
const LIGHTNESS_AT_MAX = 0.32; // deep, dark orange-red at peak density
const ALPHA_AT_MIN = 60; // 0-255, faint but visible
const ALPHA_AT_MAX = 235;

function hslToRgb(hDeg: number, s: number, l: number): [number, number, number] {
  const h = hDeg / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (t0: number) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const r = hue2rgb(h + 1 / 3);
  const g = hue2rgb(h);
  const b = hue2rgb(h - 1 / 3);
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// t in [0,1], already sqrt-transformed. t=0 -> fully transparent.
function colorForIntensity(t: number): [number, number, number, number] {
  if (t <= 0) return [0, 0, 0, 0];
  const lightness = LIGHTNESS_AT_MIN + (LIGHTNESS_AT_MAX - LIGHTNESS_AT_MIN) * t;
  const [r, g, b] = hslToRgb(HEATMAP_HUE_DEG, HEATMAP_SATURATION, lightness);
  const alpha = Math.round(ALPHA_AT_MIN + (ALPHA_AT_MAX - ALPHA_AT_MIN) * t);
  return [r, g, b, alpha];
}

// Row-major, row 0 = grid iy=0 (the baseline row), same convention as
// SweepGrid.counts — the rendering layer is responsible for any flip needed
// to match its texture/UV convention, not this module.
export function computeHeatmapPixels(grid: SweepGrid, options?: HeatmapPixelOptions): Uint8ClampedArray {
  const layer = options?.layer ?? "all";
  const blurPasses = options?.blurPasses ?? DEFAULT_BLUR_PASSES;
  const source = layer === "rimTouch" ? grid.rimTouchCounts : grid.counts;

  let values: Float32Array<ArrayBufferLike> = new Float32Array(source.length);
  for (let i = 0; i < source.length; i++) values[i] = source[i];
  for (let p = 0; p < blurPasses; p++) values = blur3x3(values, grid.nx, grid.ny);

  let max = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i];

  const pixels = new Uint8ClampedArray(grid.nx * grid.ny * 4);
  for (let i = 0; i < values.length; i++) {
    // HEATMAP_SPEC.md: "normalise by the maximum cell count, then apply a
    // square-root transform" — these distributions are extremely peaked, so
    // a linear scale shows one dark dot and nothing else.
    const t = max > 0 ? Math.sqrt(values[i] / max) : 0;
    const [r, g, b, a] = colorForIntensity(t);
    const o = i * 4;
    pixels[o] = r;
    pixels[o + 1] = g;
    pixels[o + 2] = b;
    pixels[o + 3] = a;
  }
  return pixels;
}
