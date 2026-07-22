import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

type Marker = { x: number; z: number };
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

const COURT_WIDTH = M(15); // full width of the half-court, sideline to sideline
const HALF_COURT_LENGTH = M(14); // baseline to half-court line
const BASELINE_TO_RIM = M(1.575); // baseline to the rim-center floor projection (FIBA)
const BACKBOARD_FROM_BASELINE = M(1.2); // backboard set in from the baseline
const LANE_WIDTH = M(4.9); // free-throw lane (key) width, centered on the basket axis
const LANE_LENGTH = M(5.8); // baseline to free-throw line
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
const FT_LINE_Z = BASELINE_Z - LANE_LENGTH;
const HALF_COURT_Z = BASELINE_Z - HALF_COURT_LENGTH;

// Rim/backboard (meters)
const RIM_Y = M(3.05);
const RIM_RADIUS = M(0.225); // 45cm inner diameter (FIBA)
const RIM_TUBE = M(0.02);
const RIM_Z = 0; // rim center z (reference point)
const BACKBOARD_Z = BASELINE_Z - BACKBOARD_FROM_BASELINE; // backboard front face
const BACKBOARD_W = M(1.8);
const BACKBOARD_H = M(1.05);
const BACKBOARD_Y = RIM_Y + M(0.375); // center (bottom edge sits 0.15m below rim: 2.90m)

const BALL_R = M(0.117); // size 6-ish
const GRAVITY = -9.81;
const FLOOR_RESTITUTION = 0.75;
const RIM_RESTITUTION = 0.55;
const BACKBOARD_COR = 0.8;
const AIR_DRAG = 0.01;

// Exactly two fixed camera angles, hard-switched (no in-between motion): the default
// behind-the-shooter view, and an overhead "hoop cam" used while the shot is in flight.
const CAM_ORIGINAL_POS = new THREE.Vector3(0, 3.0, FT_LINE_Z - 5.0);
const CAM_ORIGINAL_TARGET = new THREE.Vector3(0, 2.6, 0);
const CAM_HOOP_POS = new THREE.Vector3(0, RIM_Y + 3.2, RIM_Z - 1.0);
const CAM_HOOP_TARGET = new THREE.Vector3(0, RIM_Y - 1.5, RIM_Z + 1.5);

// Collide sphere with static torus (ring in horizontal plane at y=RIM_Y, centered origin xz)
function collideRim(pos: THREE.Vector3, vel: THREE.Vector3): boolean {
  const dxz = Math.hypot(pos.x, pos.z - RIM_Z);
  if (dxz < 1e-6) return false;
  // nearest point on the ring circle
  const nx = (pos.x / dxz) * RIM_RADIUS;
  const nz = RIM_Z + ((pos.z - RIM_Z) / dxz) * RIM_RADIUS;
  const ny = RIM_Y;
  const dx = pos.x - nx;
  const dy = pos.y - ny;
  const dz = pos.z - nz;
  const d = Math.hypot(dx, dy, dz);
  const minD = BALL_R + RIM_TUBE;
  if (d < minD && d > 1e-6) {
    const nxN = dx / d;
    const nyN = dy / d;
    const nzN = dz / d;
    // push out
    const push = minD - d;
    pos.x += nxN * push;
    pos.y += nyN * push;
    pos.z += nzN * push;
    const vn = vel.x * nxN + vel.y * nyN + vel.z * nzN;
    if (vn < 0) {
      vel.x -= (1 + RIM_RESTITUTION) * vn * nxN;
      vel.y -= (1 + RIM_RESTITUTION) * vn * nyN;
      vel.z -= (1 + RIM_RESTITUTION) * vn * nzN;
    }
    return true;
  }
  return false;
}

// Ball passing cleanly through the hoop opening loses horizontal speed to the net
// (real nets absorb a made shot's forward momentum, which is why swishes drop almost
// straight down instead of sailing on past the backboard support behind the hoop).
const NET_DROP = 0.4; // matches the drawn net cone height below the rim
const NET_DRAG_RATE = 40;
function applyNetResistance(pos: THREE.Vector3, vel: THREE.Vector3, h: number) {
  const dxz = Math.hypot(pos.x, pos.z - RIM_Z);
  if (vel.y < 0 && dxz < RIM_RADIUS - BALL_R && pos.y < RIM_Y && pos.y > RIM_Y - NET_DROP) {
    const damp = Math.exp(-NET_DRAG_RATE * h);
    vel.x *= damp;
    vel.z *= damp;
  }
}

