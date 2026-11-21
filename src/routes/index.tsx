import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useMemo, useRef, useState, type ReactNode } from "react";
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
import { SHOOTER_HEIGHT_CM, DEFAULT_BACKSPIN_RPS } from "@/physics/constants";
import { OFFENSE_COLOR, DEFENSE_COLOR } from "@/rebound/players";
import { contestLanding } from "@/rebound/contest";
import {
  TOP10_ZONES,
  SHOTS_PER_ZONE,
  ANGLE_ERROR_DEG,
  AIM_ERROR_DEG,
  SPEED_ERROR_MPS,
  iterateTop10ZoneShots,
  finalizeTop10Zones,
  type Top10ZoneShot,
  type ZoneCounts,
  type CountMismatch,
} from "@/rebound/top10Zones";
import { buildTop10Csv, buildTop10Xlsx, downloadBlob } from "@/rebound/top10Export";

const hexColor = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

function hexToRgb01(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// One zone's 125 shots per chunk — yields to the browser between chunks
// (via setTimeout) so a slow shot or ten doesn't freeze the UI for the
// whole ~1250-shot run.
const TOP10_CHUNK_SIZE = SHOTS_PER_ZONE;

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

type CachedSweep = {
  grid: SweepGrid;
  stats: SweepStats;
  points: Float32Array;
  contestPoints: Float32Array;
  contestFlightTimes: Float32Array;
  config: SweepConfig;
};

function Index() {
  const hydrated = useHydrated();
  const isMobile = useIsMobile();
  // Mobile-only bottom sheet open/closed state (desktop sidebar ignores this
  // — it's always shown, side-by-side, via lg: classes below).
  const [sheetOpen, setSheetOpen] = useState(true);
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
  const [heatmapOpacity, setHeatmapOpacity] = useState(0.2);
  const [sweepPhase, setSweepPhase] = useState<SweepPhase>("idle");
  const [sweepGrid, setSweepGrid] = useState<SweepGrid | null>(null);
  const [sweepStats, setSweepStats] = useState<SweepStats | null>(null);
  const [sweepPoints, setSweepPoints] = useState<Float32Array | null>(null);
  // Rebound-contest qualifying points: rim-touching misses' 2.44 m contest
  // points that land inbounds (src/rebound/contest.ts's isInboundsLanding).
  // Now the exact same population and points as sweepPoints — kept as a
  // separate array only because contestSplit below needs it paired with
  // contestFlightTimes, not because the two populations differ any more.
  const [contestPoints, setContestPoints] = useState<Float32Array | null>(null);
  // One entry per contestPoints point — see sweep.worker.ts's own comment;
  // the FIBA lane-player start time (ball release, not t_rim) varies with
  // each shot's own flight time to the rim, so contestSplit below needs this.
  const [contestFlightTimes, setContestFlightTimes] = useState<Float32Array | null>(null);
  const [sweepConfig, setSweepConfig] = useState<SweepConfig | null>(null);
  const [sweepProgress, setSweepProgress] = useState<{ shotsCompleted: number; totalShotsPlanned: number } | null>(null);
  const sweepHandleRef = useRef<SweepHandle | null>(null);
  const sweepTokenRef = useRef(0); // see its use inside startHeatMap for why
  const sweepCacheRef = useRef(new Map<string, CachedSweep>());

  // "Top 10 zonas" view state. Mutually exclusive with the heat map above —
  // opening one clears the other (see startTop10Zones/startHeatMap). Result
  // is cached in top10CacheRef once computed (same config every time, the
  // zones are hard-coded) so a second open/close cycle is instant, matching
  // the heat map's own cache-on-first-compute behavior.
  const [top10Phase, setTop10Phase] = useState<SweepPhase>("idle");
  const [top10Shots, setTop10Shots] = useState<Top10ZoneShot[] | null>(null);
  const [top10Counts, setTop10Counts] = useState<ZoneCounts[] | null>(null);
  const [top10Mismatches, setTop10Mismatches] = useState<CountMismatch[] | null>(null);
  const [top10Progress, setTop10Progress] = useState(0); // shots completed, 0..1250
  const [rimZoomed, setRimZoomed] = useState(false);
  const top10CacheRef = useRef<{ shots: Top10ZoneShot[]; countsByZone: ZoneCounts[]; mismatches: CountMismatch[] } | null>(null);
  const top10GenRef = useRef<Generator<Top10ZoneShot, void, void> | null>(null);
  const top10BufRef = useRef<Top10ZoneShot[]>([]);
  const top10CancelledRef = useRef(false);

  const controls = useMemo<SimControls>(() => ({ angleDeg, aimDeg, power }), [angleDeg, aimDeg, power]);

  // Memoized so FreeThrowSim's [heatmap] effect (which now rebuilds a whole
  // InstancedMesh, not just refills a texture) only re-runs when the point
  // set or opacity actually changes — not on every unrelated re-render from
  // an inline object literal getting a fresh identity each time.
  const heatmap = useMemo(
    () => (sweepPoints ? { points: sweepPoints, opacity: heatmapOpacity } : null),
    [sweepPoints, heatmapOpacity],
  );

  // Rebound-contest split, recomputed from the already-swept qualifying
  // points via the idealized box-out eligibility rule (src/rebound/contest.ts)
  // — no slider anymore, so this only needs to change when contestPoints
  // itself changes (a new sweep, or toggling the heat map off).
  const contestSplit = useMemo(() => {
    if (!contestPoints || contestPoints.length === 0 || !contestFlightTimes) return null;
    let offenseWins = 0;
    let defenseWins = 0;
    const qualifying = contestPoints.length / 2;
    for (let i = 0; i < qualifying; i++) {
      // FIBA 44.2.4: lane players move from ball release, not t_rim — see
      // contest.ts's startDelayFor. contestFlightTimes[i] is that shot's own
      // release-to-rim flight time (releaseToRimS), paired 1:1 with this point.
      const result = contestLanding(contestPoints[i * 2], contestPoints[i * 2 + 1], contestFlightTimes[i]);
      if (result.winnerTeam === "offense") offenseWins++;
      else if (result.winnerTeam === "defense") defenseWins++;
      else if (result.winnerTeam === "tie") {
        offenseWins += 0.5;
        defenseWins += 0.5;
      }
      // "out" can't occur here — every point in contestPoints already passed
      // isInboundsLanding in the worker.
    }
    return { qualifying, offensePercent: (offenseWins / qualifying) * 100, defensePercent: (defenseWins / qualifying) * 100 };
  }, [contestPoints, contestFlightTimes]);

  // Court dots (catch point) + rim dots (first rim contact) for every
  // OFFENSE shot, coloured by zone — the only outcome that gets drawn (see
  // the task spec: "For any other outcome, record neither"). Recomputed
  // only when the shot list itself changes (a fresh run, or closing the
  // view), not on every unrelated re-render.
  const top10RenderData = useMemo(() => {
    if (!top10Shots || top10Shots.length === 0) return null;
    const courtPoints: number[] = [];
    const courtColors: number[] = [];
    const rimPoints: number[] = [];
    const rimColors: number[] = [];
    for (const shot of top10Shots) {
      if (shot.category !== "offense") continue;
      const [r, g, b] = hexToRgb01(TOP10_ZONES[shot.zoneIndex].color);
      if (shot.catchPoint) {
        courtPoints.push(shot.catchPoint.x, shot.catchPoint.z);
        courtColors.push(r, g, b);
      }
      if (shot.firstRimContact) {
        rimPoints.push(shot.firstRimContact.x, shot.firstRimContact.z);
        rimColors.push(r, g, b);
      }
    }
    return {
      courtPoints: Float32Array.from(courtPoints),
      courtColors: Float32Array.from(courtColors),
      rimPoints: Float32Array.from(rimPoints),
      rimColors: Float32Array.from(rimColors),
    };
  }, [top10Shots]);

  // cameraOverride for FreeThrowSim: only active while the view is actually
  // showing (not mid-computation) — "orthographic" reuses the heat map's own
  // wide top-down camera; "rimCloseup" is the legend panel's zoom button.
  const top10CameraOverride = top10Phase === "done" && top10Shots ? (rimZoomed ? "rimCloseup" : "orthographic") : null;

  const closeTop10 = () => {
    top10GenRef.current = null;
    top10CancelledRef.current = true;
    top10BufRef.current = [];
    setTop10Phase("idle");
    setTop10Shots(null);
    setTop10Counts(null);
    setTop10Mismatches(null);
    setTop10Progress(0);
    setRimZoomed(false);
  };

  const runTop10Chunk = () => {
    const gen = top10GenRef.current;
    if (!gen || top10CancelledRef.current) return;
    for (let i = 0; i < TOP10_CHUNK_SIZE; i++) {
      const next = gen.next();
      if (next.done) {
        const shots = top10BufRef.current;
        const { countsByZone, mismatches } = finalizeTop10Zones(shots);
        if (mismatches.length > 0) {
          // Mandatory: log to console, never silently "fix" the physics/inputs.
          console.warn("Top 10 zonas: count mismatch vs. the team's expected breakdown", mismatches);
        }
        top10CacheRef.current = { shots, countsByZone, mismatches };
        setTop10Shots(shots);
        setTop10Counts(countsByZone);
        setTop10Mismatches(mismatches);
        setTop10Progress(shots.length);
        setTop10Phase("done");
        top10GenRef.current = null;
        return;
      }
      top10BufRef.current.push(next.value);
    }
    setTop10Progress(top10BufRef.current.length);
    setTimeout(runTop10Chunk, 0); // yield to the browser before the next zone's shots
  };

  const startTop10Zones = () => {
    if (top10Phase === "done" && top10Shots) {
      closeTop10();
      return;
    }
    if (top10Phase === "running") return;
    if (top10CacheRef.current) {
      const cached = top10CacheRef.current;
      setTop10Shots(cached.shots);
      setTop10Counts(cached.countsByZone);
      setTop10Mismatches(cached.mismatches);
      setTop10Progress(cached.shots.length);
      setTop10Phase("done");
      return;
    }
    // Mutually exclusive with the heat map — only one overlay at a time.
    if (sweepPoints || sweepPhase !== "idle") {
      sweepTokenRef.current++; // invalidate any in-flight progress delivery first — see startHeatMap's comment
      sweepHandleRef.current?.cancel();
      sweepHandleRef.current = null;
      setSweepPoints(null);
      setContestPoints(null);
      setContestFlightTimes(null);
      setSweepGrid(null);
      setSweepStats(null);
      setSweepConfig(null);
      setSweepPhase("idle");
      setSweepProgress(null);
    }
    top10CancelledRef.current = false;
    top10BufRef.current = [];
    setTop10Progress(0);
    setTop10Phase("running");
    top10GenRef.current = iterateTop10ZoneShots(SHOOTER_HEIGHT_CM, DEFAULT_BACKSPIN_RPS);
    runTop10Chunk();
  };

  const downloadTop10Csv = () => {
    if (!top10Shots) return;
    downloadBlob(new Blob([buildTop10Csv(top10Shots)], { type: "text/csv;charset=utf-8" }), "top10_zonas.csv");
  };
  const downloadTop10Xlsx = async () => {
    if (!top10Shots) return;
    downloadBlob(await buildTop10Xlsx(top10Shots), "top10_zonas.xlsx");
  };

  const startHeatMap = () => {
    // Mutually exclusive with "Top 10 zonas" — only one overlay at a time.
    if (top10Phase !== "idle") closeTop10();

    const config = defaultSweepConfig(SHOOTER_HEIGHT_CM, isMobile);
    const key = sweepCacheKey(config);

    // Shooter height is fixed (SHOOTER_HEIGHT_CM), so the config here only
    // ever varies with isMobile's coarse-grid flag — meaning after the first
    // computation for a given device class, every later click just toggles
    // cached state on/off (sweepCacheRef below) rather than resweeping.
    // Clicking again for the SAME config while a result is already showing
    // is a toggle-off: the sweep itself and its cache are left untouched, so
    // clicking once more afterwards reloads the same points instantly.
    if (sweepPhase === "done" && sweepPoints && sweepConfig && sweepCacheKey(sweepConfig) === key) {
      setSweepPoints(null);
      setContestPoints(null);
      setContestFlightTimes(null);
      setSweepGrid(null);
      setSweepStats(null);
      setSweepConfig(null);
      setSweepPhase("idle");
      return;
    }
    const cached = sweepCacheRef.current.get(key);
    if (cached) {
      setSweepGrid(cached.grid);
      setSweepStats(cached.stats);
      setSweepPoints(cached.points);
      setContestPoints(cached.contestPoints);
      setContestFlightTimes(cached.contestFlightTimes);
      setSweepConfig(cached.config);
      setSweepProgress(null);
      setSweepPhase("done");
      return;
    }

    setSweepConfig(config);
    setSweepPhase("running");
    setSweepProgress({ shotsCompleted: 0, totalShotsPlanned: totalShotCount(config) });
    // sweepTokenRef guards against a stale progress delivery: cancel() isn't
    // synchronous — each worker still flushes one final partial update after
    // receiving the cancel message (see sweep.ts's own comment on why: it
    // deliberately keeps partial progress for the Cancel BUTTON's use case).
    // That's correct there, but wrong when abandoning the sweep entirely
    // (switching to the "Top 10 zonas" view — see startTop10Zones), which
    // bumps this token first so this late callback becomes a no-op instead
    // of reviving heat-map state right after it was cleared.
    const myToken = ++sweepTokenRef.current;
    const handle = startSweep(config, (progress) => {
      if (sweepTokenRef.current !== myToken) return;
      setSweepGrid(progress.grid);
      setSweepStats(progress.stats);
      setSweepPoints(progress.points);
      setContestPoints(progress.contestPoints);
      setContestFlightTimes(progress.contestFlightTimes);
      setSweepProgress({ shotsCompleted: progress.shotsCompleted, totalShotsPlanned: progress.totalShotsPlanned });
      if (progress.done) {
        sweepCacheRef.current.set(key, {
          grid: progress.grid,
          stats: progress.stats,
          points: progress.points,
          contestPoints: progress.contestPoints,
          contestFlightTimes: progress.contestFlightTimes,
          config,
        });
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
          <Label>Player height: {SHOOTER_HEIGHT_CM} cm</Label>
          {/* Locked: the shooter's height is now a fixed constant (see
              SHOOTER_HEIGHT_CM) so the heat map sweep never depends on it and
              can be computed once and cached. Still shown, just disabled. */}
          <Slider min={140} max={230} step={1} value={[SHOOTER_HEIGHT_CM]} disabled />
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
            {sweepPhase === "running" ? "Computing…" : sweepPhase === "done" && sweepPoints ? "Hide heat map" : "Heat map"}
          </Button>
          <Button
            variant="secondary"
            className="h-11 w-full max-lg:landscape:w-auto max-lg:landscape:flex-1 lg:h-9 lg:w-auto lg:flex-1"
            disabled={top10Phase === "running"}
            onClick={startTop10Zones}
          >
            {top10Phase === "running" ? "Rēķina…" : top10Phase === "done" && top10Shots ? "Hide top 10 zonas" : "Top 10 zonas"}
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

        {top10Phase === "running" && (
          <div className="space-y-1 md:space-y-2">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Rēķina top 10 zonas… {top10Progress.toLocaleString()} / {(TOP10_ZONES.length * SHOTS_PER_ZONE).toLocaleString()}</span>
              <span>{Math.round((top10Progress / (TOP10_ZONES.length * SHOTS_PER_ZONE)) * 100)}%</span>
            </div>
            <Progress value={(top10Progress / (TOP10_ZONES.length * SHOTS_PER_ZONE)) * 100} />
          </div>
        )}

        {sweepPoints && (
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

        {sweepStats && contestSplit && (
          <div className="rounded-md border border-border p-3 text-xs space-y-1 bg-muted/30">
            <div className="font-semibold text-sm mb-2">Rebound contest</div>
            <Row
              k={<span style={{ color: hexColor(OFFENSE_COLOR) }} className="font-medium">Offense</span>}
              v={contestSplit.offensePercent.toFixed(1) + "%"}
            />
            <Row
              k={<span style={{ color: hexColor(DEFENSE_COLOR) }} className="font-medium">Defense</span>}
              v={contestSplit.defensePercent.toFixed(1) + "%"}
            />
            <div className="pt-2 border-t border-border mt-2 space-y-1">
              <Row k="Qualifying shots" v={contestSplit.qualifying.toLocaleString()} />
              <Row k="Landed out of bounds" v={sweepStats.contestOutOfBounds.toLocaleString()} />
              <Row k="Catch-height fallback" v={sweepStats.contestCatchFallbackCount.toLocaleString()} />
            </div>
            <div className="text-muted-foreground pt-1">
              Contested at standing-reach height (2.44m) in the air after the rim, not the floor landing.
              Qualifying = touched the rim AND that point landed inbounds. Winner = whoever starts closest among
              ELIGIBLE players — an attacker is boxed out (ineligible) for any point closer to the rim than they
              are; defenders are always eligible. Per FIBA, lane players (defenders and non-shooter attackers) may
              move from the moment the ball leaves the shooter's hand, plus a 0.28s reaction; the shooter can't move
              until the ball touches the rim, plus the same 0.28s reaction — no extra delay. Catch-height
              fallback = shots that never came back down through 2.44m after the rim, so the floor landing was used
              instead — should be ~0.
            </div>
          </div>
        )}

        {top10Phase === "done" && top10Counts && (
          <Top10ZonasPanel
            counts={top10Counts}
            mismatches={top10Mismatches ?? []}
            rimZoomed={rimZoomed}
            onToggleZoom={() => setRimZoomed((v) => !v)}
            onDownloadCsv={downloadTop10Csv}
            onDownloadXlsx={downloadTop10Xlsx}
          />
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
              heatmap={heatmap}
              top10Zones={top10RenderData}
              cameraOverride={top10CameraOverride}
              controlsOpen={sheetOpen}
              isMobile={isMobile}
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
        Each dot marks where a rim-touching miss first comes down through 2.44 m (standing-reach height) after
        hitting the rim — the point where players contest the ball in the air, not the floor landing. Made shots,
        airballs and backboard-only misses are excluded. Height {config.heightCm} cm · Backspin{" "}
        {config.spinRps} rev/s · Angle {config.angle.min}–{config.angle.max}° (step {config.angle.step}°) · Aim{" "}
        {config.aim.min}–{config.aim.max}° (step {config.aim.step}°) · Speed {config.speed.min}–{config.speed.max}{" "}
        m/s (step {config.speed.step} m/s)
      </div>
      <div>
        {stats ? stats.totalShots.toLocaleString() : "…"} shots swept
        {excludedPct !== null ? ` · ${excludedPct}% excluded as made` : ""}
      </div>
      <div>
        Each rim-touching miss is a small translucent dot; density is shown only by dots overlapping, not by colour —
        the opacity control fades every dot equally.
      </div>
    </div>
  );
}

function Row({ k, v }: { k: ReactNode; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className="font-mono">{v}</span>
    </div>
  );
}

// "Top 10 zonas" legend — same panel style as the heat-map stats/rebound
// contest panels above (rounded-md border p-3 text-xs bg-muted/30).
function Top10ZonasPanel({
  counts,
  mismatches,
  rimZoomed,
  onToggleZoom,
  onDownloadCsv,
  onDownloadXlsx,
}: {
  counts: ZoneCounts[];
  mismatches: CountMismatch[];
  rimZoomed: boolean;
  onToggleZoom: () => void;
  onDownloadCsv: () => void;
  onDownloadXlsx: () => void;
}) {
  return (
    <div className="rounded-md border border-border p-3 text-xs space-y-2 bg-muted/30">
      <div className="font-semibold text-sm">Top 10 zonas — kur metājs trāpa stīpai un kur uzbrucēji noķer bumbu</div>

      <div className="space-y-1">
        {TOP10_ZONES.map((zone, i) => {
          const offensePercent = (counts[i].offense / SHOTS_PER_ZONE) * 100;
          return (
            <div key={i} className="flex items-center gap-2">
              <span className="inline-block h-3 w-3 shrink-0 rounded-full border border-black/20" style={{ backgroundColor: zone.color }} />
              <span className="w-6 shrink-0 font-mono">{i + 1}.</span>
              <span className="flex-1 font-mono text-[11px] leading-tight">
                {(zone.angleDeg - ANGLE_ERROR_DEG).toFixed(1)}–{(zone.angleDeg + ANGLE_ERROR_DEG).toFixed(1)}° ·{" "}
                {(zone.aimDeg - AIM_ERROR_DEG).toFixed(1)}–{(zone.aimDeg + AIM_ERROR_DEG).toFixed(1)}° ·{" "}
                {(zone.speedMps - SPEED_ERROR_MPS).toFixed(2)}–{(zone.speedMps + SPEED_ERROR_MPS).toFixed(2)} m/s
              </span>
              <span className="font-mono shrink-0">{offensePercent.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>

      <div className="text-muted-foreground pt-1 border-t border-border">
        Punkti uz stīpas = kur bumba pirmo reizi pieskaras stīpai. Punkti uz laukuma = kur uzbrucēji noķer bumbu.
        Rādīti tikai metieni, kuros bumbu ieguva uzbrucēji. Zona = centrs ± metāja kļūda; 125 metieni zonā.
      </div>

      {mismatches.length > 0 && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-2 text-destructive space-y-0.5">
          <div className="font-semibold">Neatbilstība sagaidāmajiem skaitļiem:</div>
          {mismatches.map((m, i) => (
            <div key={i} className="font-mono text-[11px]">
              Zone {m.zoneIndex + 1} · {m.outcome}: expected {m.expected}, got {m.got}
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="h-9 flex-1 lg:h-8" onClick={onToggleZoom}>
          {rimZoomed ? "Rādīt laukumu" : "Tuvināt stīpu"}
        </Button>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" className="h-9 flex-1 lg:h-8" onClick={onDownloadCsv}>
          Lejupielādēt CSV
        </Button>
        <Button variant="outline" size="sm" className="h-9 flex-1 lg:h-8" onClick={onDownloadXlsx}>
          Lejupielādēt Excel
        </Button>
      </div>
    </div>
  );
}
