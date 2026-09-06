import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { useHydrated } from "@/lib/useHydrated";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import type { SimControls } from "@/components/FreeThrowSim";
import { startSweep, type SweepHandle } from "@/physics/sweep";
import { defaultSweepConfig, sweepCacheKey, totalShotCount, type SweepConfig } from "@/physics/sweepConfig";
import type { SweepGrid, SweepStats } from "@/physics/sweepGrid";

const FreeThrowSim = lazy(() => import("@/components/FreeThrowSim"));

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Free Throw Miss Simulator" },
      { name: "description", content: "Physics-based basketball intentional miss rebound analyzer." },
      { property: "og:title", content: "Free Throw Miss Simulator" },
      { property: "og:description", content: "Physics-based basketball intentional miss rebound analyzer." },
    ],
  }),
  component: Index,
});

type Marker = { x: number; z: number; made: boolean };
type Stats = {
  landingX: number; landingZ: number; airTime: number; impactVel: number;
  maxHeight: number; rimContacts: number; backboardHit: boolean;
  floorBounces: number; travelDist: number;
};

type SweepPhase = "idle" | "running" | "done";

type CachedSweep = { grid: SweepGrid; stats: SweepStats; config: SweepConfig };

function Index() {
  const hydrated = useHydrated();
  const isMobile = useIsMobile();
  // Mobile-only bottom sheet open/closed state (desktop sidebar ignores this
  // — it's always shown, side-by-side, via lg: classes below).
  const [sheetOpen, setSheetOpen] = useState(true);
  const [playerHeightCm, setPlayerHeightCm] = useState(190);
  const [angleDeg, setAngleDeg] = useState(52);
  const [aimDeg, setAimDeg] = useState(0);
  const [power, setPower] = useState(7.5);
  const [shootTrigger, setShootTrigger] = useState(0);
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [canShoot, setCanShoot] = useState(true);

  // Heat map sweep state. The grid/stats objects handed back by startSweep's
  // progress callback are mutated in place and reused across calls (only the
  // wrapper is fresh each time — see sweep.ts), so setSweepGrid below can
  // receive the same reference on consecutive ticks; that's fine, since
  // setSweepStats/setSweepProgress change on every tick too and force the
  // re-render that picks up the (already-mutated) grid contents.
  const [heatmapOpacity, setHeatmapOpacity] = useState(0.7);
  const [sweepPhase, setSweepPhase] = useState<SweepPhase>("idle");
  const [sweepGrid, setSweepGrid] = useState<SweepGrid | null>(null);
  const [sweepStats, setSweepStats] = useState<SweepStats | null>(null);
  const [sweepConfig, setSweepConfig] = useState<SweepConfig | null>(null);
  const [sweepProgress, setSweepProgress] = useState<{ shotsCompleted: number; totalShotsPlanned: number } | null>(null);
  const sweepHandleRef = useRef<SweepHandle | null>(null);
  const sweepCacheRef = useRef(new Map<string, CachedSweep>());

  const controls = useMemo<SimControls>(
    () => ({ playerHeightCm, angleDeg, aimDeg, power }),
    [playerHeightCm, angleDeg, aimDeg, power],
  );

  const startHeatMap = () => {
    const config = defaultSweepConfig(playerHeightCm, isMobile);
    const key = sweepCacheKey(config);
    const cached = sweepCacheRef.current.get(key);
    if (cached) {
      setSweepGrid(cached.grid);
      setSweepStats(cached.stats);
      setSweepConfig(cached.config);
      setSweepProgress(null);
      setSweepPhase("done");
      return;
    }

    setSweepConfig(config);
    setSweepPhase("running");
    setSweepProgress({ shotsCompleted: 0, totalShotsPlanned: totalShotCount(config) });
    const handle = startSweep(config, (progress) => {
      setSweepGrid(progress.grid);
      setSweepStats(progress.stats);
      setSweepProgress({ shotsCompleted: progress.shotsCompleted, totalShotsPlanned: progress.totalShotsPlanned });
      if (progress.done) {
        sweepCacheRef.current.set(key, { grid: progress.grid, stats: progress.stats, config });
        sweepHandleRef.current = null;
        setSweepPhase("done");
      }
    });
    sweepHandleRef.current = handle;
  };

  const cancelHeatMap = () => {
    sweepHandleRef.current?.cancel();
    sweepHandleRef.current = null;
    // The partial map computed so far stays visible (sweepGrid/sweepStats
    // untouched) — cancelling means "stop where you are," not "discard it."
    setSweepPhase("idle");
    setSweepProgress(null);
  };

  const handleShoot = () => {
    if (!canShoot) return;
    setShootTrigger((n) => n + 1);
    // Mobile only: get the panel out of the way so the shot is unobstructed.
    if (isMobile) setSheetOpen(false);
  };

  // FreeThrowSim calls onStats exactly once per shot, at the same instant it
  // flips its internal st.flying to false and the aim box reappears (see the
  // animate() loop in FreeThrowSim.tsx) — the real "back in setup" signal, not
  // a guessed timer. Reopen the panel there so it's back for the next shot.
  const handleStats = (s: Stats) => {
    setStats(s);
    if (isMobile) setSheetOpen(true);
  };

  return (
    <div className="h-dvh w-full overflow-hidden bg-background text-foreground flex flex-col max-lg:landscape:flex-row lg:flex-row">
      {/* Controls: side-by-side sidebar on desktop (lg:static, always open)
          AND on mobile landscape (max-lg:landscape:static — same arrangement,
          just still slidable so Shoot can hide it, see the transform below).
          Portrait phones alone get the collapsible bottom sheet — `fixed`
          takes it out of flow there, so <main> below (the only remaining
          flex item in that one case) fills the whole screen full-bleed. */}
      <aside
        className={cn(
          "flex flex-col overflow-hidden bg-card",
          // Portrait mobile: bottom sheet (handle-based collapsible strip).
          "max-lg:portrait:fixed max-lg:portrait:inset-x-0 max-lg:portrait:bottom-0 max-lg:portrait:z-40 max-lg:portrait:rounded-t-2xl max-lg:portrait:border-t max-lg:portrait:border-border max-lg:portrait:shadow-2xl max-lg:portrait:transition-transform max-lg:portrait:duration-300 max-lg:portrait:ease-out max-lg:portrait:max-h-[35dvh] max-lg:portrait:h-[35dvh]",
          // Landscape mobile: the SAME static side-by-side arrangement as
          // desktop (below), just with transition/transform still live so it
          // can slide away on Shoot — desktop's version of these is frozen
          // (lg:transition-none, permanent lg:translate-y-0).
          "max-lg:landscape:static max-lg:landscape:z-auto max-lg:landscape:w-80 max-lg:landscape:h-full max-lg:landscape:max-h-none max-lg:landscape:border-r max-lg:landscape:border-border max-lg:landscape:transition-transform max-lg:landscape:duration-300 max-lg:landscape:ease-out",
          // Shared open/closed transform: open is the same "no offset" value
          // everywhere; closed differs — portrait peeks its handle, landscape
          // (no handle in this desktop-style arrangement) hides fully.
          sheetOpen
            ? "translate-y-0"
            : "max-lg:portrait:translate-y-[calc(100%-2.75rem)] max-lg:landscape:translate-y-full",
          "lg:static lg:z-auto lg:w-80 lg:h-full lg:max-h-none lg:translate-y-0 lg:rounded-none lg:border-r lg:border-border lg:shadow-none lg:transition-none",
        )}
      >
        {/* Drag handle: tap to open/close. Portrait-mobile only — desktop
            never shows it, and mobile landscape now uses the same always-
            expanded desktop arrangement (auto hide/show is Shoot-driven, not
            manual), so it's hidden there too. */}
        <button
          type="button"
          className="flex min-h-11 w-full shrink-0 flex-col items-center justify-center gap-1.5 lg:hidden max-lg:landscape:hidden"
          onClick={() => setSheetOpen((open) => !open)}
          aria-expanded={sheetOpen}
          aria-label={sheetOpen ? "Collapse controls panel" : "Expand controls panel"}
        >
          <span className="h-1.5 w-12 rounded-full bg-muted-foreground/40" />
        </button>

        <div className="w-full flex-1 flex flex-col gap-3 overflow-y-auto px-3 pb-3 pt-0 md:gap-6 md:px-6 md:pb-6 max-lg:landscape:pt-6 lg:pt-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Free Throw miss</h1>
          <p className="text-sm text-muted-foreground mt-1">Physics rebound analyzer</p>
        </div>

        <div className="space-y-1 md:space-y-2">
          <Label>Player height: {playerHeightCm} cm</Label>
          <Slider min={140} max={230} step={1} value={[playerHeightCm]} onValueChange={(v) => setPlayerHeightCm(v[0])} />
        </div>
        <div className="space-y-1 md:space-y-2">
          <Label>Release angle: {angleDeg}°</Label>
          <Slider min={20} max={80} step={1} value={[angleDeg]} onValueChange={(v) => setAngleDeg(v[0])} />
        </div>
        <div className="space-y-1 md:space-y-2">
          <Label>Horizontal aim: {aimDeg}°</Label>
          <Slider min={-30} max={30} step={1} value={[aimDeg]} onValueChange={(v) => setAimDeg(v[0])} />
        </div>
        <div className="space-y-1 md:space-y-2">
          <Label>Power: {power.toFixed(1)} m/s</Label>
          <Slider min={4} max={12} step={0.1} value={[power]} onValueChange={(v) => setPower(v[0])} />
        </div>

        <div className="flex flex-col gap-2 max-lg:landscape:flex-row lg:flex-row">
          <Button
            // Landscape mobile borrows desktop's row/flex-1/w-auto arrangement
            // but keeps h-11 (44px) instead of desktop's h-9 — finger-sized
            // tap targets take priority over pixel-identical desktop sizing.
            className="h-11 w-full max-lg:landscape:w-auto max-lg:landscape:flex-1 lg:h-9 lg:w-auto lg:flex-1"
            disabled={!canShoot}
            onClick={handleShoot}
          >
            Shoot
          </Button>
          <Button
            variant="secondary"
            className="h-11 w-full max-lg:landscape:w-auto max-lg:landscape:flex-1 lg:h-9 lg:w-auto lg:flex-1"
            disabled={sweepPhase === "running"}
            onClick={startHeatMap}
          >
            {sweepPhase === "running" ? "Computing…" : "Heat map"}
          </Button>
          <Button
            variant="outline"
            className="h-11 w-full max-lg:landscape:w-auto lg:h-9 lg:w-auto"
            onClick={() => { setMarkers([]); setStats(null); }}
          >
            Clear
          </Button>
        </div>
        {!canShoot && (
          <p className="text-xs text-destructive -mt-1 md:-mt-4">
            Trajectory misses the rim entirely — adjust your aim before shooting.
          </p>
        )}

        {sweepPhase === "running" && sweepProgress && (
          <div className="space-y-1 md:space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Sweeping… {sweepProgress.shotsCompleted.toLocaleString()} / {sweepProgress.totalShotsPlanned.toLocaleString()}</span>
              <span>{Math.round((sweepProgress.shotsCompleted / Math.max(1, sweepProgress.totalShotsPlanned)) * 100)}%</span>
            </div>
            <Progress value={(sweepProgress.shotsCompleted / Math.max(1, sweepProgress.totalShotsPlanned)) * 100} />
            <Button variant="outline" size="sm" className="h-11 w-full lg:h-8" onClick={cancelHeatMap}>
              Cancel
            </Button>
          </div>
        )}

        {sweepGrid && (
          <div className="space-y-1 md:space-y-2">
            <Label>Heat map opacity: {Math.round(heatmapOpacity * 100)}%</Label>
            <Slider
              min={0}
              max={100}
              step={1}
              value={[Math.round(heatmapOpacity * 100)]}
              onValueChange={(v) => setHeatmapOpacity(v[0] / 100)}
            />
          </div>
        )}

        <div className="rounded-md border border-border p-3 text-xs space-y-1 bg-muted/30">
          <div className="font-semibold text-sm mb-2">Last shot</div>
          {stats ? (
            <>
              <Row k="Landing X" v={stats.landingX.toFixed(2) + " m"} />
              <Row k="Landing Z" v={stats.landingZ.toFixed(2) + " m"} />
              <Row k="Dist from hoop" v={Math.hypot(stats.landingX, stats.landingZ).toFixed(2) + " m"} />
              <Row k="Air time" v={stats.airTime.toFixed(2) + " s"} />
              <Row k="Impact vel" v={stats.impactVel.toFixed(2) + " m/s"} />
              <Row k="Max height" v={stats.maxHeight.toFixed(2) + " m"} />
              <Row k="Rim contacts" v={String(stats.rimContacts)} />
              <Row k="Backboard" v={stats.backboardHit ? "yes" : "no"} />
              <Row k="Floor bounces" v={String(stats.floorBounces)} />
              <Row k="Travel dist" v={stats.travelDist.toFixed(2) + " m"} />
            </>
          ) : (
            <div className="text-muted-foreground">No shots yet.</div>
          )}
          <div className="pt-2 border-t border-border mt-2">
            Total shots: <span className="font-semibold">{markers.length}</span>
          </div>
        </div>

        {sweepStats && (
          <div className="rounded-md border border-border p-3 text-xs space-y-1 bg-muted/30">
            <div className="font-semibold text-sm mb-2">Heat map stats</div>
            <Row k="Shots swept" v={sweepStats.totalShots.toLocaleString()} />
            <Row k="Excluded (made)" v={sweepStats.excludedMadeCount.toLocaleString()} />
            <Row k="Touched rim" v={sweepStats.rimTouchPercent.toFixed(1) + "%"} />
            <Row
              k="Hottest cell"
              v={
                sweepStats.hottestCell
                  ? `(${sweepStats.hottestCell.x.toFixed(2)}, ${sweepStats.hottestCell.z.toFixed(2)}) m · ${sweepStats.hottestCell.count}`
                  : "—"
              }
            />
            <Row k="50% radius" v={sweepStats.radius50PercentM !== null ? sweepStats.radius50PercentM.toFixed(2) + " m" : "—"} />
            <Row k="Shooter's side" v={sweepStats.nearSideFraction !== null ? (sweepStats.nearSideFraction * 100).toFixed(1) + "%" : "—"} />
            <Row k="Beyond the rim" v={sweepStats.farSideFraction !== null ? (sweepStats.farSideFraction * 100).toFixed(1) + "%" : "—"} />
          </div>
        )}
        </div>
      </aside>

      <main className="flex-1 relative overflow-hidden overscroll-none">
        {hydrated ? (
          <Suspense fallback={<div className="p-8 text-muted-foreground">Loading scene…</div>}>
            <FreeThrowSim
              controls={controls}
              shootTrigger={shootTrigger}
              onStats={handleStats}
              onLanding={(m) => setMarkers((prev) => [...prev, m])}
              markers={markers}
              onCanShootChange={setCanShoot}
              heatmap={sweepGrid ? { grid: sweepGrid, opacity: heatmapOpacity, layer: "all" } : null}
              controlsOpen={sheetOpen}
            />
          </Suspense>
        ) : (
          <div className="p-8 text-muted-foreground">Loading…</div>
        )}
        {sweepConfig && sweepGrid && <HeatmapCaption config={sweepConfig} stats={sweepStats} />}
      </main>
    </div>
  );
}

