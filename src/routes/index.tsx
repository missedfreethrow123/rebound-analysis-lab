import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useMemo, useState } from "react";
import { useHydrated } from "@/lib/useHydrated";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { SimControls } from "@/components/FreeThrowSim";

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

type Marker = { x: number; z: number };
type Stats = {
  landingX: number; landingZ: number; airTime: number; impactVel: number;
  maxHeight: number; rimContacts: number; backboardHit: boolean;
  floorBounces: number; travelDist: number;
};

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

  const controls = useMemo<SimControls>(
    () => ({ playerHeightCm, angleDeg, aimDeg, power }),
    [playerHeightCm, angleDeg, aimDeg, power],
  );

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
          <Button variant="outline" onClick={() => { setMarkers([]); setStats(null); }}>Clear</Button>
        </div>
        {!canShoot && (
          <p className="text-xs text-destructive -mt-4">
            Trajectory misses the rim entirely — adjust your aim before shooting.
          </p>
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
            />
          </Suspense>
        ) : (
          <div className="p-8 text-muted-foreground">Loading…</div>
        )}
      </main>
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
