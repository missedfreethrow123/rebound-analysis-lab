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

// Court/hoop constants (meters)
const RIM_Y = 3.05;
const RIM_RADIUS = 0.2286; // 45.72cm diameter
const RIM_TUBE = 0.02;
const RIM_Z = 0; // rim center z
const BACKBOARD_Z = 0.15; // back face of rim to backboard
const BACKBOARD_W = 1.8;
const BACKBOARD_H = 1.05;
const BACKBOARD_Y = 3.05 + 0.3; // center
const FT_LINE_Z = -4.0; // free throw line
const BALL_R = 0.117; // size 6-ish
const GRAVITY = -9.81;
const FLOOR_RESTITUTION = 0.75;
const RIM_RESTITUTION = 0.55;
const BACKBOARD_COR = 0.8;
const AIR_DRAG = 0.01;

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

function collideBackboard(pos: THREE.Vector3, vel: THREE.Vector3): boolean {
  // Backboard is a plane at z = BACKBOARD_Z, extents in x/y
  const withinX = Math.abs(pos.x) < BACKBOARD_W / 2 + BALL_R;
  const withinY = pos.y > BACKBOARD_Y - BACKBOARD_H / 2 - BALL_R && pos.y < BACKBOARD_Y + BACKBOARD_H / 2 + BALL_R;
  if (!withinX || !withinY) return false;
  // Ball approaches from -z (shooter side). Front face is at z = BACKBOARD_Z (front).
  const front = BACKBOARD_Z;
  if (pos.z + BALL_R > front && pos.z - BALL_R < front + 0.05) {
    if (vel.z > 0) {
      pos.z = front - BALL_R;
      vel.z = -vel.z * BACKBOARD_COR;
      vel.x *= 0.9;
      vel.y *= 0.9;
      return true;
    }
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
  const bounds = { xMin: -8, xMax: 8, zMin: -10, zMax: 3, yMax: 8 };
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
}: {
  controls: SimControls;
  shootTrigger: number;
  onStats: (s: Stats) => void;
  onLanding: (m: Marker) => void;
  markers: Marker[];
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
  }>({
    ballVel: new THREE.Vector3(),
    ballSpin: new THREE.Vector3(),
    flying: false,
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
    const camera = new THREE.PerspectiveCamera(68, width / height, 0.1, 200);
    camera.position.set(0, 2.4, FT_LINE_Z - 4.2);
    camera.lookAt(0, 2.6, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    // Lights: soft ambient + big hemisphere for arena feel
    scene.add(new THREE.AmbientLight(0xffffff, 0.28));
    scene.add(new THREE.HemisphereLight(0xbfd8ff, 0.06, 0x101018));

    // Overhead floodlight row (8 rigs across the ceiling)
    const rigCount = 9;
    for (let i = 0; i < rigCount; i++) {
      const t = (i / (rigCount - 1)) * 2 - 1; // -1..1
      const sx = t * 8;
      const sz = -2 + (i % 2 === 0 ? -1.5 : 1.5);
      const sl = new THREE.SpotLight(0xffffff, 3.2, 45, Math.PI / 6, 0.35, 1.1);
      sl.position.set(sx, 13, sz);
      sl.target.position.set(sx * 0.25, 0, sz * 0.4);
      sl.castShadow = i === 3 || i === 5;
      if (sl.castShadow) sl.shadow.mapSize.set(1024, 1024);
      scene.add(sl);
      scene.add(sl.target);

      // Volumetric beam cone (additive)
      const beamGeo = new THREE.ConeGeometry(2.6, 13, 24, 1, true);
      const beamMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.045,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.set(sx, 6.5, sz);
      scene.add(beam);

      // Bright fixture
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xffffff }),
      );
      bulb.position.set(sx, 13.05, sz);
      scene.add(bulb);
    }

    // Court key spotlight highlighting hoop
    const keySpot = new THREE.SpotLight(0xfff2d0, 2.4, 30, Math.PI / 5, 0.4, 1.2);
    keySpot.position.set(0, 10, -2);
    keySpot.target.position.set(0, RIM_Y, 0);
    keySpot.castShadow = true;
    keySpot.shadow.mapSize.set(2048, 2048);
    scene.add(keySpot);
    scene.add(keySpot.target);

    // Floor (polished honey hardwood with plank grain)
    const plankCanvas = document.createElement("canvas");
    plankCanvas.width = 512; plankCanvas.height = 512;
    const pctx = plankCanvas.getContext("2d")!;
    const grd = pctx.createLinearGradient(0, 0, 0, 512);
    grd.addColorStop(0, "#d99a5b");
    grd.addColorStop(1, "#b87434");
    pctx.fillStyle = grd; pctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 512; i += 32) {
      pctx.fillStyle = `rgba(60,30,10,${0.25 + Math.random() * 0.2})`;
      pctx.fillRect(0, i, 512, 1);
    }
    for (let i = 0; i < 400; i++) {
      pctx.fillStyle = `rgba(80,40,15,${Math.random() * 0.15})`;
      pctx.fillRect(Math.random() * 512, Math.random() * 512, 1 + Math.random() * 2, 1);
    }
    const floorTex = new THREE.CanvasTexture(plankCanvas);
    floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(8, 8);
    floorTex.colorSpace = THREE.SRGBColorSpace;
    const floorGeo = new THREE.PlaneGeometry(40, 40);
    const floorMat = new THREE.MeshStandardMaterial({
      map: floorTex,
      roughness: 0.35,
      metalness: 0.05,
    });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Paint (vibrant cyan-blue key)
    const keyGeo = new THREE.PlaneGeometry(4.9, 5.8);
    const keyMat = new THREE.MeshStandardMaterial({ color: 0x0aa3d9, roughness: 0.55, metalness: 0.05 });
    const key = new THREE.Mesh(keyGeo, keyMat);
    key.rotation.x = -Math.PI / 2;
    key.position.set(0, 0.002, -2.0);
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

    // Free throw straight line
    scene.add(paintLine([
      new THREE.Vector3(-2.45, 0, FT_LINE_Z),
      new THREE.Vector3(2.45, 0, FT_LINE_Z),
    ], 0.08));

    // Free throw circle/arc (semi in front of FT line, dominant foreground)
    const ftArcPts: THREE.Vector3[] = [];
    const ftR = 1.8;
    for (let a = 0; a <= Math.PI; a += Math.PI / 48) {
      ftArcPts.push(new THREE.Vector3(Math.cos(a) * ftR, 0, FT_LINE_Z - Math.sin(a) * ftR));
    }
    scene.add(paintLine(ftArcPts, 0.07));
    // dashed rear half of FT circle
    for (let a = 0; a < Math.PI; a += Math.PI / 12) {
      const p1 = new THREE.Vector3(Math.cos(a) * ftR, 0, FT_LINE_Z + Math.sin(a) * ftR);
      const p2 = new THREE.Vector3(Math.cos(a + Math.PI / 24) * ftR, 0, FT_LINE_Z + Math.sin(a + Math.PI / 24) * ftR);
      scene.add(paintLine([p1, p2], 0.06));
    }

    // Key rectangle border
    scene.add(paintLine([
      new THREE.Vector3(-2.45, 0, FT_LINE_Z),
      new THREE.Vector3(-2.45, 0, 0),
      new THREE.Vector3(2.45, 0, 0),
      new THREE.Vector3(2.45, 0, FT_LINE_Z),
    ], 0.06));

    // 3-point arc
    const arcPts: THREE.Vector3[] = [];
    const arcR = 6.75;
    for (let a = 0.15; a <= Math.PI - 0.15; a += Math.PI / 96) {
      arcPts.push(new THREE.Vector3(Math.cos(a) * arcR, 0, -Math.sin(a) * arcR));
    }
    scene.add(paintLine(arcPts, 0.07));
    // baseline
    scene.add(paintLine([
      new THREE.Vector3(-7.5, 0, 1.2),
      new THREE.Vector3(7.5, 0, 1.2),
    ], 0.08));

    // Backboard — clear glass with white border and blue frame
    const bbGeo = new THREE.BoxGeometry(BACKBOARD_W, BACKBOARD_H, 0.05);
    const bbMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, transparent: true, opacity: 0.22, roughness: 0.02,
      transmission: 0.92, thickness: 0.05, clearcoat: 1, clearcoatRoughness: 0.05,
    });
    const bb = new THREE.Mesh(bbGeo, bbMat);
    bb.position.set(0, BACKBOARD_Y, BACKBOARD_Z + 0.025);
    scene.add(bb);
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
    framePieces.forEach((p) => scene.add(p));
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
    wbPieces.forEach((p) => scene.add(p));
    // Shooter target square (white filled outline)
    const sqW = 0.6, sqH = 0.45;
    const sqZ = BACKBOARD_Z + 0.051;
    const sqPieces = [
      new THREE.Mesh(new THREE.PlaneGeometry(sqW, borderT), whiteBorderMat),
      new THREE.Mesh(new THREE.PlaneGeometry(sqW, borderT), whiteBorderMat),
      new THREE.Mesh(new THREE.PlaneGeometry(borderT, sqH), whiteBorderMat),
      new THREE.Mesh(new THREE.PlaneGeometry(borderT, sqH), whiteBorderMat),
    ];
    const sqCy = RIM_Y + 0.05 + sqH / 2;
    sqPieces[0].position.set(0, sqCy + sqH / 2, sqZ);
    sqPieces[1].position.set(0, sqCy - sqH / 2, sqZ);
    sqPieces[2].position.set(-sqW / 2, sqCy, sqZ);
    sqPieces[3].position.set(sqW / 2, sqCy, sqZ);
    sqPieces.forEach((p) => scene.add(p));

    // Rim (bright orange)
    const rimGeo = new THREE.TorusGeometry(RIM_RADIUS, RIM_TUBE, 20, 64);
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0xff6a1a,
      emissive: 0xff4400,
      emissiveIntensity: 0.55,
      roughness: 0.35,
      metalness: 0.8,
    });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(0, RIM_Y, RIM_Z);
    scene.add(rim);
    // Rim glow spotlight to make it pop
    const rimLight = new THREE.PointLight(0xff6a1a, 1.5, 4, 2);
    rimLight.position.set(0, RIM_Y + 0.1, RIM_Z);
    scene.add(rimLight);

    // Net (simple lines)
    const netGroup = new THREE.Group();
    const netMat = new THREE.LineBasicMaterial({ color: 0xffffff });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const top = new THREE.Vector3(Math.cos(a) * RIM_RADIUS, RIM_Y, RIM_Z + Math.sin(a) * RIM_RADIUS);
      const bot = new THREE.Vector3(Math.cos(a) * RIM_RADIUS * 0.6, RIM_Y - 0.4, RIM_Z + Math.sin(a) * RIM_RADIUS * 0.6);
      netGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([top, bot]), netMat));
    }
    scene.add(netGroup);

    // Support: yellow cylindrical arm & neck, royal-blue tapered padded base
    const yellowMat = new THREE.MeshStandardMaterial({ color: 0xf6c518, roughness: 0.45, metalness: 0.35 });
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.7, 20), yellowMat);
    arm.rotation.x = Math.PI / 2;
    arm.position.set(0, BACKBOARD_Y, BACKBOARD_Z + 0.4);
    scene.add(arm);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, BACKBOARD_Y - 0.6, 24), yellowMat);
    neck.position.set(0, (BACKBOARD_Y - 0.6) / 2 + 0.6, BACKBOARD_Z + 0.75);
    scene.add(neck);
    // Royal-blue padded base (tapered inward at top)
    const padMat = new THREE.MeshStandardMaterial({ color: 0x1a3fb5, roughness: 0.7, metalness: 0.05 });
    const baseTop = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.75, 0.6, 24), padMat);
    baseTop.position.set(0, 0.6, BACKBOARD_Z + 0.9);
    scene.add(baseTop);
    const baseBottom = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.35, 1.4), padMat);
    baseBottom.position.set(0, 0.175, BACKBOARD_Z + 0.9);
    scene.add(baseBottom);

    // Ball
    const ballGeo = new THREE.SphereGeometry(BALL_R, 32, 24);
    const ballMat = new THREE.MeshStandardMaterial({ color: 0xd35400, roughness: 0.7 });
    const ball = new THREE.Mesh(ballGeo, ballMat);
    ball.castShadow = true;
    scene.add(ball);

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
      new THREE.MeshBasicMaterial({ map: ledTex, side: THREE.BackSide, toneMapped: false }),
    );
    ledRing.position.set(0, 6.2, -1);
    ledRing.scale.set(1, 1, 0.7);
    scene.add(ledRing);
    // animate LED scroll
    const ledClock = { t: 0 };
    const ledTick = () => {
      ledClock.t += 0.002;
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
        const sub = 4;
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
          st.ball.position.addScaledVector(v, h);
          // collisions
          if (collideBackboard(st.ball.position, v)) {
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
  }, [controls]);

  // Shoot trigger
  useEffect(() => {
    if (shootTrigger === 0) return;
    const st = stateRef.current;
    if (!st.ball || st.flying) return;
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