function collideBackboard(pos: THREE.Vector3, vel: THREE.Vector3, prevZ: number): boolean {
  // Backboard is a plane at z = BACKBOARD_Z, extents in x/y
  const withinX = Math.abs(pos.x) < BACKBOARD_W / 2 + BALL_R;
  const withinY = pos.y > BACKBOARD_Y - BACKBOARD_H / 2 - BALL_R && pos.y < BACKBOARD_Y + BACKBOARD_H / 2 + BALL_R;
  if (!withinX || !withinY) return false;
  // Ball approaches from -z (shooter side). Front face is at z = BACKBOARD_Z (front).
  // Crossing test instead of a fixed epsilon shell: fires whenever the ball's leading
  // edge was behind the face last substep and is at/past it now, so a fast ball can't
  // tunnel through by jumping past a fixed-width band in a single substep.
  const front = BACKBOARD_Z;
  const wasInFront = prevZ + BALL_R <= front;
  const isPast = pos.z + BALL_R > front;
  if (wasInFront && isPast && vel.z > 0) {
    pos.z = front - BALL_R;
    vel.z = -vel.z * BACKBOARD_COR;
    vel.x *= 0.9;
    vel.y *= 0.9;
    return true;
  }
  return false;
}

function collideFloor(pos: THREE.Vector3, vel: THREE.Vector3): boolean {
  if (pos.y - BALL_R < 0) {
    pos.y = BALL_R;
    if (vel.y < 0) {
      vel.y = -vel.y * FLOOR_RESTITUTION;
      vel.x *= 0.8;
      vel.z *= 0.8;
      return true;
    }
  }
  return false;
}

function collideWalls(pos: THREE.Vector3, vel: THREE.Vector3) {
  const bounds = { xMin: -SIDELINE_X - 0.5, xMax: SIDELINE_X + 0.5, zMin: HALF_COURT_Z - 1, zMax: BASELINE_Z + 1.5, yMax: 8 };
  if (pos.x - BALL_R < bounds.xMin) { pos.x = bounds.xMin + BALL_R; vel.x = -vel.x * 0.6; }
  if (pos.x + BALL_R > bounds.xMax) { pos.x = bounds.xMax - BALL_R; vel.x = -vel.x * 0.6; }
  if (pos.z - BALL_R < bounds.zMin) { pos.z = bounds.zMin + BALL_R; vel.z = -vel.z * 0.6; }
  if (pos.z + BALL_R > bounds.zMax) { pos.z = bounds.zMax - BALL_R; vel.z = -vel.z * 0.6; }
  if (pos.y + BALL_R > bounds.yMax) { pos.y = bounds.yMax - BALL_R; vel.y = -Math.abs(vel.y) * 0.6; }
}

function computeInitialVelocity(c: SimControls, releasePos: THREE.Vector3) {
  const angle = (c.angleDeg * Math.PI) / 180;
  const aim = (c.aimDeg * Math.PI) / 180;
  const v = c.power;
  // shooter faces +z toward hoop
  const horizontal = v * Math.cos(angle);
  return new THREE.Vector3(horizontal * Math.sin(aim), v * Math.sin(angle), horizontal * Math.cos(aim));
}

function releasePosition(c: SimControls) {
  const h = c.playerHeightCm / 100;
  const releaseY = h * 1.25; // above head
  return new THREE.Vector3(0, releaseY, FT_LINE_Z);
}

// Trajectory preview: simulate without collisions except stop at backboard/rim contact
function predictTrajectory(c: SimControls): { points: THREE.Vector3[]; hitsRim: boolean } {
  const pos = releasePosition(c);
  const vel = computeInitialVelocity(c, pos);
  const pts: THREE.Vector3[] = [pos.clone()];
  const dt = 1 / 120;
  let hitsRim = false;
  for (let i = 0; i < 400; i++) {
    vel.y += GRAVITY * dt;
    pos.addScaledVector(vel, dt);
    pts.push(pos.clone());
    // rim proximity check
    const dxz = Math.hypot(pos.x, pos.z - RIM_Z);
    const dToRing = Math.hypot(dxz - RIM_RADIUS, pos.y - RIM_Y);
    if (dToRing < BALL_R + RIM_TUBE + 0.02) { hitsRim = true; break; }
    // backboard
    if (pos.z > BACKBOARD_Z - BALL_R && Math.abs(pos.x) < BACKBOARD_W / 2 && Math.abs(pos.y - BACKBOARD_Y) < BACKBOARD_H / 2) {
      break;
    }
    if (pos.y < 0) break;
  }
  return { points: pts, hitsRim };
}

