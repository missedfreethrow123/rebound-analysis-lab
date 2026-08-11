import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { useHydrated } from "@/lib/useHydrated";
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
    const config = defaultSweepConfig(playerHeightCm);
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

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col lg:flex-row">
      <aside className="lg:w-80 w-full p-6 border-r border-border space-y-6 bg-card">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Free Throw miss</h1>
          <p className="text-sm text-muted-foreground mt-1">Physics rebound analyzer</p>
        </div>

        <div className="space-y-2">
          <Label>Player height: {playerHeightCm} cm</Label>
          <Slider min={140} max={230} step={1} value={[playerHeightCm]} onValueChange={(v) => setPlayerHeightCm(v[0])} />
        </div>
        <div className="space-y-2">
          <Label>Release angle: {angleDeg}°</Label>
          <Slider min={20} max={80} step={1} value={[angleDeg]} onValueChange={(v) => setAngleDeg(v[0])} />
        </div>
        <div className="space-y-2">
          <Label>Horizontal aim: {aimDeg}°</Label>
          <Slider min={-30} max={30} step={1} value={[aimDeg]} onValueChange={(v) => setAimDeg(v[0])} />
        </div>
        <div className="space-y-2">
          <Label>Power: {power.toFixed(1)} m/s</Label>
          <Slider min={4} max={12} step={0.1} value={[power]} onValueChange={(v) => setPower(v[0])} />
        </div>

        <div className="flex gap-2">
          <Button
            className="flex-1"
            disabled={!canShoot}
            onClick={() => canShoot && setShootTrigger((n) => n + 1)}
          >
            Shoot
          </Button>
          <Button
            variant="secondary"
            className="flex-1"
            disabled={sweepPhase === "running"}
            onClick={startHeatMap}
          >
            Heat map
          </Button>
          <Button variant="outline" onClick={() => { setMarkers([]); setStats(null); }}>Clear</Button>
        </div>
        {!canShoot && (
          <p className="text-xs text-destructive -mt-4">
            Trajectory misses the rim entirely — adjust your aim before shooting.
          </p>
        )}

        {sweepPhase === "running" && sweepProgress && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Sweeping… {sweepProgress.shotsCompleted.toLocaleString()} / {sweepProgress.totalShotsPlanned.toLocaleString()}</span>
              <span>{Math.round((sweepProgress.shotsCompleted / Math.max(1, sweepProgress.totalShotsPlanned)) * 100)}%</span>
            </div>
            <Progress value={(sweepProgress.shotsCompleted / Math.max(1, sweepProgress.totalShotsPlanned)) * 100} />
            <Button variant="outline" size="sm" className="w-full" onClick={cancelHeatMap}>
              Cancel
            </Button>
          </div>
        )}

        {sweepGrid && (
          <div className="space-y-2">
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
      </aside>

      <main className="flex-1 relative min-h-[60vh] lg:min-h-screen">
        {hydrated ? (
          <Suspense fallback={<div className="p-8 text-muted-foreground">Loading scene…</div>}>
            <FreeThrowSim
              controls={controls}
              shootTrigger={shootTrigger}
              onStats={setStats}
              onLanding={(m) => setMarkers((prev) => [...prev, m])}
              markers={markers}
              onCanShootChange={setCanShoot}
              heatmap={sweepGrid ? { grid: sweepGrid, opacity: heatmapOpacity, layer: "all" } : null}
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
