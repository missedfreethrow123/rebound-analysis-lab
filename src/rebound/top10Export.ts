// "Top 10 zonas" CSV/Excel export. Coordinate transform (internal core.ts
// frame -> this view's own court frame), stated once here and in the final
// report:
//   origin (0,0)      = centre of the rim, projected onto the floor (SAME
//                        origin core.ts already uses — no translation)
//   x_m   = core_x     (+x is already "shooter's right" in both frames)
//   y_m   = -core_z    (core.ts's +z is toward the backboard/baseline; the
//                        shooter and free-throw line sit at NEGATIVE core_z,
//                        so negating it makes +y_m "toward the free-throw line")
//   stipa_lenkis_deg = atan2(x_m, -y_m) = atan2(core_x, core_z), degrees —
//     0 deg at the back of the rim (toward the backboard, +core_z), +90 deg
//     at the shooter's right (+x), -90 deg at the shooter's left, +-180 deg
//     at the front of the rim (toward the shooter, -core_z). This is the
//     OPPOSITE 0/180 orientation from scripts/offenseShots.ts's own internal
//     rimHitAngleDegOf helper (0 deg = front there) — that one feeds a
//     different, unrelated report column; this formula follows the Top 10
//     zonas spec's own explicit convention instead.

import type { Top10ZoneShot } from "./top10Zones";
import { TOP10_ZONES } from "./top10Zones";

function round(v: number, dp: number): number {
  return Math.round(v * 10 ** dp) / 10 ** dp;
}

export function toExportXY(x: number, z: number): { x_m: number; y_m: number } {
  return { x_m: round(x, 3), y_m: round(-z, 3) };
}

export function rimAngleDeg(x: number, z: number): number {
  return round((Math.atan2(x, z) * 180) / Math.PI, 1);
}

export interface Top10ExportRow {
  zona: number; // 1-based
  lenkis_deg: number;
  virziens_deg: number;
  jauda_mps: number;
  iznakums: string;
  kurs_ieguva: string;
  x_m: number | null;
  y_m: number | null;
  stipa_x_m: number | null;
  stipa_y_m: number | null;
  stipa_lenkis_deg: number | null;
}

export const EXPORT_COLUMNS: (keyof Top10ExportRow)[] = [
  "zona", "lenkis_deg", "virziens_deg", "jauda_mps", "iznakums", "kurs_ieguva",
  "x_m", "y_m", "stipa_x_m", "stipa_y_m", "stipa_lenkis_deg",
];

export function buildExportRows(shots: Top10ZoneShot[]): Top10ExportRow[] {
  return shots.map((shot) => {
    const isOffense = shot.category === "offense";
    const catchXY = isOffense && shot.catchPoint ? toExportXY(shot.catchPoint.x, shot.catchPoint.z) : null;
    const rimXY = isOffense && shot.firstRimContact ? toExportXY(shot.firstRimContact.x, shot.firstRimContact.z) : null;
    const stipaAngle = isOffense && shot.firstRimContact ? rimAngleDeg(shot.firstRimContact.x, shot.firstRimContact.z) : null;
    return {
      zona: shot.zoneIndex + 1,
      lenkis_deg: shot.angleDeg,
      virziens_deg: shot.aimDeg,
      jauda_mps: shot.speedMps,
      iznakums: shot.category,
      kurs_ieguva: shot.winnerId ?? "",
      x_m: catchXY ? catchXY.x_m : null,
      y_m: catchXY ? catchXY.y_m : null,
      stipa_x_m: rimXY ? rimXY.x_m : null,
      stipa_y_m: rimXY ? rimXY.y_m : null,
      stipa_lenkis_deg: stipaAngle,
    };
  });
}

function csvCell(v: string | number | null): string {
  if (v === null) return "";
  const s = String(v);
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildTop10Csv(shots: Top10ZoneShot[]): string {
  const rows = buildExportRows(shots);
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const row of rows) lines.push(EXPORT_COLUMNS.map((c) => csvCell(row[c])).join(","));
  return lines.join("\n");
}

// Browser download helper: Blob + a transient object URL, same mechanism
// either file type uses.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function buildTop10Xlsx(shots: Top10ZoneShot[]): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Top 10 zonas");
  sheet.columns = EXPORT_COLUMNS.map((c) => ({ header: c, key: c, width: 14 }));
  sheet.addRows(buildExportRows(shots));
  const buffer = await workbook.xlsx.writeBuffer();
  return new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export function zoneLabel(zoneIndex: number): string {
  const z = TOP10_ZONES[zoneIndex];
  return `Zone ${zoneIndex + 1}: ${z.angleDeg}/${z.aimDeg}/${z.speedMps}`;
}
