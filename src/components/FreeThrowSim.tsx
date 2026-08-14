import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { Button } from "@/components/ui/button";
import { simulate, releaseHeightM, type ShotParams, type ShotResult } from "@/physics/core";
import {
  DEFAULT_BACKSPIN_RPS,
  COURT_WIDTH_M,
  HALF_COURT_LENGTH_M,
  BASELINE_TO_RIM_M,
  BACKBOARD_FROM_BASELINE_M,
  LANE_LENGTH_M,
  RIM_HEIGHT_M,
  RIM_RADIUS_M,
  RIM_TUBE_RADIUS_M,
  BACKBOARD_W_M,
  BACKBOARD_H_M,
  BACKBOARD_Y_ABOVE_RIM_M,
  BALL_RADIUS_M,
} from "@/physics/constants";
import { GRID_NX, GRID_NY, GRID_CELL_SIZE_M, type SweepGrid } from "@/physics/sweepGrid";
import { computeHeatmapPixels, type HeatmapLayer } from "@/rendering/heatmapPixels";

type Marker = { x: number; z: number; made: boolean };
type Stats = {
  landingX: number;
  landingZ: number;
  airTime: number;
  impactVel: number;
  maxHeight: number;
  rimContacts: number;
  backboardHit: boolean;
  floorBounces: number;
  travelDist: number;
};

export type SimControls = {
  playerHeightCm: number;
  angleDeg: number;
  aimDeg: number;
  power: number;
};

// ---------------------------------------------------------------------------
// FIBA half-court specification, in meters. Every court line below is derived
// from these constants (never hardcoded) via a single meters-to-world-units
// scale factor, so the whole court can be resized uniformly by changing
// COURT_SCALE alone. The rim's floor projection is the (x=0, z=0) reference
// point for every arc, per FIBA convention. Note: ball physics (GRAVITY,
// shot power, etc.) are independent of court geometry and stay in real m/s
// units regardless of COURT_SCALE — only change COURT_SCALE if you also
// intend to rescale the physics constants below to match.
// ---------------------------------------------------------------------------
const COURT_SCALE = 1; // meters -> world units (scene is 1:1 with real meters)
const M = (meters: number) => meters * COURT_SCALE;

// Geometry values below are sourced from src/physics/constants.ts — the same
// numbers the physics core (src/physics/core.ts) integrates against — so the
// rendered rim/backboard/court can never drift out of sync with what the ball
// actually collides with. Only purely decorative lines that physics never
// touches (paint width, arcs, circles) stay as local-only constants here.
const COURT_WIDTH = M(COURT_WIDTH_M); // full width of the half-court, sideline to sideline
const HALF_COURT_LENGTH = M(HALF_COURT_LENGTH_M); // baseline to half-court line
const BASELINE_TO_RIM = M(BASELINE_TO_RIM_M); // baseline to the rim-center floor projection (FIBA)
const BACKBOARD_FROM_BASELINE = M(BACKBOARD_FROM_BASELINE_M); // backboard set in from the baseline
const LANE_WIDTH = M(4.9); // free-throw lane (key) width, centered on the basket axis
const LANE_LENGTH = M(LANE_LENGTH_M); // baseline to free-throw line
const FT_CIRCLE_R = M(1.8); // free-throw circle radius
const THREE_PT_R = M(6.75); // three-point arc radius, constant all the way around
const THREE_PT_SIDE_OFFSET = M(0.9); // corner straight segments, offset in from the sideline
const RESTRICTED_AREA_R = M(1.25); // no-charge semicircle radius
const CENTER_CIRCLE_R = M(1.8); // center circle radius

// Derived reference lines/points (all relative to the rim at x=0, z=0)
const SIDELINE_X = COURT_WIDTH / 2;
const LANE_HALF_WIDTH = LANE_WIDTH / 2;
const THREE_PT_CORNER_X = SIDELINE_X - THREE_PT_SIDE_OFFSET;
const BASELINE_Z = BASELINE_TO_RIM;
// Free-throw line distance, derived from BASELINE_TO_RIM_M/LANE_LENGTH_M —
// nets ~4.225 m to the rim, the same FIBA figure core.ts derives its release
// point from. See the longer note in physics/constants.ts.
const FT_LINE_Z = BASELINE_Z - LANE_LENGTH;
const HALF_COURT_Z = BASELINE_Z - HALF_COURT_LENGTH;

// Rim/backboard (meters)
const RIM_Y = M(RIM_HEIGHT_M);
const RIM_RADIUS = M(RIM_RADIUS_M); // 45cm inner diameter (FIBA)
const RIM_TUBE = M(RIM_TUBE_RADIUS_M);
const RIM_Z = 0; // rim center z (reference point)
const BACKBOARD_Z = BASELINE_Z - BACKBOARD_FROM_BASELINE; // backboard front face
const BACKBOARD_W = M(BACKBOARD_W_M);
const BACKBOARD_H = M(BACKBOARD_H_M);
const BACKBOARD_Y = RIM_Y + M(BACKBOARD_Y_ABOVE_RIM_M); // center (bottom edge sits 0.15m below rim: 2.90m)

const BALL_R = M(BALL_RADIUS_M); // size 6-ish

// Render-only: where the *decorative* near-baseline court markings (the
// baseline itself, the key's baseline edge, the sidelines' baseline end, the
// restricted-area's side lines, and the 3PT arc's baseline anchors) are drawn.
// At the rulebook-accurate BASELINE_Z, the backboard/rim — correctly placed
// relative to the physics baseline — still read as floating a long way past
// a big stretch of bare floor beyond the key, because none of that floor is
// covered by any court marking. None of these meshes are ever touched by
// simulate()/collisions/the sweep grid (they're pure paint), so pulling them
// in toward the hoop is free: it doesn't move the rim, backboard, ball, or
// heat map at all, so nothing needs to "line up" with a shift — everything
// that already lined up with the true rim still does, untouched.
const VISUAL_BASELINE_Z = BACKBOARD_Z + 0.6;

// The key's paint color: normal saturated blue for ordinary play, muted to a
// neutral tone while the heat map is showing (see the [heatmap] effect) so its
// solid rectangle doesn't read as heat map "background" behind sparse data.
const KEY_COLOR_NORMAL = 0x0088ff;
const KEY_COLOR_MUTED = 0x2a2f36;

// Heat map plane footprint — matches src/physics/sweepGrid.ts's grid exactly
// (same cell size and axis convention), so a texture built from a SweepGrid
// lines up with the court underneath it with no separate offset to get wrong.
const HEATMAP_WIDTH = M(GRID_NX * GRID_CELL_SIZE_M); // world x span, centered on x=0
const HEATMAP_DEPTH = M(GRID_NY * GRID_CELL_SIZE_M); // world z span, from the baseline back toward half-court
const HEATMAP_CENTER_Z = BASELINE_Z - HEATMAP_DEPTH / 2;
// Between the key's paint (y=0.002) and the painted lines (y=0.004): visible
// over the court surface/paint, but the white lines still render crisply on
// top of it, per HEATMAP_SPEC.md's "underneath the court lines... not on top."
const HEATMAP_Y = 0.003;
// The sweep grid itself never records a sample beyond the true BASELINE_Z
// (worldToCell rejects it), so no rebound data exists past the real end line.
// But the heat map PLANE's own geometry still spans all the way to that true
// baseline, which — now that the *visual* court/support pulled in to
// VISUAL_BASELINE_Z (see that constant) — means the plane itself would poke
// past the shortened court into the out-of-bounds strip. This is the v (row)
// fraction, in the plane's own UV space, below which a fragment's world-z
// would land beyond VISUAL_BASELINE_Z; the heat map shader discards anything
// under it, so the drawn heat map never extends past the (now shorter) court.
const HEATMAP_CLIP_MIN_V = Math.max(0, (BASELINE_Z - VISUAL_BASELINE_Z) / HEATMAP_DEPTH);

// Exactly two fixed camera angles, hard-switched (no in-between motion): the default
// behind-the-shooter view, and an overhead "hoop cam" used while the shot is in flight.
// Pulled back further and narrower FOV than the original close/wide setup: the
// old 80fov, close-in framing exaggerated perspective distortion, making the
// backboard/rim (already correctly positioned inside the baseline) read as
// disconnected/"floating" above the key, and compressing the visible half-court
// into a stubby-looking box. Render-only — doesn't touch physics/constants.
const CAM_ORIGINAL_FOV = 50;
// Setup camera height, expressed directly relative to rim height (rather
// than as a drop from the original 7.5m) now that it sits down near the rim
// itself — a single easy-to-adjust constant to fine-tune in small steps.
// x/z position is untouched (FT_LINE_Z - 6.5, same as always — same
// distance, not moved any closer). The look-at point is the rim itself, so
// the camera genuinely looks toward the hoop from this low vantage — the
// previous floor-level target point (meant for the original high-up view)
// no longer makes sense from just above rim height.
const CAM_ORIGINAL_HEIGHT_ABOVE_RIM_M = 0.3; // meters above rim height
const CAM_ORIGINAL_POS = new THREE.Vector3(0, RIM_Y + CAM_ORIGINAL_HEIGHT_ABOVE_RIM_M, FT_LINE_Z - 6.5);
const CAM_ORIGINAL_TARGET = new THREE.Vector3(0, RIM_Y, RIM_Z);
// The in-flight "hoop cam": the original position/target (restored below,
// after a since-reverted experiment that repositioned it entirely rather than
// just zooming it). Zoomed out from that original by pushing the camera back
// along the exact same sightline to CAM_HOOP_TARGET — same target, same
// direction/angle, just further away — rather than moving it to a different
// vantage. Sized (1.9x) so the frame covers roughly baseline-to-farthest-miss:
// a brute-force sweep over DEFAULT_SWEEP_RANGES found the farthest a shot
// actually lands (floorPoint) is ~3.8m from the rim (angle 62°, aim -2°, speed
// 8.6 m/s), well short of a full half-court, so there's no need to zoom out
// that far. Shares CAM_ORIGINAL_FOV (one THREE.PerspectiveCamera reused for
// both — see the two-camera-angle note above), so FOV is never touched here
// either, which would also affect the untouched setup/aiming camera.
const CAM_HOOP_TARGET = new THREE.Vector3(0, RIM_Y - 1.5, RIM_Z + 1.5);
const CAM_HOOP_POS_ORIGINAL = new THREE.Vector3(0, RIM_Y + 3.2, RIM_Z - 1.0);
const CAM_HOOP_ZOOM_OUT = 1.9;
const CAM_HOOP_POS = CAM_HOOP_TARGET.clone().addScaledVector(
  CAM_HOOP_POS_ORIGINAL.clone().sub(CAM_HOOP_TARGET),
  CAM_HOOP_ZOOM_OUT,
);

