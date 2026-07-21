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
    scene.background = new THREE.Color(0x0a0a12);
    scene.fog = new THREE.Fog(0x0a0a12, 15, 40);

    const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 100);
    camera.position.set(0, 2.6, -6);
    camera.lookAt(0, 2.5, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    // Lights
    const ambient = new THREE.AmbientLight(0xffffff, 0.35);
    scene.add(ambient);
    const spot = new THREE.SpotLight(0xffffff, 2.5, 40, Math.PI / 4, 0.4, 1);
    spot.position.set(3, 12, -3);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    scene.add(spot);
    const spot2 = new THREE.SpotLight(0xffffff, 1.8, 40, Math.PI / 4, 0.4, 1);
    spot2.position.set(-3, 12, 3);
    scene.add(spot2);

    // Floor (hardwood)
    const floorGeo = new THREE.PlaneGeometry(30, 30);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0xc48c50, roughness: 0.4, metalness: 0.1 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Paint (blue key)
    const keyGeo = new THREE.PlaneGeometry(4.9, 5.8);
    const keyMat = new THREE.MeshStandardMaterial({ color: 0x1a5fbf, roughness: 0.5 });
    const key = new THREE.Mesh(keyGeo, keyMat);
    key.rotation.x = -Math.PI / 2;
    key.position.set(0, 0.001, -2.9 + 2.9);
    key.position.z = -2.9 + 2.9 - 2.9; // center between backboard(0) and FT line (-4)
    key.position.z = -2.0;
    scene.add(key);

    // Free throw line (white)
    const lineMat = new THREE.LineBasicMaterial({ color: 0xffffff });
    const ftLineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-2.45, 0.002, FT_LINE_Z),
      new THREE.Vector3(2.45, 0.002, FT_LINE_Z),
    ]);
    scene.add(new THREE.Line(ftLineGeo, lineMat));

    // 3-point arc (approx)
    const arcPts: THREE.Vector3[] = [];
    const arcR = 6.75;
    for (let a = 0; a <= Math.PI; a += Math.PI / 64) {
      arcPts.push(new THREE.Vector3(Math.cos(a) * arcR, 0.002, -Math.sin(a) * arcR + 0));
    }
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(arcPts), lineMat));

    // Backboard
    const bbGeo = new THREE.BoxGeometry(BACKBOARD_W, BACKBOARD_H, 0.05);
    const bbMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff, transparent: true, opacity: 0.25, roughness: 0.05, transmission: 0.9,
    });
    const bb = new THREE.Mesh(bbGeo, bbMat);
    bb.position.set(0, BACKBOARD_Y, BACKBOARD_Z + 0.025);
    scene.add(bb);
    // Shooter square outline
    const sqGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.3, RIM_Y + 0.05, BACKBOARD_Z),
      new THREE.Vector3(0.3, RIM_Y + 0.05, BACKBOARD_Z),
      new THREE.Vector3(0.3, RIM_Y + 0.5, BACKBOARD_Z),
      new THREE.Vector3(-0.3, RIM_Y + 0.5, BACKBOARD_Z),
      new THREE.Vector3(-0.3, RIM_Y + 0.05, BACKBOARD_Z),
    ]);
    scene.add(new THREE.Line(sqGeo, new THREE.LineBasicMaterial({ color: 0xffffff })));

    // Rim (torus)
    const rimGeo = new THREE.TorusGeometry(RIM_RADIUS, RIM_TUBE, 12, 40);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xff6b1a, roughness: 0.4, metalness: 0.6 });
    const rim = new THREE.Mesh(rimGeo, rimMat);
    rim.rotation.x = Math.PI / 2;
    rim.position.set(0, RIM_Y, RIM_Z);
    scene.add(rim);

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

    // Support arm & base
    const armMat = new THREE.MeshStandardMaterial({ color: 0xd4a017, roughness: 0.5, metalness: 0.4 });
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.6), armMat);
    arm.position.set(0, BACKBOARD_Y, BACKBOARD_Z + 0.35);
    scene.add(arm);
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.15, BACKBOARD_Y, 0.15), armMat);
    pole.position.set(0, BACKBOARD_Y / 2, BACKBOARD_Z + 0.65);
    scene.add(pole);
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.4, 1.2), new THREE.MeshStandardMaterial({ color: 0x1a5fbf }));
    base.position.set(0, 0.2, BACKBOARD_Z + 0.9);
    scene.add(base);

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

    // Stadium backdrop
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x111122, roughness: 1 });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(40, 15), wallMat);
    back.position.set(0, 7.5, 8);
    back.rotation.y = Math.PI;
    scene.add(back);
    const backShoot = new THREE.Mesh(new THREE.PlaneGeometry(40, 15), wallMat);
    backShoot.position.set(0, 7.5, -10);
    scene.add(backShoot);
    const sideL = new THREE.Mesh(new THREE.PlaneGeometry(20, 15), wallMat);
    sideL.position.set(-10, 7.5, -1);
    sideL.rotation.y = Math.PI / 2;
    scene.add(sideL);
    const sideR = new THREE.Mesh(new THREE.PlaneGeometry(20, 15), wallMat);
    sideR.position.set(10, 7.5, -1);
    sideR.rotation.y = -Math.PI / 2;
    scene.add(sideR);

    // LED banner
    const ledMat = new THREE.MeshBasicMaterial({ color: 0x1e90ff });
    const led = new THREE.Mesh(new THREE.PlaneGeometry(20, 0.6), ledMat);
    led.position.set(0, 5, 7.9);
    led.rotation.y = Math.PI;
    scene.add(led);

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