// Conditions caption: HEATMAP_SPEC.md — "Caption the map with its conditions
// ... A screenshot of this must be self-explanatory a month later." Rendered
// as an overlay in the court viewport, not inside FreeThrowSim (which stays
// untouched — it only knows how to draw whatever grid it's given).
function HeatmapCaption({ config, stats }: { config: SweepConfig; stats: SweepStats | null }) {
  const excludedPct = stats && stats.totalShots > 0 ? ((stats.excludedMadeCount / stats.totalShots) * 100).toFixed(2) : null;
  return (
    <div className="absolute bottom-3 left-3 right-3 lg:right-auto lg:max-w-md rounded-md border border-border bg-card/90 p-3 text-xs text-muted-foreground space-y-1 pointer-events-none">
      <div>
        Shows where the ball first lands on the floor (not catch/chest height). Height {config.heightCm} cm ·
        Backspin {config.spinRps} rev/s · Angle {config.angle.min}–{config.angle.max}° (step {config.angle.step}°) ·
        Aim {config.aim.min}–{config.aim.max}° (step {config.aim.step}°) · Speed {config.speed.min}–
        {config.speed.max} m/s (step {config.speed.step} m/s)
      </div>
      <div>
        {stats ? stats.totalShots.toLocaleString() : "…"} shots swept
        {excludedPct !== null ? ` · ${excludedPct}% excluded as made` : ""}
      </div>
      <div>
        Map is thresholded, not blended: the opacity control hides the faintest, most spread-out cells first as it's
        lowered — a partially-faded view is not the full rebound spread.
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-mono">{v}</span>
    </div>
  );
}