// Half the world-Z extent the top-down orthographic camera frames. Widened
// from 8.3 to 9.5 (~19m total) so the view reads as "half the court, baseline
// to half-court line" rather than just the area around the rim: that covers
// HALF_COURT_Z (-12.425) on the far side and the support stanchion's rear
// edge (~2.775) on the near side with roughly 2.5m of margin on each end, so
// nothing at either edge gets clipped.
const ORTHO_VIEW_HALF_HEIGHT = 9.5;

// How far past the half-court line the sideline markings are drawn. The ortho
// camera's frame (centered at HEATMAP_CENTER_Z, see above) extends roughly
// 2.5m beyond HALF_COURT_Z on the far side (per the note above), so sidelines
// that stopped exactly at HALF_COURT_Z left a strip of unmarked floor visible
// between the court's edge and the actual frame edge — reading as the court
// abruptly cutting off mid-screen. Extending them past the frame's farthest
// visible point (with a buffer so they run off-screen, not stop right at it)
// makes the boundary lines continue naturally to the edge of the view, like a
// real full court, instead of ending inside it.
const SIDELINE_FAR_Z = HEATMAP_CENTER_Z - ORTHO_VIEW_HALF_HEIGHT - 3;

// Aim preview (picture-in-picture, bottom-right corner): a small, STATIC
// second camera pointed at the fixed rim/backboard assembly. It never reacts
// to aim/angle/power/height at all, so the rim and backboard stay fully
// framed and centered no matter what the sliders are set to — only the aim
// line and ball marker (drawn elsewhere) move. Tuned for an elevated view
// tilted down at a modest angle from the FRONT of the backboard — the
// shooter's side of the rim (negative PREVIEW_CAM_Z_OFFSET_FROM_BACKBOARD
// puts the camera in front of the backboard's face, toward the shooter,
// rather than behind it) — so both the rim and the front/playing face of
// the backboard sit in frame together, rather than looking straight down
// onto just the rim, or in from behind the glass. Since this is not a
// near-vertical look, the default camera "up" vector (0,1,0) works fine here
// (unlike the existing top-down orthoCamera, which — being a genuinely
// straight-down look — needs a non-default up to avoid a degenerate
// orientation; see orthoCamera.up.set elsewhere in this file). All three
// framing numbers are separate, clearly-named constants so they can be
// retuned without touching the camera math itself.
// FOV controls zoom at this fixed position: narrowed to crop tightly around
// the rim/backboard (checked by hand against the backboard's top edge — the
// tightest point in frame at this angle — which stays inside the frustum
// with a couple of degrees of margin at this value). Narrow further to zoom
// in more; if anything starts clipping, this is the first place to widen.
const PREVIEW_CAM_FOV = 45;
const PREVIEW_CAM_HEIGHT_ABOVE_RIM = 2; // meters above rim height — higher = steeper (more top-down) angle
const PREVIEW_CAM_Z_OFFSET_FROM_BACKBOARD = -2.375; // meters from the backboard along its depth axis — negative = in front (shooter's side), positive = behind (far side); smaller magnitude = closer to the rim

// Preview-only objects (this whole feature reuses the existing
// scene/camera/rim/backboard/ball/aim line — nothing is duplicated) that
// still need to stay invisible to the main and top-down/orthographic cameras
// without a second scene: the ball marker, and the preview's own thicker
// stand-in for the aim line (see previewTrajMesh below — a real 3D tube, not
// a fatter THREE.Line, since most browsers' WebGL ignore Line.linewidth
// entirely; the same reason the court's own paintLine() markings are drawn
// as extruded ribbons instead of thick Lines). Three.js layers do this
// natively: each object's layer mask is set to ONLY this layer, and only
// previewCamera enables it — the other cameras default to layer 0 and simply
// never render it.
const PREVIEW_ONLY_LAYER = 1;
// The ORIGINAL thin trajLine, conversely, needs to stay visible in the main
// and ortho views exactly as before, but NOT show up a second time
// underneath previewTrajMesh in the preview box. Moving it off the default
// layer 0 onto this one, then explicitly re-enabling that layer on the main
// and ortho cameras (see the mount effect below), keeps their view of it
// byte-for-byte the same while previewCamera — which never enables this
// layer — simply never renders it.
const MAIN_VIEW_TRAJ_LAYER = 2;
const PREVIEW_TRAJ_TUBE_RADIUS_M = 0.012; // preview-only aim line's radius

// All physics (rim/backboard/floor collision, drag, net resistance) now lives
// in src/physics/core.ts's simulate() — one function used for both the single
// shot below and the trajectory preview, so the two can never diverge from
// each other (or from the Phase 3 sweep engine, which will call the same
// function). Nothing in this file steps velocity/position itself anymore.

function releasePosition(c: SimControls) {
  return new THREE.Vector3(0, releaseHeightM(c.playerHeightCm), FT_LINE_Z);
}

function shotParamsFromControls(c: SimControls): ShotParams {
  return {
    heightCm: c.playerHeightCm,
    angleDeg: c.angleDeg,
    aimDeg: c.aimDeg,
    speed: c.power,
    spinRps: DEFAULT_BACKSPIN_RPS,
  };
}

// A trajectory whose result never touches the rim, backboard, or floor within
// SIM_MAX_DURATION_S doesn't happen in practice (gravity always brings it
// down), so firstImpactTime is treated as always present here; the preview
// line simply isn't truncated in that theoretical edge case.
function previewPoints(result: ShotResult): THREE.Vector3[] {
  const cutoff = result.firstImpactTime ?? Infinity;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < result.trajectory.length; i += 4) {
    const t = result.trajectory[i];
    pts.push(new THREE.Vector3(result.trajectory[i + 1], result.trajectory[i + 2], result.trajectory[i + 3]));
    if (t >= cutoff) break;
  }
  return pts;
}

// Whether the shot's flight ever actually touches the rim — used to gate the
// Shoot button and color the preview line. Backboard-only contact (no rim
// touch) doesn't count: hitting the glass and never reaching the ring isn't
// "reaching the hoop" for gating purposes, even though core.ts's own outcome
// classification still calls that case "backboard_miss" rather than
// "airball". outcome === "made" is checked separately (not just
// rimContacts > 0) because a clean swish never touches the rim at all —
// rimContacts stays 0 for it — so relying on rimContacts alone would
// incorrectly disable Shoot for a shot that's actually going in.
function reachesHoop(result: ShotResult): boolean {
  return result.rimContacts > 0 || result.outcome === "made";
}

// Where the ball's trajectory descends through rim height — read directly off
// simulate()'s own trajectory samples (linearly interpolated between the two
// samples that bracket the crossing, the same technique the animate()
// playback loop below already uses to place the ball between samples), not a
// second physics pass or a reimplementation of the arc. Mirrors the exact
// descending-crossing test core.ts's own made-shot detection uses (y >=
// RIM_HEIGHT_M then y < RIM_HEIGHT_M while still descending), so this always
// finds the same crossing that would decide a make. Returns null if the
// trajectory never comes back down through rim height at all (e.g. a weak
// lob whose apex is already below it) — the preview marker is just hidden then.
function rimHeightCrossingPoint(result: ShotResult): { x: number; z: number } | null {
  const traj = result.trajectory;
  const sampleCount = traj.length / 4;
  for (let i = 0; i < sampleCount - 1; i++) {
    const y0 = traj[i * 4 + 2];
    const y1 = traj[(i + 1) * 4 + 2];
    if (y0 >= RIM_HEIGHT_M && y1 < RIM_HEIGHT_M) {
      const frac = (RIM_HEIGHT_M - y0) / (y1 - y0);
      const x0 = traj[i * 4 + 1];
      const x1 = traj[(i + 1) * 4 + 1];
      const z0 = traj[i * 4 + 3];
      const z1 = traj[(i + 1) * 4 + 3];
      return { x: x0 + (x1 - x0) * frac, z: z0 + (z1 - z0) * frac };
    }
  }
  return null;
}

// Where the preview's line/ball should end: the ball's first actual contact
// with the rim or backboard, taken as an exact sample from simulate()'s own
// trajectory — collisions always get one (see core.ts's maybeSample calls in
// each contact block), so no interpolation is needed for that case. If the
// shot never touches either — a clean swish, or a total airball that reaches
// the floor untouched — falls back to the same rim-height crossing above, so
// the preview still stops near the rim instead of running all the way down
// to the floor. Built on top of previewPoints() (used unchanged by the main
// view's trajLine, which this feature must not touch) by trimming it further
// only in that fallback case, so the two never disagree about where the line
// already legitimately stops for an actual rim/backboard hit.
function previewLinePoints(result: ShotResult): THREE.Vector3[] {
  const base = previewPoints(result);
  const impactWasFloor =
    result.firstImpactTime !== null &&
    result.floorTime !== null &&
    Math.abs(result.firstImpactTime - result.floorTime) < 1e-9;
  if (!impactWasFloor) return base; // rim/backboard contact (or no impact recorded at all) — already correctly truncated above

  const crossing = rimHeightCrossingPoint(result);
  if (!crossing) return base;
  for (let i = 0; i < base.length - 1; i++) {
    if (base[i].y >= RIM_HEIGHT_M && base[i + 1].y < RIM_HEIGHT_M) {
      return [...base.slice(0, i + 1), new THREE.Vector3(crossing.x, RIM_HEIGHT_M, crossing.z)];
    }
  }
  return base;
}