export default function FreeThrowSim({
  controls,
  shootTrigger,
  onStats,
  onLanding,
  markers,
  onCanShootChange,
}: {
  controls: SimControls;
  shootTrigger: number;
  onStats: (s: Stats) => void;
  onLanding: (m: Marker) => void;
  markers: Marker[];
  onCanShootChange?: (canShoot: boolean) => void;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef<{
    renderer?: THREE.WebGLRenderer;
    scene?: THREE.Scene;
    camera?: THREE.PerspectiveCamera;
    ball?: THREE.Mesh;
    ballVel: THREE.Vector3;
    ballSpin: THREE.Vector3;
    flying: boolean;
    stats: Stats;
    markerGroup?: THREE.Group;
    trajLine?: THREE.Line;
    startTime: number;
    lastPos: THREE.Vector3;
    landed: boolean;
    canShoot: boolean;
  }>({
    ballVel: new THREE.Vector3(),
    ballSpin: new THREE.Vector3(),
    flying: false,
    canShoot: true,
    stats: {
      landingX: 0, landingZ: 0, airTime: 0, impactVel: 0, maxHeight: 0,
      rimContacts: 0, backboardHit: false, floorBounces: 0, travelDist: 0,
    },
    startTime: 0,
    lastPos: new THREE.Vector3(),
    landed: false,
  });

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
    const camera = new THREE.PerspectiveCamera(80, width / height, 0.1, 200);
    camera.position.copy(CAM_ORIGINAL_POS);
    camera.lookAt(CAM_ORIGINAL_TARGET);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
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

      // Bright fixture
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      bulb.position.set(sx, 13.05, sz);
      scene.add(bulb);
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
    floorTex.repeat.set(8, 8);
    floorTex.colorSpace = THREE.SRGBColorSpace;
    const floorGeo = new THREE.PlaneGeometry(40, 40);
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
    // LANE_WIDTH wide x LANE_LENGTH long, centered on the basket's x=0 axis,
    // running from the baseline to the free-throw line.
    const keyGeo = new THREE.PlaneGeometry(LANE_WIDTH, LANE_LENGTH);
    const keyMat = new THREE.MeshStandardMaterial({ color: 0x0088ff, roughness: 0.5, metalness: 0.1 });
    const key = new THREE.Mesh(keyGeo, keyMat);
    key.rotation.x = -Math.PI / 2;
    key.position.set(0, 0.002, (BASELINE_Z + FT_LINE_Z) / 2);
    key.receiveShadow = true;
    scene.add(key);

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

    // Baseline: full COURT_WIDTH, at the near edge of the half-court
    scene.add(paintLine([
      new THREE.Vector3(-SIDELINE_X, 0, BASELINE_Z),
      new THREE.Vector3(SIDELINE_X, 0, BASELINE_Z),
    ], 0.08));

    // Sidelines: run the HALF_COURT_LENGTH from the baseline to the half-court line
    scene.add(paintLine([
      new THREE.Vector3(-SIDELINE_X, 0, BASELINE_Z),
      new THREE.Vector3(-SIDELINE_X, 0, HALF_COURT_Z),
    ], 0.08));
    scene.add(paintLine([
      new THREE.Vector3(SIDELINE_X, 0, BASELINE_Z),
      new THREE.Vector3(SIDELINE_X, 0, HALF_COURT_Z),
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

    // Key/lane rectangle border, baseline to free-throw line
    scene.add(paintLine([
      new THREE.Vector3(-LANE_HALF_WIDTH, 0, FT_LINE_Z),
      new THREE.Vector3(-LANE_HALF_WIDTH, 0, BASELINE_Z),
      new THREE.Vector3(LANE_HALF_WIDTH, 0, BASELINE_Z),
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
    // short connectors from the restricted-area arc's open ends to the baseline
    scene.add(paintLine([
      new THREE.Vector3(-RESTRICTED_AREA_R, 0, 0), new THREE.Vector3(-RESTRICTED_AREA_R, 0, BASELINE_Z),
    ], 0.05));
    scene.add(paintLine([
      new THREE.Vector3(RESTRICTED_AREA_R, 0, 0), new THREE.Vector3(RESTRICTED_AREA_R, 0, BASELINE_Z),
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
      new THREE.Vector3(-THREE_PT_CORNER_X, 0, BASELINE_Z), new THREE.Vector3(-THREE_PT_CORNER_X, 0, threePtArcEndZ),
    ], 0.07));
    scene.add(paintLine([
      new THREE.Vector3(THREE_PT_CORNER_X, 0, BASELINE_Z), new THREE.Vector3(THREE_PT_CORNER_X, 0, threePtArcEndZ),
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

    // Half-court line, and the center circle's near half (the only part visible
    // on a half-court view), radius CENTER_CIRCLE_R centered exactly on that line
    scene.add(paintLine([
      new THREE.Vector3(-SIDELINE_X, 0, HALF_COURT_Z),
      new THREE.Vector3(SIDELINE_X, 0, HALF_COURT_Z),
    ], 0.08));
    const centerCirclePts: THREE.Vector3[] = [];
    for (let a = 0; a <= Math.PI; a += Math.PI / 48) {
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
    // Purely cosmetic — collision physics is handled analytically in collideRim/
    // collideBackboard and doesn't reference this mesh, so it stays untouched.
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
    // The base + ballast must sit entirely behind the baseline (outside the play
    // area) — only the arm, backboard, and rim are allowed to cross into the court.
    const SUPPORT_ARM_Z = BACKBOARD_Z + 0.85;
    const SUPPORT_NECK_Z = BACKBOARD_Z + 1.7;
    const SUPPORT_BASE_Z = BACKBOARD_Z + 2.0; // near face at BASELINE_Z + 0.1, clear of the baseline
    const yellowMat = new THREE.MeshStandardMaterial({ color: 0xa8cc2e, roughness: 0.45, metalness: 0.35 });
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.7, 20), yellowMat);
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

    // Lens flare / sun star sprites near ceiling lights
    const flareCanvas = document.createElement("canvas");
    flareCanvas.width = 256; flareCanvas.height = 256;
    const fctx = flareCanvas.getContext("2d")!;
    const rg = fctx.createRadialGradient(128, 128, 0, 128, 128, 128);
    rg.addColorStop(0, "rgba(255,255,255,1)");
    rg.addColorStop(0.15, "rgba(255,255,240,0.6)");
    rg.addColorStop(0.4, "rgba(255,220,180,0.15)");
    rg.addColorStop(1, "rgba(255,255,255,0)");
    fctx.fillStyle = rg; fctx.fillRect(0, 0, 256, 256);
    fctx.strokeStyle = "rgba(255,255,255,0.55)";
    fctx.lineWidth = 2;
    fctx.beginPath(); fctx.moveTo(0, 128); fctx.lineTo(256, 128); fctx.stroke();
    fctx.beginPath(); fctx.moveTo(128, 0); fctx.lineTo(128, 256); fctx.stroke();
    const flareTex = new THREE.CanvasTexture(flareCanvas);
    const flareMat = new THREE.SpriteMaterial({
      map: flareTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, depthTest: false,
    });
    for (let i = 0; i < rigCount; i++) {
      const t = (i / (rigCount - 1)) * 2 - 1;
      const sx = t * 8;
      const sz = -2 + (i % 2 === 0 ? -1.5 : 1.5);
      const s = new THREE.Sprite(flareMat.clone());
      s.position.set(sx, 12.6, sz);
      s.scale.set(3.5, 3.5, 1);
      scene.add(s);
    }

    stateRef.current.renderer = renderer;
    stateRef.current.scene = scene;
    stateRef.current.camera = camera;
    stateRef.current.ball = ball;
    stateRef.current.markerGroup = markerGroup;
    stateRef.current.trajLine = trajLine;

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
      if (st.flying && st.ball) {
        // Adaptive substepping: at high ball speed a fixed substep count can let the ball
        // travel farther in one step than the rim's thin collision shell, tunneling straight
        // through it undetected. Sizing substeps off the current speed keeps each step short
        // enough that the rim (and backboard/floor) collision checks can't be skipped over.
        const speed = st.ballVel.length();
        const maxSubstepDist = 0.015;
        const sub = Math.min(64, Math.max(4, Math.ceil((speed * dt) / maxSubstepDist)));
        const h = dt / sub;
        for (let s = 0; s < sub; s++) {
          // air drag
          const v = st.ballVel;
          const speed = v.length();
          if (speed > 0) {
            const drag = AIR_DRAG * speed * speed;
            v.addScaledVector(v.clone().normalize(), -drag * h);
          }
          v.y += GRAVITY * h;
          const prevZ = st.ball.position.z;
          st.ball.position.addScaledVector(v, h);
          applyNetResistance(st.ball.position, v, h);
          // collisions
          if (collideBackboard(st.ball.position, v, prevZ)) {
            st.stats.backboardHit = true;
          }
          if (collideRim(st.ball.position, v)) {
            st.stats.rimContacts += 1;
          }
          if (collideFloor(st.ball.position, v)) {
            st.stats.floorBounces += 1;
            if (!st.landed) {
              st.landed = true;
              st.stats.landingX = st.ball.position.x;
              st.stats.landingZ = st.ball.position.z;
              st.stats.airTime = (now - st.startTime) / 1000;
              st.stats.impactVel = v.length();
              onLanding({ x: st.ball.position.x, z: st.ball.position.z });
            }
          }
          collideWalls(st.ball.position, v);
          st.stats.travelDist += st.ball.position.distanceTo(st.lastPos);
          st.lastPos.copy(st.ball.position);
          if (st.ball.position.y > st.stats.maxHeight) st.stats.maxHeight = st.ball.position.y;
        }
        // rotation from velocity
        st.ball.rotation.x += st.ballVel.z * dt * 4;
        st.ball.rotation.z -= st.ballVel.x * dt * 4;
        // stop check
        if (st.ballVel.length() < 0.3 && st.ball.position.y < BALL_R + 0.01) {
          st.flying = false;
          onStats({ ...st.stats });
          // reset ball to FT line
          setTimeout(() => {
            if (!st.ball) return;
            const rp2 = releasePosition(controls);
            st.ball.position.copy(rp2);
          }, 800);
        }
      }
      if (st.ball) ballLight.position.set(st.ball.position.x, st.ball.position.y + 0.6, st.ball.position.z);
      // Camera: exactly two fixed angles, hard-switched — overhead hoop cam while the
      // shot is in flight, shooter view otherwise. No blending between them.
      if (st.flying) {
        camera.position.copy(CAM_HOOP_POS);
        camera.lookAt(CAM_HOOP_TARGET);
      } else {
        camera.position.copy(CAM_ORIGINAL_POS);
        camera.lookAt(CAM_ORIGINAL_TARGET);
      }
      const tick = (stateRef.current as any).__ledTick;
      if (tick) tick();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
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
    const { points, hitsRim } = predictTrajectory(controls);
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    st.trajLine.geometry.dispose();
    st.trajLine.geometry = geo;
    (st.trajLine.material as THREE.LineDashedMaterial).color.set(hitsRim ? 0x1e90ff : 0xff3333);
    st.trajLine.computeLineDistances();
    if (st.canShoot !== hitsRim) {
      st.canShoot = hitsRim;
      onCanShootChange?.(hitsRim);
    }
  }, [controls, onCanShootChange]);

  // Shoot trigger
  useEffect(() => {
    if (shootTrigger === 0) return;
    const st = stateRef.current;
    if (!st.ball || st.flying || !st.canShoot) return;
    const rp = releasePosition(controls);
    st.ball.position.copy(rp);
    st.ballVel.copy(computeInitialVelocity(controls, rp));
    st.flying = true;
    st.landed = false;
    st.startTime = performance.now();
    st.lastPos.copy(rp);
    st.stats = {
      landingX: 0, landingZ: 0, airTime: 0, impactVel: 0, maxHeight: rp.y,
      rimContacts: 0, backboardHit: false, floorBounces: 0, travelDist: 0,
    };
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
    for (const m of markers) {
      const disc = new THREE.Mesh(geo, mat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(m.x, 0.005, m.z);
      st.markerGroup.add(disc);
    }
  }, [markers]);

  return <div ref={mountRef} className="w-full h-full" />;
}