export default function FreeThrowSim({
  controls,
  shootTrigger,
  onStats,
  onLanding,
  markers,
  onCanShootChange,
  heatmap,
  controlsOpen = true,
}: {
  controls: SimControls;
  shootTrigger: number;
  onStats: (s: Stats) => void;
  onLanding: (m: Marker) => void;
  markers: Marker[];
  onCanShootChange?: (canShoot: boolean) => void;
  // Optional: when set, renders a heat map texture under the court lines.
  // Phase 5 owns actually running a sweep and passing its grid in here — this
  // component only knows how to draw whatever grid it's given.
  heatmap?: { grid: SweepGrid; opacity: number; layer: HeatmapLayer } | null;
  // Whether the mobile bottom sheet (the controls panel — see routes/index.tsx)
  // is currently open. Only used in portrait, on phones, to keep the aim box
  // riding just above the sheet instead of getting covered by it — see the
  // preview mount's className/style below.
  controlsOpen?: boolean;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  // The bottom-right aim-preview box: doubles as both the mount point for its
  // own small canvas and the visibility toggle target (shown while setting up
  // a shot, hidden the instant Shoot fires — see the animate() loop and the
  // shootTrigger effect below).
  const previewMountRef = useRef<HTMLDivElement>(null);
  // The preview-only marker mesh and thick trajectory tube — both updated by
  // the controls-change effect below, which lives in a different effect than
  // the one that creates them, so they need to be refs rather than local
  // variables.
  const previewMarkerRef = useRef<THREE.Mesh | null>(null);
  const previewTrajMeshRef = useRef<THREE.Mesh | null>(null);
  // The scene-init effect below runs once (mount only) and its closures — in
  // particular the post-landing reset setTimeout — would otherwise capture
  // whatever `controls` was at that first render forever. Route reads through
  // this ref instead so a reset always uses the slider values in effect when
  // it fires, not the ones from mount time.
  const controlsRef = useRef(controls);
  useEffect(() => {
    controlsRef.current = controls;
  }, [controls]);

  const stateRef = useRef<{
    renderer?: THREE.WebGLRenderer;
    scene?: THREE.Scene;
    camera?: THREE.PerspectiveCamera;
    orthoCamera?: THREE.OrthographicCamera;
    cameraMode: "perspective" | "orthographic";
    ball?: THREE.Mesh;
    flying: boolean;
    result?: ShotResult; // precomputed by simulate() when the shot is fired; the rAF loop only ever plays it back
    markerGroup?: THREE.Group;
    trajLine?: THREE.Line;
    playStartTime: number; // performance.now() ms when the current flight's playback started
    trajCursor: number; // index (in samples, not floats) into result.trajectory, advances monotonically during playback
    landingFired: boolean; // whether onLanding has fired for the in-progress flight
    canShoot: boolean;
    heatmapMesh?: THREE.Mesh;
    heatmapMaterial?: THREE.ShaderMaterial;
    keyMaterial?: THREE.MeshStandardMaterial;
    heatmapTexture?: THREE.DataTexture;
    heatmapPixelData?: Uint8Array;
  }>({
    flying: false,
    canShoot: true,
    cameraMode: "perspective",
    playStartTime: 0,
    trajCursor: 0,
    landingFired: false,
  });
  const [cameraMode, setCameraMode] = useState<"perspective" | "orthographic">("perspective");

  // init scene once
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const width = mount.clientWidth;
    const height = mount.clientHeight;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05060a);
    scene.fog = new THREE.Fog(0x05060a, 22, 55);

    // Symmetrical low-angle over-the-shoulder camera behind the FT line arc
    const camera = new THREE.PerspectiveCamera(CAM_ORIGINAL_FOV, width / height, 0.1, 200);
    camera.position.copy(CAM_ORIGINAL_POS);
    camera.lookAt(CAM_ORIGINAL_TARGET);
    // trajLine lives on MAIN_VIEW_TRAJ_LAYER (not the default layer 0 — see
    // that constant's comment), so it must be explicitly re-enabled here to
    // keep this camera's view of it exactly as before.
    camera.layers.enable(MAIN_VIEW_TRAJ_LAYER);

    // Orthographic top-down camera: an optional, user-toggled alternative to
    // the perspective views above, so the heat map can be read square-on —
    // no perspective foreshortening distorting cell sizes near vs. far from
    // the camera. Framed on the heat map's own footprint (HEATMAP_CENTER_Z),
    // with the hoop/baseline end at the top of the view.
    const orthoCamera = new THREE.OrthographicCamera(
      (-ORTHO_VIEW_HALF_HEIGHT * width) / height,
      (ORTHO_VIEW_HALF_HEIGHT * width) / height,
      ORTHO_VIEW_HALF_HEIGHT,
      -ORTHO_VIEW_HALF_HEIGHT,
      0.1,
      100,
    );
    orthoCamera.up.set(0, 0, 1);
    orthoCamera.position.set(0, 30, HEATMAP_CENTER_Z);
    orthoCamera.lookAt(0, 0, HEATMAP_CENTER_Z);
    orthoCamera.layers.enable(MAIN_VIEW_TRAJ_LAYER); // see MAIN_VIEW_TRAJ_LAYER's comment above

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // updateStyle=false: the canvas's display size is driven by CSS
    // (width/height:100%, set below) rather than inline px from three.js, so
    // it tracks the mount container's layout size on its own.
    renderer.setSize(width, height, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    renderer.domElement.style.touchAction = "none";
    mount.appendChild(renderer.domElement);

    // Lights: soft ambient + big hemisphere for arena feel
    scene.add(new THREE.AmbientLight(0xffffff, 0.34));
    scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x101018, 0.5));

    // Overhead floodlight row (8 rigs across the ceiling)
    const rigCount = 9;
    for (let i = 0; i < rigCount; i++) {
      const t = (i / (rigCount - 1)) * 2 - 1; // -1..1
      const sx = t * 8;
      const sz = -2 + (i % 2 === 0 ? -1.5 : 1.5);
      const sl = new THREE.SpotLight(0xffffff, 0.55, 45, Math.PI / 6, 0.35, 1.1);
      sl.position.set(sx, 13, sz);
      sl.target.position.set(sx * 0.25, 0, sz * 0.4);
      sl.castShadow = i === 3 || i === 5;
      if (sl.castShadow) sl.shadow.mapSize.set(1024, 1024);
      scene.add(sl);
      scene.add(sl.target);
      // Deliberately no visible bulb/fixture mesh here — the SpotLight above
      // still illuminates the court exactly as before, just without a glowing
      // sphere floating at its position.
    }

    // Court key spotlight highlighting hoop
    const keySpot = new THREE.SpotLight(0xfff2d0, 1.1, 30, Math.PI / 5, 0.4, 1.2);
    keySpot.position.set(0, 10, -2);
    keySpot.target.position.set(0, RIM_Y, 0);
    keySpot.castShadow = true;
    keySpot.shadow.mapSize.set(2048, 2048);
    scene.add(keySpot);
    scene.add(keySpot.target);

    // Extra hoop accent spotlight straight down onto the rim/net
    const hoopAccent = new THREE.SpotLight(0xffffff, 0.9, 20, Math.PI / 7, 0.3, 1.4);
    hoopAccent.position.set(0, 8, RIM_Z + 1.5);
    hoopAccent.target.position.set(0, RIM_Y, RIM_Z);
    scene.add(hoopAccent);
    scene.add(hoopAccent.target);

    // Floor (polished honey hardwood with plank grain)
    const plankCanvas = document.createElement("canvas");
    plankCanvas.width = 512; plankCanvas.height = 512;
    const pctx = plankCanvas.getContext("2d")!;
    // Warm honey/amber base with horizontal plank grain
    const grd = pctx.createLinearGradient(0, 0, 0, 512);
    grd.addColorStop(0, "#dcac6a");
    grd.addColorStop(0.5, "#d4a359");
    grd.addColorStop(1, "#b8863f");
    pctx.fillStyle = grd; pctx.fillRect(0, 0, 512, 512);
    // horizontal plank separators
    for (let i = 0; i < 512; i += 48) {
      pctx.fillStyle = "rgba(50,25,8,0.55)";
      pctx.fillRect(0, i, 512, 2);
    }
    // subtle grain streaks
    for (let i = 0; i < 900; i++) {
      pctx.fillStyle = `rgba(90,55,20,${Math.random() * 0.18})`;
      pctx.fillRect(Math.random() * 512, Math.random() * 512, 2 + Math.random() * 3, 1);
    }
    const floorTex = new THREE.CanvasTexture(plankCanvas);
    floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
    // Repeat count scales with the floor's own size (220) so each plank tile
    // stays ~5m, matching the original 40x40 floor's density (40/8). Without
    // this, enlarging the plane alone stretches each tile to ~27m, and the
    // grain goes flat/blurry past the court — reading as the floor visually
    // "running out" even though the geometry itself keeps going.
    floorTex.repeat.set(44, 44);
    floorTex.colorSpace = THREE.SRGBColorSpace;
    // Large enough that its own edge always falls past the fog's far distance
    // (55, set above) from any camera angle in this scene, so the floor fades
    // smoothly into the fog/background like a real gym floor extending past
    // the sightline — instead of the previous 40x40 plane's edge sometimes
    // being visible as an abrupt "the world just stops here" cutoff.
    const floorGeo = new THREE.PlaneGeometry(220, 220);
    const floorMat = new THREE.MeshStandardMaterial({
      map: floorTex,
      color: 0xd4a359,
      roughness: 0.45,
      metalness: 0.05,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Paint — free-throw lane ("the key"): rectangular, no trapezoid taper,
    // LANE_WIDTH wide, centered on the basket's x=0 axis, running from the
    // free-throw line to VISUAL_BASELINE_Z (not the true LANE_LENGTH/BASELINE_Z
    // — see that constant's comment: pulling the paint's baseline edge in
    // toward the hoop is what actually closes the "floating gap" visually).
    const VISUAL_LANE_LENGTH = VISUAL_BASELINE_Z - FT_LINE_Z;
    const keyGeo = new THREE.PlaneGeometry(LANE_WIDTH, VISUAL_LANE_LENGTH);
    const keyMat = new THREE.MeshStandardMaterial({ color: KEY_COLOR_NORMAL, roughness: 0.5, metalness: 0.1 });
    const key = new THREE.Mesh(keyGeo, keyMat);
    key.rotation.x = -Math.PI / 2;
    key.position.set(0, 0.002, (VISUAL_BASELINE_Z + FT_LINE_Z) / 2);
    key.receiveShadow = true;
    scene.add(key);

    // Heat map layer: a single NX x NY-pixel canvas (150x140), scaled up to
    // the court via the plane's world size rather than drawing one rectangle
    // per cell (HEATMAP_SPEC.md: "Do not draw 21,000 rectangles"). Starts
    // invisible/empty; the [heatmap] effect below fills it in and toggles
    // visibility whenever the sweep result, opacity, or layer prop changes.
    // texture.flipY = false because the canvas is filled with row 0 = grid
    // iy = 0 = the baseline (see the [heatmap] effect) — with flipY at its
    // default true, that mapping would come out mirrored front-to-back.
    const heatmapPixelData = new Uint8Array(GRID_NX * GRID_NY * 4);
    const heatmapTexture = new THREE.DataTexture(heatmapPixelData, GRID_NX, GRID_NY, THREE.RGBAFormat, THREE.UnsignedByteType);
    heatmapTexture.flipY = false;
    heatmapTexture.magFilter = THREE.LinearFilter;
    // Trilinear filtering + real mipmaps: this texture is heavily minified
    // (150x140 texels stretched over a 15x14m plane, often viewed from far
    // away) and NPOT mipmapping needs WebGL2 (confirmed this renderer uses
    // hardware WebGL2 via ANGLE, not the WebGL1-only NPOT restriction).
    heatmapTexture.minFilter = THREE.LinearMipmapLinearFilter;
    heatmapTexture.generateMipmaps = true;
    heatmapTexture.wrapS = THREE.ClampToEdgeWrapping;
    heatmapTexture.wrapT = THREE.ClampToEdgeWrapping;
    heatmapTexture.needsUpdate = true;
    // A custom opaque + alphaTest-style shader, deliberately NOT using real
    // alpha blending (transparent:true). On this renderer/GPU combination
    // (verified: hardware WebGL2 via ANGLE, not a software fallback),
    // alpha-blending a varying-alpha texture over the court produced
    // corrupted colour — cyan/pure-primary blotches with channel values
    // (e.g. R=0 alongside G>230) that are mathematically impossible from any
    // correct blend of this ramp's colours, confirmed via direct pixel
    // readback at every stage (canvas/texture data was always correct; only
    // the GPU's blended output was wrong). This reproduced identically across
    // MeshBasicMaterial and a from-scratch ShaderMaterial, with premultiplied
    // vs. straight alpha, with depthTest on/off, and independent of colour
    // space/tone-mapping/fog/NPOT-mipmap settings — narrowing it to the
    // GL_BLEND path itself on this hardware, not anything under this app's
    // control. Rendering fully opaque (confirmed correct in isolation) and
    // using `discard` for empty cells sidesteps GL blending entirely: the
    // court shows through untouched where there's no data, and where there
    // is, the colour is guaranteed correct.
    //
    // Trade-off: no true partial transparency, so the "opacity" control
    // can't do real alpha blending either. Instead it raises the visibility
    // threshold — turning it down hides the faintest (most spread-out) cells
    // first and keeps only the hottest core, converging on "nothing visible"
    // as it approaches 0, which reads similarly to fading out in practice.
    const heatmapMaterial = new THREE.ShaderMaterial({
      uniforms: { map: { value: heatmapTexture }, opacity: { value: 0.7 }, clipMinV: { value: HEATMAP_CLIP_MIN_V } },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D map;
        uniform float opacity;
        uniform float clipMinV;
        varying vec2 vUv;
        void main() {
          // v=0 is the baseline row (see the DataTexture's flipY=false note below);
          // anything under clipMinV falls between the true baseline and the
          // shorter, pulled-in visual court, so it never gets painted.
          if (vUv.y < clipMinV) discard;
          vec4 texColor = texture2D(map, vUv);
          float threshold = mix(0.02, 0.95, 1.0 - opacity);
          if (texColor.a < threshold) discard;
          gl_FragColor = vec4(texColor.rgb, 1.0);
        }
      `,
      transparent: false,
      depthWrite: true,
      depthTest: true,
    });
    const heatmapMesh = new THREE.Mesh(new THREE.PlaneGeometry(HEATMAP_WIDTH, HEATMAP_DEPTH), heatmapMaterial);
    heatmapMesh.rotation.x = -Math.PI / 2;
    heatmapMesh.position.set(0, HEATMAP_Y, HEATMAP_CENTER_Z);
    heatmapMesh.visible = false;
    scene.add(heatmapMesh);

    // Thick painted white line helper
    const paintLine = (pts: THREE.Vector3[], width = 0.06) => {
      // build a thin ribbon by extruding between points
      const group = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) continue;
        const geo = new THREE.PlaneGeometry(len, width);
        const m = new THREE.Mesh(geo, mat);
        m.rotation.x = -Math.PI / 2;
        m.position.set((a.x + b.x) / 2, 0.004, (a.z + b.z) / 2);
        m.rotation.z = -Math.atan2(dz, dx);
        group.add(m);
      }
      return group;
    };

    // Baseline: drawn at VISUAL_BASELINE_Z, not the true BASELINE_Z — see that
    // constant's comment. Full COURT_WIDTH, at the near edge of the half-court.
    scene.add(paintLine([
      new THREE.Vector3(-SIDELINE_X, 0, VISUAL_BASELINE_Z),
      new THREE.Vector3(SIDELINE_X, 0, VISUAL_BASELINE_Z),
    ], 0.08));

    // Sidelines: run from the (visual) baseline past the half-court line to
    // SIDELINE_FAR_Z (see that constant) so they continue to the edge of the
    // top-down view instead of stopping short of it.
    scene.add(paintLine([
      new THREE.Vector3(-SIDELINE_X, 0, VISUAL_BASELINE_Z),
      new THREE.Vector3(-SIDELINE_X, 0, SIDELINE_FAR_Z),
    ], 0.08));
    scene.add(paintLine([
      new THREE.Vector3(SIDELINE_X, 0, VISUAL_BASELINE_Z),
      new THREE.Vector3(SIDELINE_X, 0, SIDELINE_FAR_Z),
    ], 0.08));

    // Free-throw line: spans the width of the lane, LANE_LENGTH from the baseline
    scene.add(paintLine([
      new THREE.Vector3(-LANE_HALF_WIDTH, 0, FT_LINE_Z),
      new THREE.Vector3(LANE_HALF_WIDTH, 0, FT_LINE_Z),
    ], 0.08));

    // Free-throw circle: radius FT_CIRCLE_R, centered on the midpoint of the free-throw
    // line. The half INSIDE the lane (toward the basket/baseline) is solid; the half
    // OUTSIDE the lane (toward half-court) is dashed.
    const ftArcPts: THREE.Vector3[] = [];
    for (let a = 0; a <= Math.PI; a += Math.PI / 48) {
      ftArcPts.push(new THREE.Vector3(Math.cos(a) * FT_CIRCLE_R, 0, FT_LINE_Z + Math.sin(a) * FT_CIRCLE_R));
    }
    scene.add(paintLine(ftArcPts, 0.07));
    // dashed half, outside the lane toward half-court
    for (let a = 0; a < Math.PI; a += Math.PI / 12) {
      const p1 = new THREE.Vector3(Math.cos(a) * FT_CIRCLE_R, 0, FT_LINE_Z - Math.sin(a) * FT_CIRCLE_R);
      const p2 = new THREE.Vector3(
        Math.cos(a + Math.PI / 24) * FT_CIRCLE_R, 0, FT_LINE_Z - Math.sin(a + Math.PI / 24) * FT_CIRCLE_R,
      );
      scene.add(paintLine([p1, p2], 0.06));
    }

    // Key/lane rectangle border, free-throw line to the (visual) baseline
    scene.add(paintLine([
      new THREE.Vector3(-LANE_HALF_WIDTH, 0, FT_LINE_Z),
      new THREE.Vector3(-LANE_HALF_WIDTH, 0, VISUAL_BASELINE_Z),
      new THREE.Vector3(LANE_HALF_WIDTH, 0, VISUAL_BASELINE_Z),
      new THREE.Vector3(LANE_HALF_WIDTH, 0, FT_LINE_Z),
    ], 0.06));

    // Lane hash marks (rebounding blocks) along both sides of the key,
    // spaced proportionally to LANE_LENGTH so they stay correct at any COURT_SCALE
    const laneHashFracs = [0.12, 0.32, 0.52, 0.72];
    for (const f of laneHashFracs) {
      const hz = FT_LINE_Z + f * LANE_LENGTH;
      scene.add(paintLine([
        new THREE.Vector3(-LANE_HALF_WIDTH, 0, hz), new THREE.Vector3(-LANE_HALF_WIDTH - 0.2, 0, hz),
      ], 0.05));
      scene.add(paintLine([
        new THREE.Vector3(LANE_HALF_WIDTH, 0, hz), new THREE.Vector3(LANE_HALF_WIDTH + 0.2, 0, hz),
      ], 0.05));
    }

    // Restricted-area (no-charge) arc under the basket: radius RESTRICTED_AREA_R,
    // centered on the rim; solid semicircle whose open (chord) side faces the baseline.
    const raPts: THREE.Vector3[] = [];
    for (let a = 0; a <= Math.PI; a += Math.PI / 32) {
      raPts.push(new THREE.Vector3(Math.cos(a) * RESTRICTED_AREA_R, 0, -Math.sin(a) * RESTRICTED_AREA_R));
    }
    scene.add(paintLine(raPts, 0.05));
    // short connectors from the restricted-area arc's open ends to the (visual) baseline
    scene.add(paintLine([
      new THREE.Vector3(-RESTRICTED_AREA_R, 0, 0), new THREE.Vector3(-RESTRICTED_AREA_R, 0, VISUAL_BASELINE_Z),
    ], 0.05));
    scene.add(paintLine([
      new THREE.Vector3(RESTRICTED_AREA_R, 0, 0), new THREE.Vector3(RESTRICTED_AREA_R, 0, VISUAL_BASELINE_Z),
    ], 0.05));

    // Three-point line: constant-radius arc (THREE_PT_R) centered on the rim, all the
    // way around — no flattening. Near the baseline it transitions into straight
    // segments running parallel to the sidelines, offset THREE_PT_SIDE_OFFSET in from
    // them, from the baseline down to the point where they meet the arc exactly (the
    // arc's start/end angle is derived from THREE_PT_CORNER_X so the two pieces meet
    // with no seam or kink).
    const threePtArcStartAngle = Math.acos(THREE_PT_CORNER_X / THREE_PT_R);
    const threePtArcEndZ = -THREE_PT_R * Math.sin(threePtArcStartAngle);
    scene.add(paintLine([
      new THREE.Vector3(-THREE_PT_CORNER_X, 0, VISUAL_BASELINE_Z), new THREE.Vector3(-THREE_PT_CORNER_X, 0, threePtArcEndZ),
    ], 0.07));
    scene.add(paintLine([
      new THREE.Vector3(THREE_PT_CORNER_X, 0, VISUAL_BASELINE_Z), new THREE.Vector3(THREE_PT_CORNER_X, 0, threePtArcEndZ),
    ], 0.07));
    const threePtArcPts: THREE.Vector3[] = [];
    for (let a = threePtArcStartAngle; a <= Math.PI - threePtArcStartAngle; a += Math.PI / 96) {
      threePtArcPts.push(new THREE.Vector3(Math.cos(a) * THREE_PT_R, 0, -Math.sin(a) * THREE_PT_R));
    }
    // ensure the arc's endpoints land exactly on the straight segments (avoids any
    // floating-point seam at the transition from the loop's step size)
    threePtArcPts[0].set(THREE_PT_CORNER_X, 0, threePtArcEndZ);
    threePtArcPts[threePtArcPts.length - 1].set(-THREE_PT_CORNER_X, 0, threePtArcEndZ);
    scene.add(paintLine(threePtArcPts, 0.07));

    // Half-court line, and the full center circle (both halves — the far half
    // sits past HALF_COURT_Z within the sidelines' SIDELINE_FAR_Z extension, so
    // it no longer reads as a circle abruptly cut off mid-shape), radius
    // CENTER_CIRCLE_R centered exactly on that line
    scene.add(paintLine([
      new THREE.Vector3(-SIDELINE_X, 0, HALF_COURT_Z),
      new THREE.Vector3(SIDELINE_X, 0, HALF_COURT_Z),
    ], 0.08));
    const centerCirclePts: THREE.Vector3[] = [];
    for (let a = 0; a <= Math.PI * 2 + 1e-6; a += Math.PI / 48) {
      centerCirclePts.push(new THREE.Vector3(Math.cos(a) * CENTER_CIRCLE_R, 0, HALF_COURT_Z + Math.sin(a) * CENTER_CIRCLE_R));
    }
    scene.add(paintLine(centerCirclePts, 0.07));

    // Backboard + rim + net are one rigid assembly: every piece below is added to
    // this single group (instead of the scene directly) so the rim can never end up
    // detached from or positioned independently of the backboard.
    const hoopGroup = new THREE.Group();
    hoopGroup.name = "hoopAssembly";

    // Backboard — clear glass with white border and blue frame
    const bbGeo = new THREE.BoxGeometry(BACKBOARD_W, BACKBOARD_H, 0.05);
    const bbMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, transparent: true, opacity: 0.22, roughness: 0.02,
      transmission: 0.92, thickness: 0.05, clearcoat: 1, clearcoatRoughness: 0.05,
    });
    const bb = new THREE.Mesh(bbGeo, bbMat);
    bb.position.set(0, BACKBOARD_Y, BACKBOARD_Z + 0.025);
    hoopGroup.add(bb);
    // Blue outer frame
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x1266d6, roughness: 0.35, metalness: 0.3 });
    const frameT = 0.04;
    const bbW = BACKBOARD_W, bbH = BACKBOARD_H;
    const frameZ = BACKBOARD_Z + 0.052;
    const framePieces = [
      new THREE.Mesh(new THREE.BoxGeometry(bbW + frameT * 2, frameT, 0.06), frameMat),
      new THREE.Mesh(new THREE.BoxGeometry(bbW + frameT * 2, frameT, 0.06), frameMat),
      new THREE.Mesh(new THREE.BoxGeometry(frameT, bbH, 0.06), frameMat),
      new THREE.Mesh(new THREE.BoxGeometry(frameT, bbH, 0.06), frameMat),
    ];
    framePieces[0].position.set(0, BACKBOARD_Y + bbH / 2, frameZ);
    framePieces[1].position.set(0, BACKBOARD_Y - bbH / 2, frameZ);
    framePieces[2].position.set(-bbW / 2 - frameT / 2, BACKBOARD_Y, frameZ);
    framePieces[3].position.set(bbW / 2 + frameT / 2, BACKBOARD_Y, frameZ);
    framePieces.forEach((p) => hoopGroup.add(p));
    // White inner border stripe
    const whiteBorderMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const borderT = 0.025;
    const wbZ = BACKBOARD_Z + 0.051;
    const iw = bbW - 0.08, ih = bbH - 0.08;
    const wbPieces = [
      new THREE.Mesh(new THREE.PlaneGeometry(iw, borderT), whiteBorderMat),
      new THREE.Mesh(new THREE.PlaneGeometry(iw, borderT), whiteBorderMat),
      new THREE.Mesh(new THREE.PlaneGeometry(borderT, ih), whiteBorderMat),
      new THREE.Mesh(new THREE.PlaneGeometry(borderT, ih), whiteBorderMat),
    ];
    wbPieces[0].position.set(0, BACKBOARD_Y + ih / 2, wbZ);
    wbPieces[1].position.set(0, BACKBOARD_Y - ih / 2, wbZ);
    wbPieces[2].position.set(-iw / 2, BACKBOARD_Y, wbZ);
    wbPieces[3].position.set(iw / 2, BACKBOARD_Y, wbZ);
    wbPieces.forEach((p) => hoopGroup.add(p));
    // Shooter target square (white filled outline)
    const sqW = 0.59, sqH = 0.45;
    const sqZ = BACKBOARD_Z + 0.051;
    const sqPieces = [
      new THREE.Mesh(new THREE.PlaneGeometry(sqW, borderT), whiteBorderMat),
      new THREE.Mesh(new THREE.PlaneGeometry(sqW, borderT), whiteBorderMat),
      new THREE.Mesh(new THREE.PlaneGeometry(borderT, sqH), whiteBorderMat),
      new THREE.Mesh(new THREE.PlaneGeometry(borderT, sqH), whiteBorderMat),
    ];
    const sqCy = RIM_Y + sqH / 2; // bottom edge level with the rim
    sqPieces[0].position.set(0, sqCy + sqH / 2, sqZ);
    sqPieces[1].position.set(0, sqCy - sqH / 2, sqZ);
    sqPieces[2].position.set(-sqW / 2, sqCy, sqZ);
    sqPieces[3].position.set(sqW / 2, sqCy, sqZ);
    sqPieces.forEach((p) => hoopGroup.add(p));

    // Rim (bright orange)
    const rimGeo = new THREE.TorusGeometry(RIM_RADIUS, RIM_TUBE, 20, 64);
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0xff5500,
      emissive: 0xff3300,
      emissiveIntensity: 0.6,
      roughness: 0.35,
      metalness: 0.8,
    });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(0, RIM_Y, RIM_Z);
    hoopGroup.add(rim);
    // Rim glow spotlight to make it pop
    const rimLight = new THREE.PointLight(0xff5500, 1.6, 4, 2);
    rimLight.position.set(0, RIM_Y + 0.1, RIM_Z);
    hoopGroup.add(rimLight);

    // Rigid mounting bracket (Spalding Super SAM 325 Pro style): a small plate bolted
    // flush to the board face plus a short arm bridging out to the ring — its only job
    // is to close the FIBA-standard 15cm gap between the board and the rim's near edge
    // at rim height (305cm), so the ring reads as bolted on rather than floating in
    // front of the glass. Painted the same regulation rim orange as the ring itself.
    // Purely cosmetic — collision physics is handled analytically in
    // src/physics/core.ts and doesn't reference this mesh, so it stays untouched.
    const boltMat = rimMat;
    const bracketMat = rimMat;
    const BRACKET_WIDTH = 0.15; // ~15cm wide
    const boardFaceZ = BACKBOARD_Z;
    const rimNearZ = RIM_Z + RIM_RADIUS; // point on the ring nearest the board
    const gap = boardFaceZ - rimNearZ; // the 15cm standoff this bracket bridges
    // Plate: bolted flush to the board face, centered at rim height
    const plate = new THREE.Mesh(new THREE.BoxGeometry(BRACKET_WIDTH, BRACKET_WIDTH, 0.02), bracketMat);
    plate.position.set(0, RIM_Y, boardFaceZ - 0.01);
    hoopGroup.add(plate);
    // Arm: a flat bar spanning the gap, from the plate out to the ring
    const bracketArm = new THREE.Mesh(new THREE.BoxGeometry(BRACKET_WIDTH, 0.03, gap), bracketMat);
    bracketArm.position.set(0, RIM_Y, boardFaceZ - gap / 2);
    hoopGroup.add(bracketArm);
    // Mounting bolts through the plate, into the board
    [RIM_Y + BRACKET_WIDTH * 0.28, RIM_Y - BRACKET_WIDTH * 0.28].forEach((by) => {
      const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.03, 12), boltMat);
      bolt.rotation.x = Math.PI / 2;
      bolt.position.set(0, by, boardFaceZ - 0.015);
      hoopGroup.add(bolt);
    });

    // Net (simple lines)
    const netGroup = new THREE.Group();
    const netMat = new THREE.LineBasicMaterial({ color: 0xffffff });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const top = new THREE.Vector3(Math.cos(a) * RIM_RADIUS, RIM_Y, RIM_Z + Math.sin(a) * RIM_RADIUS);
      const bot = new THREE.Vector3(Math.cos(a) * RIM_RADIUS * 0.6, RIM_Y - 0.4, RIM_Z + Math.sin(a) * RIM_RADIUS * 0.6);
      netGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([top, bot]), netMat));
    }
    hoopGroup.add(netGroup);
    scene.add(hoopGroup);

    // Support: yellow-green cylindrical arm & neck, navy/blue tapered padded base.
    // The base + ballast must sit entirely behind VISUAL_BASELINE_Z (outside the
    // play area) — only the arm, backboard, and rim are allowed to cross into the
    // court. Positioned off VISUAL_BASELINE_Z (not BACKBOARD_Z + a fixed offset)
    // so the support keeps a small, deliberate clearance behind the pulled-in
    // baseline instead of suddenly reading as floating far beyond it again.
    const SUPPORT_NECK_Z = VISUAL_BASELINE_Z + 0.5;
    const SUPPORT_ARM_LENGTH = SUPPORT_NECK_Z - BACKBOARD_Z;
    const SUPPORT_ARM_Z = BACKBOARD_Z + SUPPORT_ARM_LENGTH / 2;
    const SUPPORT_BASE_Z = VISUAL_BASELINE_Z + 1.1; // near face ~0.4m clear of the visual baseline
    const yellowMat = new THREE.MeshStandardMaterial({ color: 0xa8cc2e, roughness: 0.45, metalness: 0.35 });
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, SUPPORT_ARM_LENGTH, 20), yellowMat);
    arm.rotation.x = Math.PI / 2;
    arm.position.set(0, BACKBOARD_Y, SUPPORT_ARM_Z);
    scene.add(arm);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, BACKBOARD_Y - 0.6, 24), yellowMat);
    neck.position.set(0, (BACKBOARD_Y - 0.6) / 2 + 0.6, SUPPORT_NECK_Z);
    scene.add(neck);
    // Navy/blue two-tone padded base (tapered inward at top)
    const padTopMat = new THREE.MeshStandardMaterial({ color: 0x0055d4, roughness: 0.7, metalness: 0.05 });
    const padBottomMat = new THREE.MeshStandardMaterial({ color: 0x0a1a40, roughness: 0.7, metalness: 0.05 });
    const baseTop = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.75, 0.6, 24), padTopMat);
    baseTop.position.set(0, 0.6, SUPPORT_BASE_Z);
    scene.add(baseTop);
    const baseBottom = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.35, 1.4), padBottomMat);
    baseBottom.position.set(0, 0.175, SUPPORT_BASE_Z);
    scene.add(baseBottom);

    // Ball
    const ballGeo = new THREE.SphereGeometry(BALL_R, 32, 24);
    const ballMat = new THREE.MeshStandardMaterial({ color: 0xd35400, roughness: 0.8 });
    const ball = new THREE.Mesh(ballGeo, ballMat);
    ball.castShadow = true;
    scene.add(ball);

    // Light that follows the ball to keep it brightly lit throughout its flight
    const ballLight = new THREE.PointLight(0xfff6e0, 0.9, 5, 2);
    ballLight.position.copy(ball.position).add(new THREE.Vector3(0, 0.6, 0));
    scene.add(ballLight);

    // Ball seams
    const seamMat = new THREE.LineBasicMaterial({ color: 0x1a0a00 });
    const seamPts1: THREE.Vector3[] = [];
    for (let i = 0; i <= 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      seamPts1.push(new THREE.Vector3(Math.cos(a) * BALL_R * 1.001, 0, Math.sin(a) * BALL_R * 1.001));
    }
    const seam1 = new THREE.Line(new THREE.BufferGeometry().setFromPoints(seamPts1), seamMat);
    ball.add(seam1);
    const seam2 = new THREE.Line(new THREE.BufferGeometry().setFromPoints(seamPts1), seamMat);
    seam2.rotation.x = Math.PI / 2;
    ball.add(seam2);

    // Marker group
    const markerGroup = new THREE.Group();
    scene.add(markerGroup);

    // Trajectory preview line
    const trajMat = new THREE.LineDashedMaterial({ color: 0xff3333, dashSize: 0.15, gapSize: 0.1 });
    const trajGeo = new THREE.BufferGeometry();
    const trajLine = new THREE.Line(trajGeo, trajMat);
    // See MAIN_VIEW_TRAJ_LAYER's comment above: kept off the preview camera
    // (which only enables layer 0 + PREVIEW_ONLY_LAYER) so it doesn't draw a
    // second, thin line underneath the preview's own thicker previewTrajMesh.
    trajLine.layers.set(MAIN_VIEW_TRAJ_LAYER);
    scene.add(trajLine);

    // Stadium — oval crowd tier with sparkles and LED ribbon
    const crowdCanvas = document.createElement("canvas");
    crowdCanvas.width = 1024; crowdCanvas.height = 256;
    const cctx = crowdCanvas.getContext("2d")!;
    const cg = cctx.createLinearGradient(0, 0, 0, 256);
    cg.addColorStop(0, "#02030a");
    cg.addColorStop(0.6, "#0a0d1c");
    cg.addColorStop(1, "#050710");
    cctx.fillStyle = cg; cctx.fillRect(0, 0, 1024, 256);
    for (let i = 0; i < 3500; i++) {
      const x = Math.random() * 1024, y = 30 + Math.random() * 220;
      cctx.fillStyle = `rgba(${40 + Math.random() * 40},${40 + Math.random() * 40},${60 + Math.random() * 60},0.6)`;
      cctx.fillRect(x, y, 2, 2);
    }
    // sparkle flashes
    for (let i = 0; i < 80; i++) {
      const x = Math.random() * 1024, y = 40 + Math.random() * 200;
      cctx.fillStyle = `rgba(255,255,235,${0.6 + Math.random() * 0.4})`;
      cctx.beginPath(); cctx.arc(x, y, 1.2 + Math.random() * 1.6, 0, Math.PI * 2); cctx.fill();
    }
    const crowdTex = new THREE.CanvasTexture(crowdCanvas);
    crowdTex.wrapS = THREE.RepeatWrapping;
    crowdTex.repeat.set(2, 1);
    crowdTex.colorSpace = THREE.SRGBColorSpace;
    const crowdMat = new THREE.MeshBasicMaterial({ map: crowdTex, side: THREE.BackSide });
    const crowdRing = new THREE.Mesh(
      new THREE.CylinderGeometry(22, 24, 6, 64, 1, true),
      crowdMat,
    );
    crowdRing.position.set(0, 3, -1);
    crowdRing.scale.set(1, 1, 0.7); // oval
    scene.add(crowdRing);

    // Upper dark rim
    const upperRing = new THREE.Mesh(
      new THREE.CylinderGeometry(22, 22, 6, 64, 1, true),
      new THREE.MeshBasicMaterial({ color: 0x02030a, side: THREE.BackSide }),
    );
    upperRing.position.set(0, 9, -1);
    upperRing.scale.set(1, 1, 0.7);
    scene.add(upperRing);

    // LED ribbon banner
    const ledCanvas = document.createElement("canvas");
    ledCanvas.width = 2048; ledCanvas.height = 96;
    const lctx = ledCanvas.getContext("2d")!;
    lctx.fillStyle = "#0a3a9c"; lctx.fillRect(0, 0, 2048, 96);
    lctx.fillStyle = "#1e90ff";
    for (let x = 0; x < 2048; x += 6) lctx.fillRect(x, 0, 3, 96);
    lctx.fillStyle = "rgba(255,255,255,0.95)";
    lctx.font = "bold 56px sans-serif";
    lctx.textBaseline = "middle";
    const msg = "  MAKE  SOME  NOISE   •   BASKETBALL  STADIUM   •  ";
    let tx = 0;
    while (tx < 2048) { lctx.fillText(msg, tx, 48); tx += lctx.measureText(msg).width; }
    const ledTex = new THREE.CanvasTexture(ledCanvas);
    ledTex.wrapS = THREE.RepeatWrapping;
    ledTex.colorSpace = THREE.SRGBColorSpace;
    const ledRing = new THREE.Mesh(
      new THREE.CylinderGeometry(21.6, 21.6, 0.7, 64, 1, true),
      new THREE.MeshBasicMaterial({ map: ledTex, side: THREE.BackSide, toneMapped: false, transparent: true, opacity: 0.35 }),
    );
    ledRing.position.set(0, 6.2, -1);
    ledRing.scale.set(1, 1, 0.7);
    scene.add(ledRing);
    // animate LED scroll
    const ledClock = { t: 0 };
    const ledTick = () => {
      ledClock.t += 0.0006;
      ledTex.offset.x = ledClock.t;
    };
    (stateRef.current as any).__ledTick = ledTick;

    // Aim preview: a small picture-in-picture view rendered from a second,
    // static camera into its own small canvas — reuses the SAME `scene`
    // object built above (same rim, backboard, ball, aim line), it is not a
    // copy. The only new objects added to the scene for this are
    // previewMarker and previewTrajMesh below; everything else the box shows
    // already exists.
    const previewMount = previewMountRef.current;
    let previewRenderer: THREE.WebGLRenderer | undefined;
    let previewCamera: THREE.PerspectiveCamera | undefined;
    if (previewMount) {
      const pw = previewMount.clientWidth;
      const ph = previewMount.clientHeight;
      previewCamera = new THREE.PerspectiveCamera(PREVIEW_CAM_FOV, pw / ph, 0.1, 200);
      previewCamera.position.set(0, RIM_Y + PREVIEW_CAM_HEIGHT_ABOVE_RIM, BACKBOARD_Z + PREVIEW_CAM_Z_OFFSET_FROM_BACKBOARD);
      previewCamera.lookAt(0, RIM_Y, RIM_Z);
      // Sees layer 0 (the default — everything else in the scene, MINUS
      // trajLine, which lives on MAIN_VIEW_TRAJ_LAYER instead — see that
      // constant's comment) AND the preview-only layer (the ball marker +
      // previewTrajMesh below); the main/ortho cameras never enable that
      // layer, so they never render either of those two.
      previewCamera.layers.enable(PREVIEW_ONLY_LAYER);

      previewRenderer = new THREE.WebGLRenderer({ antialias: true });
      previewRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      previewRenderer.setSize(pw, ph, false);
      previewRenderer.shadowMap.enabled = true;
      previewRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
      previewRenderer.toneMapping = THREE.ACESFilmicToneMapping;
      previewRenderer.toneMappingExposure = 1.2;
      previewRenderer.outputColorSpace = THREE.SRGBColorSpace;
      previewRenderer.domElement.style.width = "100%";
      previewRenderer.domElement.style.height = "100%";
      previewRenderer.domElement.style.display = "block";
      previewMount.appendChild(previewRenderer.domElement);
    }

    // Aim marker: a small basketball — same size/material/seam construction
    // as the real ball above (BALL_R, seamMat, seamPts1), just placed at
    // rimHeightCrossingPoint(result) each time controls change (see the
    // [controls] effect below) instead of following the flight — where the
    // ball's *already-computed* trajectory passes through rim height.
    // Slightly emissive so it stays clearly visible even where scene
    // lighting is dim (e.g. a wide miss, far from the rim's own point light).
    const previewMarker = new THREE.Mesh(
      new THREE.SphereGeometry(BALL_R, 24, 18),
      new THREE.MeshStandardMaterial({ color: 0xd35400, roughness: 0.8, emissive: 0xd35400, emissiveIntensity: 0.3 }),
    );
    previewMarker.visible = false;
    previewMarker.layers.set(PREVIEW_ONLY_LAYER);
    const previewSeam1 = new THREE.Line(new THREE.BufferGeometry().setFromPoints(seamPts1), seamMat);
    previewSeam1.layers.set(PREVIEW_ONLY_LAYER);
    previewMarker.add(previewSeam1);
    const previewSeam2 = new THREE.Line(new THREE.BufferGeometry().setFromPoints(seamPts1), seamMat);
    previewSeam2.rotation.x = Math.PI / 2;
    previewSeam2.layers.set(PREVIEW_ONLY_LAYER);
    previewMarker.add(previewSeam2);
    scene.add(previewMarker);
    previewMarkerRef.current = previewMarker;

    // Preview's own thicker stand-in for the aim line: a real 3D tube (see
    // PREVIEW_TRAJ_TUBE_RADIUS_M's comment above for why not just a fatter
    // Line), rebuilt each time controls change from the SAME points already
    // computed for trajLine — not a second trajectory. The placeholder curve
    // here is just to give TubeGeometry something valid to build until the
    // very first [controls] effect run (on initial mount) replaces it.
    const previewTrajMat = new THREE.MeshBasicMaterial({ color: 0x1e90ff });
    const previewTrajPlaceholderCurve = new THREE.LineCurve3(new THREE.Vector3(0, RIM_Y, RIM_Z), new THREE.Vector3(0, RIM_Y + 0.01, RIM_Z));
    const previewTrajMesh = new THREE.Mesh(
      new THREE.TubeGeometry(previewTrajPlaceholderCurve, 1, PREVIEW_TRAJ_TUBE_RADIUS_M, 8, false),
      previewTrajMat,
    );
    previewTrajMesh.layers.set(PREVIEW_ONLY_LAYER);
    scene.add(previewTrajMesh);
    previewTrajMeshRef.current = previewTrajMesh;

    stateRef.current.renderer = renderer;
    stateRef.current.scene = scene;
    stateRef.current.camera = camera;
    stateRef.current.orthoCamera = orthoCamera;
    stateRef.current.ball = ball;
    stateRef.current.markerGroup = markerGroup;
    stateRef.current.trajLine = trajLine;
    stateRef.current.heatmapMesh = heatmapMesh;
    stateRef.current.heatmapMaterial = heatmapMaterial;
    stateRef.current.keyMaterial = keyMat;
    stateRef.current.heatmapTexture = heatmapTexture;
    stateRef.current.heatmapPixelData = heatmapPixelData;

    // Position ball at release
    const rp = releasePosition(controls);
    ball.position.copy(rp);

    let raf = 0;
    let last = performance.now();
    const animate = () => {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 1 / 30);
      last = now;
      const st = stateRef.current;
      if (st.flying && st.ball && st.result) {
        // Physics is fully precomputed by simulate() at shoot time (see the
        // shootTrigger effect below); this loop only interpolates the ball's
        // position along that fixed trajectory by elapsed real time, so
        // playback speed can never feed back into the physics itself.
        const traj = st.result.trajectory;
        const sampleCount = traj.length / 4;
        const elapsed = (now - st.playStartTime) / 1000;

        while (st.trajCursor < sampleCount - 2 && traj[(st.trajCursor + 1) * 4] <= elapsed) {
          st.trajCursor++;
        }
        const i0 = st.trajCursor * 4;
        const i1 = Math.min(st.trajCursor + 1, sampleCount - 1) * 4;
        const t0 = traj[i0];
        const t1 = traj[i1];
        const segDur = t1 - t0;
        const frac = segDur > 0 ? Math.min(1, Math.max(0, (elapsed - t0) / segDur)) : 1;

        const x0 = traj[i0 + 1], y0 = traj[i0 + 2], z0 = traj[i0 + 3];
        const x1 = traj[i1 + 1], y1 = traj[i1 + 2], z1 = traj[i1 + 3];
        st.ball.position.set(x0 + (x1 - x0) * frac, y0 + (y1 - y0) * frac, z0 + (z1 - z0) * frac);

        // Rolling animation: approximate velocity via the current segment's
        // finite difference — visual only, doesn't feed back into physics.
        if (segDur > 0) {
          const vx = (x1 - x0) / segDur;
          const vz = (z1 - z0) / segDur;
          st.ball.rotation.x += vz * dt * 4;
          st.ball.rotation.z -= vx * dt * 4;
        }

        // Fire the landing marker at the same moment in playback that the
        // real physics first touched the floor, not at the end of the flight.
        if (!st.landingFired && st.result.floorTime !== null && elapsed >= st.result.floorTime) {
          st.landingFired = true;
          const [fx, fz] = st.result.floorPoint!;
          onLanding({ x: fx, z: fz, made: st.result.outcome === "made" });
        }

        const finalT = traj[(sampleCount - 1) * 4];
        if (elapsed >= finalT) {
          const result = st.result;
          st.ball.position.set(traj[(sampleCount - 1) * 4 + 1], traj[(sampleCount - 1) * 4 + 2], traj[(sampleCount - 1) * 4 + 3]);
          st.flying = false;
          onStats({
            landingX: result.floorPoint?.[0] ?? 0,
            landingZ: result.floorPoint?.[1] ?? 0,
            airTime: result.floorTime ?? 0,
            impactVel: result.floorImpactSpeed ?? 0,
            maxHeight: result.maxHeight,
            rimContacts: result.rimContacts,
            backboardHit: result.backboardHit,
            floorBounces: result.floorBounces,
            travelDist: result.travelDist,
          });
          // reset ball to FT line — uses controlsRef, not controls, so a
          // height/angle/aim/power change made *during* the flight or its
          // settle time is reflected in the reset position (see controlsRef above)
          setTimeout(() => {
            if (!st.ball) return;
            const rp2 = releasePosition(controlsRef.current);
            st.ball.position.copy(rp2);
          }, 800);
        }
      }
      if (st.ball) ballLight.position.set(st.ball.position.x, st.ball.position.y + 0.6, st.ball.position.z);
      // Trajectory line: visible only while setting up a shot, hidden the
      // instant Shoot fires (st.flying) and back the moment it lands — same
      // state, same trigger the aim preview box above already hides/shows on.
      if (st.trajLine) st.trajLine.visible = !st.flying;
      // Camera: the orthographic top-down toggle overrides the normal
      // shooter/hoop-cam switching entirely while active — it exists
      // specifically to read the heat map square-on, not to also track the
      // shot animation. Otherwise, exactly two fixed perspective angles,
      // hard-switched — overhead hoop cam while the shot is in flight,
      // shooter view otherwise. No blending between any of these.
      let activeCamera: THREE.Camera = camera;
      if (st.cameraMode === "orthographic") {
        activeCamera = orthoCamera;
      } else if (st.flying) {
        camera.position.copy(CAM_HOOP_POS);
        camera.lookAt(CAM_HOOP_TARGET);
      } else {
        camera.position.copy(CAM_ORIGINAL_POS);
        camera.lookAt(CAM_ORIGINAL_TARGET);
      }
      const tick = (stateRef.current as any).__ledTick;
      if (tick) tick();
      renderer.render(scene, activeCamera);
      // Aim preview: visible only while setting up a shot, hidden the instant
      // Shoot fires (st.flying) and back the moment it lands. Skipping the
      // render call while hidden (not just hiding it with CSS) avoids paying
      // for a second render pass during the part of the loop where it isn't
      // shown anyway.
      if (previewMount && previewRenderer && previewCamera) {
        previewMount.style.display = st.flying ? "none" : "block";
        if (!st.flying) previewRenderer.render(scene, previewCamera);
      }
      raf = requestAnimationFrame(animate);
    };
    animate();

    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      orthoCamera.left = (-ORTHO_VIEW_HALF_HEIGHT * w) / h;
      orthoCamera.right = (ORTHO_VIEW_HALF_HEIGHT * w) / h;
      orthoCamera.top = ORTHO_VIEW_HALF_HEIGHT;
      orthoCamera.bottom = -ORTHO_VIEW_HALF_HEIGHT;
      orthoCamera.updateProjectionMatrix();
      if (previewMount && previewRenderer && previewCamera) {
        const pw = previewMount.clientWidth;
        const ph = previewMount.clientHeight;
        if (pw > 0 && ph > 0) {
          previewRenderer.setSize(pw, ph, false);
          previewCamera.aspect = pw / ph;
          previewCamera.updateProjectionMatrix();
        }
      }
    };
    // ResizeObserver (not just a window "resize" listener) so the canvas
    // tracks its own container's layout size directly — this is what picks
    // up the bottom sheet panel opening/closing and other container-driven
    // size changes that don't necessarily fire a window resize event.
    // orientationchange is kept alongside it as a belt-and-suspenders nudge
    // for mobile browsers where the container size can settle a frame after
    // the event (dynamic toolbar show/hide).
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(mount);
    if (previewMount) resizeObserver.observe(previewMount);
    window.addEventListener("orientationchange", onResize);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      window.removeEventListener("orientationchange", onResize);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
      if (previewRenderer) {
        previewRenderer.dispose();
        if (previewMount) previewMount.removeChild(previewRenderer.domElement);
      }
    };
  }, []);

  // Update trajectory preview & idle ball position when controls change
  useEffect(() => {
    const st = stateRef.current;
    if (!st.trajLine || !st.ball) return;
    if (!st.flying) {
      const rp = releasePosition(controls);
      st.ball.position.copy(rp);
    }
    const result = simulate(shotParamsFromControls(controls));
    const points = previewPoints(result);
    const canReach = reachesHoop(result);
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    st.trajLine.geometry.dispose();
    st.trajLine.geometry = geo;
    (st.trajLine.material as THREE.LineDashedMaterial).color.set(canReach ? 0x1e90ff : 0xff3333);
    st.trajLine.computeLineDistances();
    if (st.canShoot !== canReach) {
      st.canShoot = canReach;
      onCanShootChange?.(canReach);
    }
    // Preview's own line + ball marker: previewLinePoints(result) truncates
    // at the ball's first actual contact with the rim or backboard (falling
    // back to the rim-height crossing if it never touches either — see that
    // function's comment) — a SEPARATE, shorter cutoff than `points` above,
    // which is what trajLine (main view) keeps using untouched. Both the
    // preview's thick tube and its ball marker are built from this exact
    // same array, so the ball always sits precisely at the line's endpoint
    // by construction — they can't disagree about where that is.
    const previewPts = previewLinePoints(result);
    const previewEnd = previewPts[previewPts.length - 1];
    if (previewMarkerRef.current) {
      if (previewEnd) {
        previewMarkerRef.current.position.copy(previewEnd);
        previewMarkerRef.current.visible = true;
      } else {
        previewMarkerRef.current.visible = false;
      }
    }
    // Needs at least 2 points for a curve — always true in practice
    // (simulate() always samples release + more), guarded here only so a
    // pathological empty trajectory can't throw.
    if (previewTrajMeshRef.current && previewPts.length >= 2) {
      const oldGeo = previewTrajMeshRef.current.geometry;
      previewTrajMeshRef.current.geometry = new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3(previewPts),
        Math.max(previewPts.length * 2, 8),
        PREVIEW_TRAJ_TUBE_RADIUS_M,
        8,
        false,
      );
      oldGeo.dispose();
      (previewTrajMeshRef.current.material as THREE.MeshBasicMaterial).color.set(canReach ? 0x1e90ff : 0xff3333);
    }
  }, [controls, onCanShootChange]);

  // Shoot trigger
  useEffect(() => {
    if (shootTrigger === 0) return;
    const st = stateRef.current;
    if (!st.ball || st.flying || !st.canShoot) return;
    const rp = releasePosition(controls);
    st.ball.position.copy(rp);
    st.result = simulate(shotParamsFromControls(controls));
    st.flying = true;
    st.landingFired = false;
    st.playStartTime = performance.now();
    st.trajCursor = 0;
    // Hide the aim preview box and trajectory line immediately (the
    // animate() loop also enforces both every frame off st.flying, but
    // setting them here too means they disappear on this exact click rather
    // than waiting up to one frame).
    if (previewMountRef.current) previewMountRef.current.style.display = "none";
    if (st.trajLine) st.trajLine.visible = false;
  }, [shootTrigger]);

  // Sync markers
  useEffect(() => {
    const st = stateRef.current;
    if (!st.markerGroup) return;
    // clear
    while (st.markerGroup.children.length) {
      const c = st.markerGroup.children.pop()!;
      (c as THREE.Mesh).geometry?.dispose();
    }
    const geo = new THREE.CircleGeometry(0.15, 24);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff2233, transparent: true, opacity: 0.85 });
    // Made shots don't get a landing mark — the red disc means "this is where
    // the miss came down," which isn't meaningful once the ball's already
    // gone through the net. markers itself still gets an entry either way
    // (routes/index.tsx's "Total shots" count is markers.length), only the
    // disc is skipped here.
    for (const m of markers) {
      if (m.made) continue;
      const disc = new THREE.Mesh(geo, mat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(m.x, 0.005, m.z);
      st.markerGroup.add(disc);
    }
  }, [markers]);

  // Redraw the heat map texture whenever the sweep result, opacity, or layer
  // selection changes. Building the pixel buffer is pure math (heatmapPixels.ts);
  // this effect just copies it into the DataTexture already sitting in the scene.
  useEffect(() => {
    const st = stateRef.current;
    if (!st.heatmapMesh || !st.heatmapMaterial || !st.heatmapTexture || !st.heatmapPixelData) return;
    if (!heatmap) {
      st.heatmapMesh.visible = false;
      st.keyMaterial?.color.setHex(KEY_COLOR_NORMAL);
      return;
    }
    const pixels = computeHeatmapPixels(heatmap.grid, { layer: heatmap.layer });
    st.heatmapPixelData.set(pixels);
    st.heatmapTexture.needsUpdate = true;
    st.heatmapMaterial.uniforms.opacity.value = heatmap.opacity;
    st.heatmapMesh.visible = true;
    // The key's own paint is a solid, saturated blue that — sitting right where
    // most rebounds land — reads as a hard rectangular "background" competing
    // with the heat map's warm colours over empty cells. Mute it to a neutral
    // tone while the heat map is showing so only real density stands out; this
    // recolours existing paint, it doesn't touch the heat map's own transparency.
    st.keyMaterial?.color.setHex(KEY_COLOR_MUTED);
  }, [heatmap]);

  return (
    <div className="relative w-full h-full overscroll-none">
      <div ref={mountRef} className="w-full h-full" />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="absolute top-3 right-3 h-11 bg-card/90 lg:h-8"
        onClick={() => {
          const next = cameraMode === "perspective" ? "orthographic" : "perspective";
          setCameraMode(next);
          stateRef.current.cameraMode = next;
        }}
      >
        {cameraMode === "perspective" ? "Top-down view" : "Perspective view"}
      </Button>
      {/* Aim preview: rim-from-above box, visible only while setting up a
          shot (hidden/shown imperatively — see the animate() loop and the
          shootTrigger effect above, keyed off st.flying).
          Placement below lg (phones/small tablets) must never cover the hoop
          or get hidden behind the mobile controls sheet (routes/index.tsx):
          portrait rides above the sheet (offset driven by the CSS var, set
          from the controlsOpen prop); landscape sits top-LEFT instead — the
          hoop is top-center and the top-down-view toggle button is top-right
          (top-3, h-11), so top-left clears both without needing any offset.
          Desktop (lg:) keeps the original fixed bottom-right placement/size. */}
      <div
        ref={previewMountRef}
        className="absolute right-3 w-[clamp(5.5rem,30vw,10rem)] h-[clamp(5.5rem,30vw,10rem)] rounded-lg border border-white/25 shadow-lg overflow-hidden pointer-events-none bg-black/40 max-lg:portrait:bottom-[var(--aim-box-panel-offset)] max-lg:landscape:top-3 max-lg:landscape:left-3 max-lg:landscape:right-auto md:w-64 md:h-64 lg:bottom-3 lg:top-auto lg:w-64 lg:h-64"
        style={{ ["--aim-box-panel-offset" as string]: controlsOpen ? "calc(35dvh + 0.75rem)" : "calc(2.75rem + 0.75rem)" }}
      />
    </div>
  );
}