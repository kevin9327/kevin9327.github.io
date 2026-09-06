// Gunslash Arena — a third-person wall-running sword-and-gun arena.
// Level, effects, HUD and sounds are generated in code. The fighters are the
// KayKit "Adventurers" characters by Kay Lousberg (CC0), loaded from assets/kaykit;
// if they cannot be loaded the game falls back to box-built fighters.
//
// URL params:  ?bots=8      number of bots (free-for-all)
//              ?demo=1      the player is driven by the bot brain (for capture)
//              ?record=12   deterministic stepping at 12 fps; window.__step() advances one frame
//              ?god=1       the player shrugs off damage (for capture)
//              ?bloom=0     disable post-processing
//              ?boxes=1     force the box-built fighters

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';

const Q = new URLSearchParams(location.search);
const BOT_COUNT = Math.max(0, Math.min(20, parseInt(Q.get('bots') || '8', 10) || 8));
const DEMO = Q.get('demo') === '1';
const RECORD_FPS = parseInt(Q.get('record') || '0', 10) || 0;
const POST = Q.get('bloom') !== '0';
const GOD = Q.get('god') === '1';
const BOXES = Q.get('boxes') === '1';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------------ audio (synthesised)
const SFX = {
  ctx: null,
  init() {
    if (this.ctx || RECORD_FPS) return;
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { this.ctx = null; }
    if (!this.ctx) return;
    const n = this.ctx.sampleRate * 1.5, buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf; this.master = this.ctx.createGain(); this.master.gain.value = 0.35; this.master.connect(this.ctx.destination);
  },
  env(node, t0, a, d, peak = 1) { const g = this.ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(peak, t0 + a); g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d); node.connect(g); g.connect(this.master); return g; },
  burst(dur, freq, qv, peak, type = 'lowpass') { if (!this.ctx) return; const t = this.ctx.currentTime, s = this.ctx.createBufferSource(); s.buffer = this.noise; const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = qv; s.connect(f); this.env(f, t, 0.005, dur, peak); s.start(t); s.stop(t + dur + 0.05); },
  tone(f0, f1, dur, peak = 0.4, type = 'square') { if (!this.ctx) return; const t = this.ctx.currentTime, o = this.ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur); this.env(o, t, 0.005, dur, peak); o.start(t); o.stop(t + dur + 0.05); },
  shot() { this.burst(0.18, 1400, 0.7, 0.9); this.tone(180, 40, 0.12, 0.5, 'sawtooth'); },
  slash() { this.burst(0.22, 3200, 1.2, 0.5, 'bandpass'); },
  hit() { this.tone(900, 300, 0.08, 0.35, 'triangle'); },
  clang() { this.tone(1800, 1200, 0.12, 0.3, 'square'); this.burst(0.1, 5000, 1, 0.3, 'highpass'); },
  jump() { this.tone(300, 620, 0.12, 0.25, 'sine'); },
  land() { this.burst(0.08, 300, 0.7, 0.25); },
  dash() { this.burst(0.25, 900, 0.5, 0.45, 'highpass'); },
  step() { this.burst(0.05, 500, 0.8, 0.12); },
  reload() { this.tone(500, 800, 0.06, 0.25, 'square'); setTimeout(() => this.tone(800, 400, 0.06, 0.25, 'square'), 180); },
  die() { this.tone(400, 60, 0.5, 0.5, 'sawtooth'); this.burst(0.4, 600, 0.6, 0.6); },
  wall() { this.burst(0.12, 700, 0.9, 0.2, 'bandpass'); },
};

// ------------------------------------------------------------------ procedural textures
function canvasTex(size, draw, repeat = [1, 1], w = size) {
  const c = document.createElement('canvas'); c.width = w; c.height = size; draw(c.getContext('2d'), w, size);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
function speckle(g, w, h, n, alpha, col = '#000') { g.fillStyle = col; for (let i = 0; i < n; i++) { g.globalAlpha = Math.random() * alpha; g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2); } g.globalAlpha = 1; }
function radialTex(stops, size = 64) { const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d'); const r = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2); for (const [k, col] of stops) r.addColorStop(k, col); g.fillStyle = r; g.fillRect(0, 0, size, size); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; }
const TEX = {
  stone: (rep) => canvasTex(512, (g, w, h) => {
    g.fillStyle = '#6a625a'; g.fillRect(0, 0, w, h); speckle(g, w, h, 12000, 0.35); speckle(g, w, h, 5000, 0.25, '#fff');
    const bh = 64, bw = 128; g.strokeStyle = 'rgba(25,20,16,.85)'; g.lineWidth = 4;
    for (let y = 0; y < h; y += bh) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); const off = (y / bh) % 2 ? bw / 2 : 0; for (let x = off; x < w; x += bw) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + bh); g.stroke(); } }
    g.globalAlpha = 0.18; g.fillStyle = '#000'; for (let y = 0; y < h; y += bh) g.fillRect(0, y + bh - 8, w, 8); g.globalAlpha = 1;
  }, rep),
  marbleTile: (rep) => canvasTex(512, (g, w, h) => {
    const cell = 128;
    for (let y = 0; y < h; y += cell) for (let x = 0; x < w; x += cell) {
      const dark = ((x + y) / cell) % 2 === 1; g.fillStyle = dark ? '#3b3a45' : '#d9d6cf'; g.fillRect(x, y, cell, cell);
      g.strokeStyle = dark ? 'rgba(255,255,255,.14)' : 'rgba(60,50,50,.28)'; g.lineWidth = 1.2;
      for (let i = 0; i < 9; i++) { g.beginPath(); let px = x + Math.random() * cell, py = y + Math.random() * cell; g.moveTo(px, py); for (let k = 0; k < 5; k++) { px += rand(-40, 40); py += rand(-40, 40); g.lineTo(clamp(px, x, x + cell), clamp(py, y, y + cell)); } g.stroke(); }
      g.strokeStyle = 'rgba(0,0,0,.55)'; g.lineWidth = 3; g.strokeRect(x + 1.5, y + 1.5, cell - 3, cell - 3);
    }
  }, rep),
  marble: (rep) => canvasTex(512, (g, w, h) => {
    g.fillStyle = '#cdc7bc'; g.fillRect(0, 0, w, h); speckle(g, w, h, 3000, 0.1); g.strokeStyle = 'rgba(80,70,70,.3)'; g.lineWidth = 1.5;
    for (let i = 0; i < 40; i++) { g.beginPath(); let x = Math.random() * w, y = Math.random() * h; g.moveTo(x, y); for (let k = 0; k < 6; k++) { x += rand(-80, 80); y += rand(-80, 80); g.lineTo(x, y); } g.stroke(); }
  }, rep),
  carpet: (rep) => canvasTex(256, (g, w, h) => {
    g.fillStyle = '#7d1526'; g.fillRect(0, 0, w, h); speckle(g, w, h, 6000, 0.3); speckle(g, w, h, 2000, 0.15, '#ffb0b0');
    g.fillStyle = '#d9a441'; g.fillRect(0, 0, w, 12); g.fillRect(0, h - 12, w, 12); g.fillStyle = '#2b0810'; g.fillRect(0, 14, w, 4); g.fillRect(0, h - 18, w, 4);
    g.strokeStyle = 'rgba(217,164,65,.45)'; g.lineWidth = 2; for (let x = 0; x < w; x += 64) { g.beginPath(); g.moveTo(x + 32, 40); g.lineTo(x + 56, h / 2); g.lineTo(x + 32, h - 40); g.lineTo(x + 8, h / 2); g.closePath(); g.stroke(); }
  }, rep),
  wood: (rep) => canvasTex(256, (g, w, h) => { g.fillStyle = '#4a2c16'; g.fillRect(0, 0, w, h); g.globalAlpha = 0.35; g.strokeStyle = '#2a1608'; for (let i = 0; i < 90; i++) { g.beginPath(); const y = Math.random() * h; g.moveTo(0, y); g.bezierCurveTo(w / 3, y + rand(-6, 6), 2 * w / 3, y + rand(-6, 6), w, y + rand(-4, 4)); g.stroke(); } g.globalAlpha = 1; }, rep),
  gold: () => canvasTex(64, (g, w, h) => { g.fillStyle = '#d4a637'; g.fillRect(0, 0, w, h); speckle(g, w, h, 200, 0.3, '#fff'); }),
  ceiling: (rep) => canvasTex(256, (g, w, h) => { g.fillStyle = '#26222c'; g.fillRect(0, 0, w, h); g.fillStyle = '#1a171f'; g.fillRect(12, 12, w - 24, h - 24); g.strokeStyle = 'rgba(212,166,55,.35)'; g.lineWidth = 3; g.strokeRect(22, 22, w - 44, h - 44); }, rep),
  painting: (seed) => canvasTex(256, (g, w, h) => {
    const hue = (seed * 67) % 360; const sky = g.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, `hsl(${hue},40%,55%)`); sky.addColorStop(0.6, `hsl(${(hue + 40) % 360},50%,35%)`); sky.addColorStop(1, `hsl(${(hue + 80) % 360},30%,15%)`);
    g.fillStyle = sky; g.fillRect(0, 0, w, h); g.fillStyle = 'rgba(0,0,0,.55)';
    for (let i = 0; i < 6; i++) { g.beginPath(); g.moveTo(0, h); const step = w / 6; for (let x = 0; x <= w; x += step) g.lineTo(x, h * (0.45 + 0.1 * i) + Math.sin(x / 30 + seed + i) * 18); g.lineTo(w, h); g.closePath(); g.fill(); }
    g.fillStyle = `hsla(${(hue + 180) % 360},80%,85%,.9)`; g.beginPath(); g.arc(w * 0.7, h * 0.28, 18, 0, 7); g.fill(); speckle(g, w, h, 1500, 0.12);
  }, [1, 1], 320),
  flame: () => radialTex([[0, 'rgba(255,255,220,1)'], [0.3, 'rgba(255,190,80,.9)'], [0.7, 'rgba(255,90,20,.35)'], [1, 'rgba(255,60,0,0)']]),
  soft: () => radialTex([[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,.5)'], [1, 'rgba(255,255,255,0)']]),
  shaft: () => { const c = document.createElement('canvas'); c.width = 64; c.height = 256; const g = c.getContext('2d'); const r = g.createLinearGradient(0, 0, 0, 256); r.addColorStop(0, 'rgba(255,230,180,.55)'); r.addColorStop(1, 'rgba(255,230,180,0)'); g.fillStyle = r; g.fillRect(0, 0, 64, 256); const s = g.createLinearGradient(0, 0, 64, 0); s.addColorStop(0, 'rgba(0,0,0,1)'); s.addColorStop(0.5, 'rgba(0,0,0,0)'); s.addColorStop(1, 'rgba(0,0,0,1)'); g.globalCompositeOperation = 'destination-out'; g.fillStyle = s; g.fillRect(0, 0, 64, 256); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; },
  muzzle: () => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); g.translate(32, 32); g.fillStyle = 'rgba(255,220,120,1)'; for (let i = 0; i < 8; i++) { g.rotate(Math.PI / 4); g.beginPath(); g.moveTo(0, -3); g.lineTo(30 - (i % 2) * 12, 0); g.lineTo(0, 3); g.closePath(); g.fill(); } g.fillStyle = '#fff'; g.beginPath(); g.arc(0, 0, 7, 0, 7); g.fill(); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t; },
};

// ------------------------------------------------------------------ renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: !POST, powerPreference: 'high-performance', preserveDrawingBuffer: !!RECORD_FPS });
renderer.setPixelRatio(RECORD_FPS ? 1 : Math.min(devicePixelRatio, innerWidth * innerHeight > 1_500_000 ? 1 : 1.25));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.95;
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x08070c);
scene.fog = new THREE.Fog(0x0a0810, 40, 120);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.55;
const camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, 0.1, 220);

scene.add(new THREE.HemisphereLight(0x8f86d8, 0x2e2216, 0.7));
const sun = new THREE.DirectionalLight(0xffe2bf, 1.5);
sun.position.set(14, 34, -10); sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024); Object.assign(sun.shadow.camera, { left: -46, right: 46, top: 42, bottom: -42, far: 100 }); sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.02;
scene.add(sun);

// ------------------------------------------------------------------ level
const colliders = [];
const levelMeshes = [];   // everything solid or big: used for bullets, line of sight and the camera
const level = new THREE.Group(); scene.add(level);
const HW = 30, HD = 20, HH = 15, BY = 5, BW = 6;
const MAT = {
  stone: new THREE.MeshStandardMaterial({ map: TEX.stone([8, 4]), roughness: 0.95 }),
  stoneWide: new THREE.MeshStandardMaterial({ map: TEX.stone([16, 4]), roughness: 0.95 }),
  floor: new THREE.MeshStandardMaterial({ map: TEX.marbleTile([15, 10]), roughness: 0.22, metalness: 0.08, envMapIntensity: 1.2 }),
  carpet: new THREE.MeshStandardMaterial({ map: TEX.carpet([12, 1]), roughness: 1.0 }),
  marble: new THREE.MeshStandardMaterial({ map: TEX.marble([2, 2]), roughness: 0.38, metalness: 0.05, envMapIntensity: 0.7 }),
  gold: new THREE.MeshStandardMaterial({ map: TEX.gold(), roughness: 0.3, metalness: 0.9, envMapIntensity: 1.4 }),
  wood: new THREE.MeshStandardMaterial({ map: TEX.wood([2, 2]), roughness: 0.65 }),
  ceiling: new THREE.MeshStandardMaterial({ map: TEX.ceiling([16, 11]), roughness: 0.9 }),
  glow: new THREE.MeshStandardMaterial({ color: 0xffe0b0, emissive: 0xffc070, emissiveIntensity: 2.6 }),
  window: new THREE.MeshStandardMaterial({ color: 0xbfd6ff, emissive: 0x9fc0ff, emissiveIntensity: 1.9 }),
  dark: new THREE.MeshStandardMaterial({ color: 0x14121a, roughness: 0.8 }),
  steel: new THREE.MeshStandardMaterial({ color: 0xe3e9f5, metalness: 0.95, roughness: 0.12, envMapIntensity: 1.6 }),
};
function box(w, h, d, x, y, z, mat, { solid = true, shadow = true, receive = true } = {}) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); m.castShadow = shadow; m.receiveShadow = receive; level.add(m); if (solid || w * h * d > 2) levelMeshes.push(m);
  if (solid) colliders.push({ min: V3(x - w / 2, y - h / 2, z - d / 2), max: V3(x + w / 2, y + h / 2, z + d / 2) });
  return m;
}
function cyl(r, h, x, y, z, mat, seg = 20, solid = true) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, seg), mat); m.position.set(x, y, z); m.castShadow = m.receiveShadow = solid; level.add(m); if (solid) levelMeshes.push(m);
  if (solid) colliders.push({ min: V3(x - r, y - h / 2, z - r), max: V3(x + r, y + h / 2, z + r) }); return m;
}
box(2 * HW + 2, 1, 2 * HD + 2, 0, -0.5, 0, MAT.floor);
box(2 * HW - 4, 0.05, 7, 0, 0.026, 0, MAT.carpet, { solid: false, shadow: false });
box(2 * HW + 2, 1, 2 * HD + 2, 0, HH + 0.5, 0, MAT.ceiling, { shadow: false });
box(2 * HW + 2, HH, 1, 0, HH / 2, -HD - 0.5, MAT.stoneWide); box(2 * HW + 2, HH, 1, 0, HH / 2, HD + 0.5, MAT.stoneWide);
box(1, HH, 2 * HD + 2, -HW - 0.5, HH / 2, 0, MAT.stone); box(1, HH, 2 * HD + 2, HW + 0.5, HH / 2, 0, MAT.stone);
for (const sz of [-1, 1]) { box(2 * HW, 0.5, 0.25, 0, 0.25, sz * (HD - 0.12), MAT.dark, { solid: false }); box(2 * HW, 0.35, 0.5, 0, HH - 0.35, sz * (HD - 0.25), MAT.gold, { solid: false, shadow: false }); }
for (const sx of [-1, 1]) { box(0.25, 0.5, 2 * HD, sx * (HW - 0.12), 0.25, 0, MAT.dark, { solid: false }); box(0.5, 0.35, 2 * HD, sx * (HW - 0.25), HH - 0.35, 0, MAT.gold, { solid: false, shadow: false }); }
for (let x = -24; x <= 24; x += 12) box(0.7, 0.7, 2 * HD, x, HH - 0.35, 0, MAT.wood, { solid: false, shadow: false });
for (let z = -12; z <= 12; z += 12) box(2 * HW, 0.7, 0.7, 0, HH - 0.35, z, MAT.wood, { solid: false, shadow: false });
const shaftTex = TEX.shaft();
for (const sz of [-1, 1]) for (let i = 0; i < 5; i++) {
  const x = -24 + i * 12;
  box(1.2, HH, 0.5, x - 6, HH / 2, sz * (HD - 0.25), MAT.marble, { solid: false });
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(3.6, 5.2), MAT.window); pane.position.set(x, 9.2, sz * (HD - 0.02)); pane.rotation.y = sz > 0 ? Math.PI : 0; level.add(pane);
  const arch = new THREE.Mesh(new THREE.CircleGeometry(1.8, 24, 0, Math.PI), MAT.window); arch.position.set(x, 11.8, sz * (HD - 0.02)); arch.rotation.y = sz > 0 ? Math.PI : 0; level.add(arch);
  const frame = new THREE.Mesh(new THREE.TorusGeometry(1.95, 0.14, 8, 24, Math.PI), MAT.gold); frame.position.set(x, 11.8, sz * (HD - 0.1)); level.add(frame);
  box(0.28, 5.2, 0.2, x - 1.95, 9.2, sz * (HD - 0.1), MAT.gold, { solid: false, shadow: false }); box(0.28, 5.2, 0.2, x + 1.95, 9.2, sz * (HD - 0.1), MAT.gold, { solid: false, shadow: false }); box(4.2, 0.28, 0.2, x, 6.6, sz * (HD - 0.1), MAT.gold, { solid: false, shadow: false });
  box(0.12, 5.2, 0.05, x, 9.2, sz * (HD - 0.06), MAT.dark, { solid: false, shadow: false }); box(3.6, 0.12, 0.05, x, 9.2, sz * (HD - 0.06), MAT.dark, { solid: false, shadow: false });
  const shaft = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 16), new THREE.MeshBasicMaterial({ map: shaftTex, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  shaft.position.set(x, 6.5, sz * (HD - 5)); shaft.rotation.x = sz * 0.55; level.add(shaft);
  if (i % 2) {
    box(3.2, 2.4, 0.12, x + 6, 3.4, sz * (HD - 0.26), new THREE.MeshStandardMaterial({ map: TEX.painting(i + (sz > 0 ? 3 : 0)), roughness: 0.7 }), { solid: false, shadow: false });
    box(3.6, 2.8, 0.1, x + 6, 3.4, sz * (HD - 0.3), MAT.gold, { solid: false, shadow: false });
    if (sz > 0) { const sc = new THREE.PointLight(0xffb070, 30, 14, 2); sc.position.set(x + 6, 5.4, sz * (HD - 1.2)); level.add(sc); }
    box(0.4, 0.5, 0.3, x + 6, 5.2, sz * (HD - 0.3), MAT.gold, { solid: false, shadow: false });
  }
}
for (const sz of [-1, 1]) {
  box(2 * HW, 0.6, BW, 0, BY - 0.3, sz * (HD - BW / 2), MAT.marble);
  box(2 * HW, 0.25, 0.5, 0, BY - 0.72, sz * (HD - BW), MAT.gold, { solid: false, shadow: false });
  const zr = sz * (HD - BW);
  box(2 * HW, 0.14, 0.34, 0, BY + 1.05, zr, MAT.marble); box(2 * HW, 0.12, 0.3, 0, BY + 0.12, zr, MAT.marble, { solid: false, shadow: false });
  for (let x = -HW + 0.75; x < HW; x += 1.5) cyl(0.09, 0.9, x, BY + 0.55, zr, MAT.marble, 8, false);
}
for (const sx of [-1, 1]) {
  for (let i = 0; i < 10; i++) { const h = 0.5 * (i + 1); box(8, h, 1.0, sx * (HW - 4), h / 2, -HD + BW + 0.5 + i, MAT.marble); box(8, h, 1.0, sx * (HW - 4), h / 2, HD - BW - 0.5 - i, MAT.marble); }
  box(8, 0.6, 2 * HD - 2 * BW - 20, sx * (HW - 4), BY - 0.3, 0, MAT.marble);
  const xr = sx * (HW - 8);
  box(0.34, 0.14, 2 * HD - 2 * BW - 20, xr, BY + 1.05, 0, MAT.marble); for (let z = -3; z <= 3; z += 1.5) cyl(0.09, 0.9, xr, BY + 0.55, z, MAT.marble, 8, false);
  for (let i = 0; i < 10; i++) for (const sz of [-1, 1]) { const h = 0.5 * (i + 1); cyl(0.07, 0.9, xr, h + 0.45, sz * (HD - BW - 0.5 - i), MAT.marble, 6, false); }
  box(4.4, 6.5, 0.3, sx * (HW - 0.4), 3.25, 0, MAT.wood, { solid: false }); box(4.8, 0.4, 0.4, sx * (HW - 0.4), 6.7, 0, MAT.gold, { solid: false, shadow: false }); box(0.15, 6.3, 0.35, sx * (HW - 0.4), 3.25, 0, MAT.gold, { solid: false, shadow: false });
  for (const sz of [-1, 1]) { cyl(0.6, 1.2, sx * (HW - 2.2), 0.6, sz * 6, MAT.marble, 16); const vase = new THREE.Mesh(new THREE.SphereGeometry(0.55, 16, 12), MAT.gold); vase.position.set(sx * (HW - 2.2), 1.7, sz * 6); vase.scale.y = 1.4; vase.castShadow = true; level.add(vase); }
}
for (let i = 0; i < 4; i++) for (const sz of [-1, 1]) {
  const x = -18 + i * 12, z = sz * (HD - BW - 0.95);
  cyl(0.85, BY - 0.6, x, (BY - 0.6) / 2, z, MAT.marble, 22); box(2.3, 0.35, 2.3, x, BY - 0.45, z, MAT.gold); box(2.1, 0.3, 2.1, x, 0.15, z, MAT.gold, { solid: false });
}
box(14, 1.2, 9, 0, 0.6, 0, MAT.marble); box(14.4, 0.15, 9.4, 0, 1.25, 0, MAT.gold, { solid: false, shadow: false });
for (const [x, z, s] of [[-4, 1.5, 2.2], [4.5, -1.5, 2.2]]) { box(s, s * 0.8, s, x, 1.2 + s * 0.4, z, MAT.wood); box(s + 0.1, 0.16, s + 0.1, x, 1.2 + s * 0.8 - 0.3, z, MAT.gold, { solid: false, shadow: false }); }
for (const [x, z, s] of [[-22, 6, 2.2], [22, -6, 2.2], [-12, -9, 1.6], [12, 9, 1.6], [-24, -3, 3.2], [24, 3, 3.2], [0, -12, 1.4], [0, 12, 1.4]]) { box(s, s * 0.8, s, x, s * 0.4, z, MAT.wood); box(s + 0.1, 0.14, s + 0.1, x, s * 0.5, z, MAT.gold, { solid: false, shadow: false }); }
const flameTex = TEX.flame(), flames = [];
for (const x of [-16, 0, 16]) {
  const g = new THREE.Group(); g.position.set(x, 10.8, 0);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.12, 8, 28), MAT.gold); ring.rotation.x = Math.PI / 2; g.add(ring);
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.09, 8, 20), MAT.gold); ring2.rotation.x = Math.PI / 2; ring2.position.y = 0.7; g.add(ring2);
  for (let k = 0; k < 10; k++) { const a = k / 10 * 6.283, r = k % 2 ? 1.7 : 0.9, y = k % 2 ? 0.1 : 0.8; const c = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.45, 6), MAT.glow); c.position.set(Math.cos(a) * r, y + 0.25, Math.sin(a) * r); g.add(c); const f = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })); f.position.set(Math.cos(a) * r, y + 0.7, Math.sin(a) * r); f.scale.set(0.5, 0.8, 1); g.add(f); flames.push(f); }
  const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.7, 6), MAT.gold); chain.position.y = 2.2; g.add(chain);
  const l = new THREE.PointLight(0xffc98a, 380, 80, 2); l.position.y = -0.2; g.add(l);
  level.add(g);
}
const dustGeo = new THREE.BufferGeometry(), dustN = 220, dustPos = new Float32Array(dustN * 3), dustSeed = new Float32Array(dustN);
for (let i = 0; i < dustN; i++) { dustPos[i * 3] = rand(-HW, HW); dustPos[i * 3 + 1] = rand(0.5, 13); dustPos[i * 3 + 2] = rand(-HD, HD); dustSeed[i] = rand(0, 6.28); }
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
const softTex = TEX.soft();
scene.add(new THREE.Points(dustGeo, new THREE.PointsMaterial({ size: 0.09, map: softTex, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffe6c0 })));
const SPAWNS = [[-26, 0, -16], [26, 0, 16], [-26, 0, 16], [26, 0, -16], [0, 1.2, 0], [-14, BY, -17], [14, BY, 17], [-25, BY, 0], [25, BY, 0], [12, 0, -12], [-12, 0, 12]];

// ------------------------------------------------------------------ characters (KayKit Adventurers, CC0)
const CHAR_FILES = { Knight: 'assets/kaykit/Knight.glb', Barbarian: 'assets/kaykit/Barbarian.glb', Rogue: 'assets/kaykit/Rogue.glb' };
const CHARS = {};
const HIDE_PARTS = ['Badge_Shield', 'Rectangle_Shield', 'Round_Shield', 'Spike_Shield', '2H_Sword', '1H_Sword_Offhand', '2H_Axe', '1H_Axe', '1H_Axe_Offhand', 'Barbarian_Round_Shield', 'Dagger', 'Dagger_Offhand', '1H_Crossbow', '2H_Crossbow', 'Knight_Cape', 'Mug', 'Spellbook', 'Staff', 'Wand', 'Throwable'];
async function loadCharacters() {
  if (BOXES) return;
  const loader = new GLTFLoader(); const names = Object.keys(CHAR_FILES); let done = 0;
  await Promise.all(names.map(async (n) => {
    try {
      const g = await loader.loadAsync(CHAR_FILES[n]);
      const bbox = new THREE.Box3().setFromObject(g.scene); const height = bbox.max.y - bbox.min.y;
      CHARS[n] = { scene: g.scene, clips: g.animations, scale: 1.85 / height, lift: -bbox.min.y };
    } catch (e) { console.warn('character failed to load', n, e); }
    done++; $('load-bar').style.width = `${Math.round(done / names.length * 100)}%`;
  }));
}
const NAMES = ['Breaker', 'Vanta', 'Rook', 'Sable', 'Nix', 'Juno', 'Pike', 'Mara', 'Onyx', 'Tess', 'Kael', 'Lumen', 'Dusk', 'Aria', 'Cinder', 'Wren', 'Vex', 'Ilo', 'Ash', 'Tarn'];
const TEAM_COLS = [0x3b7ddd, 0x8b5cf6, 0x22a06b, 0x0ea5b7, 0xd946a8, 0xd9a520, 0x4f7cff, 0xa855f7];
const OUTLINE = new THREE.MeshBasicMaterial({ color: 0x0a0810, side: THREE.BackSide });
function labelSprite(text, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64; const g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })); sp.scale.set(2.2, 0.55, 1);
  sp.userData.draw = (hp) => { g.clearRect(0, 0, 256, 64); g.font = '700 26px system-ui, sans-serif'; g.textAlign = 'center'; g.lineWidth = 5; g.strokeStyle = '#000c'; g.strokeText(text, 128, 28); g.fillStyle = color; g.fillText(text, 128, 28); g.fillStyle = '#000a'; g.fillRect(48, 40, 160, 10); g.fillStyle = hp > 50 ? '#3fb950' : hp > 25 ? '#f97316' : '#ef4444'; g.fillRect(48, 40, 160 * clamp(hp / 100, 0, 1), 10); tex.needsUpdate = true; };
  sp.userData.draw(100); return sp;
}
function gunModel(trim) {
  const g = new THREE.Group(); const mk = (geo, m, x, y, z) => { const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z); mesh.castShadow = true; g.add(mesh); return mesh; };
  mk(new THREE.BoxGeometry(0.1, 0.16, 0.42), MAT.dark, 0, 0, 0.16); mk(new THREE.BoxGeometry(0.07, 0.07, 0.4), MAT.steel, 0, 0.05, 0.42); mk(new THREE.BoxGeometry(0.05, 0.05, 0.08), trim, 0, 0.05, 0.66);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.05, 0.72); g.add(muzzle);
  const flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: TEX.muzzle(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })); flash.scale.set(0.9, 0.9, 1); flash.position.copy(muzzle.position); flash.visible = false; g.add(flash);
  g.userData = { muzzle, flash }; return g;
}
function humanoid(col, accent) {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xe9c49f, roughness: 0.75 });
  const cloth = new THREE.MeshStandardMaterial({ color: col, roughness: 0.55, metalness: 0.1 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1720, roughness: 0.7 });
  const hairM = new THREE.MeshStandardMaterial({ color: 0x1d1418, roughness: 0.6 });
  const trim = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.45, roughness: 0.4, metalness: 0.3 });
  const parts = [];
  const mk = (geo, m, x, y, z, parent = g, outline = true) => { const mesh = new THREE.Mesh(geo, m); mesh.position.set(x, y, z); mesh.castShadow = true; parent.add(mesh); parts.push(mesh); if (outline) { const o = new THREE.Mesh(geo, OUTLINE); o.scale.setScalar(1.07); mesh.add(o); } return mesh; };
  const B = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const hips = new THREE.Group(); hips.position.y = 0.98; g.add(hips);
  mk(B(0.5, 0.26, 0.32), dark, 0, 0.02, 0, hips);
  const torso = new THREE.Group(); torso.position.y = 0.14; hips.add(torso);
  mk(B(0.56, 0.6, 0.34), cloth, 0, 0.32, 0, torso); mk(B(0.66, 0.18, 0.38), cloth, 0, 0.6, 0, torso); mk(B(0.7, 0.1, 0.4), trim, 0, 0.05, 0, torso);
  mk(B(0.2, 0.12, 0.3), trim, -0.4, 0.66, 0, torso); mk(B(0.2, 0.12, 0.3), trim, 0.4, 0.66, 0, torso);
  const coatL = mk(B(0.26, 0.5, 0.2), cloth, -0.16, -0.24, -0.1, torso); const coatR = mk(B(0.26, 0.5, 0.2), cloth, 0.16, -0.24, -0.1, torso);
  mk(B(0.14, 0.12, 0.14), skin, 0, 0.75, 0, torso);
  const head = new THREE.Group(); head.position.set(0, 0.82, 0); torso.add(head);
  mk(B(0.38, 0.4, 0.38), skin, 0, 0.2, 0, head); mk(B(0.42, 0.18, 0.42), hairM, 0, 0.36, -0.02, head); mk(B(0.42, 0.14, 0.1), hairM, 0, 0.3, 0.18, head); mk(B(0.1, 0.24, 0.42), hairM, -0.18, 0.2, -0.02, head); mk(B(0.1, 0.24, 0.42), hairM, 0.18, 0.2, -0.02, head);
  mk(B(0.07, 0.05, 0.02), dark, -0.09, 0.2, 0.2, head, false); mk(B(0.07, 0.05, 0.02), dark, 0.09, 0.2, 0.2, head, false);
  const upperArm = (sx) => { const s = new THREE.Group(); s.position.set(sx * 0.42, 0.62, 0); torso.add(s); mk(B(0.18, 0.36, 0.18), cloth, 0, -0.18, 0, s); const e = new THREE.Group(); e.position.y = -0.36; s.add(e); mk(B(0.16, 0.34, 0.16), cloth, 0, -0.17, 0, e); mk(B(0.15, 0.14, 0.15), dark, 0, -0.4, 0, e); return { s, e }; };
  const armL = upperArm(-1), armR = upperArm(1);
  const leg = (sx) => { const t = new THREE.Group(); t.position.set(sx * 0.17, -0.02, 0); hips.add(t); mk(B(0.24, 0.46, 0.26), dark, 0, -0.23, 0, t); const k = new THREE.Group(); k.position.y = -0.46; t.add(k); mk(B(0.22, 0.42, 0.24), dark, 0, -0.21, 0, k); mk(B(0.24, 0.14, 0.32), trim, 0, -0.45, 0.03, k); return { t, k }; };
  const legL = leg(-1), legR = leg(1);
  const sword = new THREE.Group(); sword.position.set(0, -0.44, 0.06); armR.e.add(sword);
  mk(B(0.06, 0.08, 0.3), trim, 0, 0, 0.02, sword, false); mk(B(0.22, 0.06, 0.06), MAT.gold, 0, 0, 0.16, sword, false); mk(B(0.04, 0.1, 1.25), MAT.steel, 0, 0, 0.8, sword, false);
  const tip = new THREE.Object3D(); tip.position.set(0, 0, 1.42); sword.add(tip); const hilt = new THREE.Object3D(); hilt.position.set(0, 0, 0.16); sword.add(hilt);
  const gun = gunModel(trim); gun.position.set(0, -0.44, 0.08); armR.e.add(gun);
  g.userData = { hips, torso, head, armL, armR, legL, legR, sword, gun, tip, hilt, coatL, coatR, parts, cloth, trim };
  return g;
}

// ------------------------------------------------------------------ effects
const FX = { sparks: [], fades: [], texts: [], decals: [] };
const sparkGeo = new THREE.SphereGeometry(0.05, 5, 5);
const sparkMats = [0xfacc15, 0xf97316, 0xffffff, 0xec4899].map((c) => new THREE.MeshBasicMaterial({ color: c }));
function sparks(p, n = 10, spread = 6, col = null) {
  for (let i = 0; i < n; i++) { const m = new THREE.Mesh(sparkGeo, col ? new THREE.MeshBasicMaterial({ color: col }) : pick(sparkMats)); m.position.copy(p); scene.add(m); FX.sparks.push({ m, v: V3(rand(-1, 1), rand(0.2, 1.4), rand(-1, 1)).normalize().multiplyScalar(rand(2, spread)), t: rand(0.25, 0.55) }); }
}
function fadeOut(obj, t, grow = 0) { scene.add(obj); FX.fades.push({ obj, t, t0: t, grow }); }
function tracer(a, b, col = 0xffd27a) { const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.9 })); fadeOut(l, 0.08); }
function flashLight(p, col = 0xffc070, power = 16) { const l = new THREE.PointLight(col, power, 8, 2); l.position.copy(p); fadeOut(l, 0.07); }
function puff(p, size = 1.2, col = 0xd8ccb8) { const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: softTex, color: col, transparent: true, opacity: 0.55, depthWrite: false })); s.userData.op = 0.55; s.position.copy(p); s.scale.set(size, size * 0.6, 1); fadeOut(s, 0.45, 2.2); }
function decal(p, n) { const d = new THREE.Mesh(new THREE.CircleGeometry(0.09, 10), new THREE.MeshBasicMaterial({ color: 0x0a0806, transparent: true, opacity: 0.85, depthWrite: false })); d.position.copy(p).addScaledVector(n, 0.01); d.lookAt(p.clone().add(n)); scene.add(d); FX.decals.push(d); if (FX.decals.length > 60) scene.remove(FX.decals.shift()); }
function hitText(p, text, col = '#facc15') {
  const c = document.createElement('canvas'); c.width = 128; c.height = 64; const g = c.getContext('2d'); g.font = '900 40px system-ui, sans-serif'; g.textAlign = 'center'; g.lineWidth = 6; g.strokeStyle = '#000'; g.strokeText(text, 64, 46); g.fillStyle = col; g.fillText(text, 64, 46);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })); s.scale.set(1.0, 0.5, 1); s.position.copy(p).add(V3(rand(-0.3, 0.3), 0.4, 0)); scene.add(s); FX.texts.push({ s, t: 0.7 });
}
function updateFX(dt) {
  for (let i = FX.sparks.length - 1; i >= 0; i--) { const s = FX.sparks[i]; s.t -= dt; s.v.y -= 14 * dt; s.m.position.addScaledVector(s.v, dt); s.m.scale.setScalar(Math.max(0.05, s.t * 2)); if (s.t <= 0) { scene.remove(s.m); FX.sparks.splice(i, 1); } }
  for (let i = FX.fades.length - 1; i >= 0; i--) { const f = FX.fades[i]; f.t -= dt; const k = Math.max(0, f.t / f.t0); if (f.obj.material) f.obj.material.opacity = k * (f.obj.userData.op ?? 0.9); if (f.obj.intensity !== undefined) f.obj.intensity *= 0.6; if (f.grow) { f.obj.scale.x += f.grow * dt; f.obj.scale.y += f.grow * dt * 0.6; } if (f.t <= 0) { scene.remove(f.obj); if (f.obj.geometry) f.obj.geometry.dispose(); FX.fades.splice(i, 1); } }
  for (let i = FX.texts.length - 1; i >= 0; i--) { const s = FX.texts[i]; s.t -= dt; s.s.position.y += dt * 1.2; s.s.material.opacity = Math.min(1, s.t * 3); if (s.t <= 0) { scene.remove(s.s); FX.texts.splice(i, 1); } }
}

// ------------------------------------------------------------------ fighters
const HALF = V3(0.4, 0.9, 0.4);
const GRAV = -26, SPEED = 8.2, JUMP = 9.6, DASH = 19, STEP_UP = 0.55;
const PLAYER_HP = 150, SPAWN_GUARD = 2.0, REGEN_DELAY = 4.0, REGEN_RATE = 12;
const fighters = [];
const ray = new THREE.Raycaster();
const _v2 = V3(), _v3 = V3();
let hitStop = 0, recoil = 0, camShake = 0, perfTime = 0;
const SLASHES = ['1H_Melee_Attack_Slice_Diagonal', '1H_Melee_Attack_Chop', '1H_Melee_Attack_Slice_Horizontal'];

class Fighter {
  constructor({ name, color, accent, kind, isPlayer = false }) {
    this.name = name; this.color = color; this.accent = accent; this.isPlayer = isPlayer;
    this.pos = V3(); this.vel = V3(); this.yaw = 0; this.pitch = 0;
    this.hp = 100; this.stam = 100; this.grounded = false; this.jumps = 0; this.wall = null; this.wallT = 0; this.wallCd = 0; this.airT = 0;
    this.dashT = 0; this.dashCd = 0; this.weapon = 'gun'; this.ammo = 12; this.reloadT = 0; this.attackT = 0; this.slashHit = false; this.fireCd = 0;
    this.dead = false; this.respawnT = 0; this.kills = 0; this.deaths = 0; this.anim = 0; this.stepT = 0; this.hurtT = 0; this.lastHitBy = null; this.lean = 0; this.roll = 0; this.maxHp = isPlayer ? PLAYER_HP : 100; this.guard = 0; this.sinceHit = 99;
    this.brain = { target: null, wander: V3(), wanderT: 0, losT: 0, los: false, burst: 0, burstT: 0, strafe: 1, blockedT: 0, dashCd: rand(2, 5), dodgeT: 0 };
    this.buildBody(kind); scene.add(this.mesh);
    this.label = labelSprite(name, '#' + new THREE.Color(accent).getHexString()); this.label.position.y = 2.3; this.mesh.add(this.label); if (isPlayer) this.label.visible = false;
    this.buildTrail(); this.spawn();
  }
  buildBody(kind) {
    const src = CHARS[kind];
    if (!src) { this.mesh = new THREE.Group(); const body = humanoid(this.color, this.accent); body.rotation.y = Math.PI; this.mesh.add(body); this.mesh.userData = body.userData; this.rig = null; return; }
    const model = skeletonClone(src.scene); model.scale.setScalar(src.scale); model.position.y = src.lift * src.scale; model.rotation.y = Math.PI;   // glTF fronts face +Z, our forward is -Z
    const bones = {}, mats = [];
    model.traverse((o) => {
      bones[o.name] = o;
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; o.frustumCulled = false; o.material = o.material.clone(); if (!this.isPlayer) o.material.color.lerp(new THREE.Color(this.color), 0.28); mats.push(o.material); }
    });
    for (const n of HIDE_PARTS) if (bones[n]) bones[n].visible = false;
    const sword = bones['1H_Sword'] || null;
    const hand = bones['handslot.r'] || bones['hand.r'] || model;
    // blade axis from the sword mesh bounds: the longest side is the blade
    let tip = null, hilt = null, bladeQ = new THREE.Quaternion();
    if (sword) {
      const mesh = sword.isMesh ? sword : sword.children.find((c) => c.isMesh);
      if (mesh && mesh.geometry) {
        mesh.geometry.computeBoundingBox(); const bb = mesh.geometry.boundingBox, size = bb.max.clone().sub(bb.min);
        const axis = size.x > size.y && size.x > size.z ? 'x' : size.y > size.z ? 'y' : 'z';
        const dir = V3(); dir[axis] = 1; const lo = bb.min[axis], hi = bb.max[axis]; const mid = bb.min.clone().add(bb.max).multiplyScalar(0.5);
        // the hilt end is the one nearer the hand (the sword node origin)
        const flip = Math.abs(lo) < Math.abs(hi) ? 1 : -1;
        tip = new THREE.Object3D(); hilt = new THREE.Object3D();
        const t = mid.clone(); t[axis] = flip > 0 ? hi : lo; const h = mid.clone(); h[axis] = flip > 0 ? lo : hi;
        tip.position.copy(t); hilt.position.copy(h); mesh.add(tip); mesh.add(hilt);
        bladeQ.setFromUnitVectors(V3(0, 0, 1), dir.multiplyScalar(flip));
      }
    }
    const trim = new THREE.MeshStandardMaterial({ color: this.accent, emissive: this.accent, emissiveIntensity: 0.5, roughness: 0.4 });
    const gun = gunModel(trim); if (sword) { gun.position.copy(sword.position); gun.quaternion.copy(sword.quaternion).multiply(bladeQ); gun.scale.setScalar(1 / src.scale * 0.9); } hand.add(gun);
    const mixer = new THREE.AnimationMixer(model); const actions = {};
    for (const c of src.clips) actions[c.name] = mixer.clipAction(c);
    this.mesh = new THREE.Group(); this.mesh.add(model);
    this.rig = { model, bones, mats, sword, gun, tip, hilt, mixer, actions, cur: null, shot: null, spine: bones['spine'] || bones['chest'], head: bones['head'] };
  }
  // animation helpers (rigged fighters only)
  base(name, fade = 0.15, speed = 1) {
    const r = this.rig; if (!r) return; const a = r.actions[name]; if (!a) return;
    if (r.cur === name) { a.timeScale = speed; return; }
    a.reset(); a.setLoop(THREE.LoopRepeat, Infinity); a.timeScale = speed; a.clampWhenFinished = false; a.enabled = true; a.setEffectiveWeight(1);
    if (r.cur && r.actions[r.cur]) r.actions[r.cur].crossFadeTo(a, fade, false); a.play(); r.cur = name;
  }
  once(name, dur, fade = 0.08) {
    const r = this.rig; if (!r) return; const a = r.actions[name]; if (!a) return;
    a.reset(); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.timeScale = dur ? a.getClip().duration / dur : 1; a.enabled = true; a.setEffectiveWeight(1);
    if (r.cur && r.actions[r.cur] && r.cur !== name) r.actions[r.cur].crossFadeTo(a, fade, false); a.play(); r.cur = name; r.shot = { name, until: perfTime + (dur || a.getClip().duration) };
  }
  buildTrail() {
    const N = 12; const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3)); geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3));
    const idx = []; for (let i = 0; i < N - 1; i++) { const a = i * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, b, c, b, d, c); } geo.setIndex(idx);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending })); m.visible = false; m.frustumCulled = false; scene.add(m);
    this.trail = { pts: [], mesh: m, N, col: new THREE.Color(this.accent).lerp(new THREE.Color(0xffffff), 0.5) };
  }
  setOpacity(k) { const mats = this.rig ? this.rig.mats : this.mesh.userData.parts.map((p) => p.material); for (const m of mats) { m.transparent = k < 1; m.opacity = k; } }
  spawn() {
    const s = pick(SPAWNS); this.pos.set(s[0] + rand(-1, 1), s[1] + 0.05, s[2] + rand(-1, 1)); this.vel.set(0, 0, 0);
    this.hp = this.maxHp; this.stam = 100; this.dead = false; this.ammo = 12; this.reloadT = 0; this.attackT = 0; this.mesh.visible = true; this.mesh.rotation.set(0, 0, 0); this.setOpacity(1); this.guard = this.isPlayer ? SPAWN_GUARD : 0.8; this.sinceHit = 99;
    this.yaw = Math.atan2(-this.pos.x, -this.pos.z); this.label.userData.draw(100); puff(this.pos.clone().add(V3(0, 0.3, 0)), 2, 0xffffff);
    if (this.rig) { this.rig.shot = null; this.rig.cur = null; this.base('Idle', 0); }
  }
  aabb(pos = this.pos) { return { min: V3(pos.x - HALF.x, pos.y, pos.z - HALF.z), max: V3(pos.x + HALF.x, pos.y + HALF.y * 2, pos.z + HALF.z) }; }
  eye() { return V3(this.pos.x, this.pos.y + 1.6, this.pos.z); }
  forward() { return V3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }
  aim() { return V3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch)).normalize(); }
  near() { return player && this.pos.distanceTo(player.pos) < 20; }

  step(dt, input) {
    if (this.dead) {
      this.respawnT -= dt; const k = clamp(this.respawnT / 2.2, 0, 1); this.setOpacity(k); this.trail.mesh.visible = false;
      if (this.rig) this.rig.mixer.update(dt); else this.mesh.rotation.x = Math.min(Math.PI / 2, this.mesh.rotation.x + dt * 5);
      if (this.respawnT <= 0) this.spawn(); return;
    }
    this.dashCd = Math.max(0, this.dashCd - dt); this.wallCd = Math.max(0, this.wallCd - dt); this.fireCd = Math.max(0, this.fireCd - dt); this.hurtT = Math.max(0, this.hurtT - dt); this.guard = Math.max(0, this.guard - dt); this.sinceHit += dt;
    this.stam = Math.min(100, this.stam + dt * 22);
    if (this.isPlayer && this.sinceHit > REGEN_DELAY && this.hp < this.maxHp) this.hp = Math.min(this.maxHp, this.hp + REGEN_RATE * dt);
    if (this.reloadT > 0) { this.reloadT -= dt; if (this.reloadT <= 0) { this.ammo = 12; this.reloadT = 0; } }
    if (input.swap) this.weapon = this.weapon === 'gun' ? 'sword' : 'gun';
    if (input.reload && this.ammo < 12 && this.reloadT <= 0) { this.reloadT = 1.4; if (this.isPlayer) SFX.reload(); this.once('1H_Ranged_Reload', 1.4); }
    const mx = input.move.x, mz = input.move.z, moving = (mx * mx + mz * mz) > 0.01;
    const accel = this.grounded ? 60 : 18;
    if (this.dashT > 0) this.dashT -= dt;
    else { this.vel.x = lerp(this.vel.x, mx * SPEED, clamp(accel * dt / SPEED, 0, 1)); this.vel.z = lerp(this.vel.z, mz * SPEED, clamp(accel * dt / SPEED, 0, 1)); if (!moving && this.grounded) { this.vel.x *= Math.max(0, 1 - 14 * dt); this.vel.z *= Math.max(0, 1 - 14 * dt); } }
    if (input.dash && this.dashCd <= 0 && this.stam >= 25) {
      const d = moving ? _v2.set(mx, 0, mz).normalize() : this.forward(); this.vel.x = d.x * DASH; this.vel.z = d.z * DASH; if (!this.grounded) this.vel.y = Math.max(this.vel.y, 1.5);
      this.dashT = 0.16; this.dashCd = 0.85; this.stam -= 25; if (this.isPlayer || this.near()) SFX.dash(); this.afterimage(); puff(this.pos.clone().add(V3(0, 0.2, 0)), 1.6); this.once('Dodge_Forward', 0.34);
    }
    const onWall = !this.grounded && this.wall && this.wallCd <= 0 && moving;
    if (onWall) { this.wallT += dt; if (this.wallT < 0.9) { const n = this.wall, t = _v3.set(-n.z, 0, n.x); if (t.x * mx + t.z * mz < 0) t.negate(); const speed = Math.max(SPEED, Math.hypot(this.vel.x, this.vel.z)); this.vel.x = t.x * speed; this.vel.z = t.z * speed; this.vel.y = Math.max(this.vel.y, 0) * 0.5 + 1.2; this.jumps = 1; if (Math.random() < dt * 8) sparks(this.pos.clone().add(V3(-n.x * 0.45, 0.2, -n.z * 0.45)), 1, 2, 0xffffff); } }
    else this.wallT = 0;
    if (input.jump) {
      if (this.grounded) { this.vel.y = JUMP; this.jumps = 1; if (this.isPlayer || this.near()) SFX.jump(); puff(this.pos.clone().add(V3(0, 0.15, 0)), 1.2); this.once('Jump_Start', 0.22); }
      else if (this.wall && this.wallCd <= 0) { const n = this.wall; this.vel.x = n.x * 9 + this.vel.x * 0.4; this.vel.z = n.z * 9 + this.vel.z * 0.4; this.vel.y = 9.5; this.jumps = 1; this.wallCd = 0.35; this.wallT = 0; if (this.isPlayer || this.near()) { SFX.jump(); SFX.wall(); } sparks(this.pos.clone().add(V3(-n.x * 0.5, 1, -n.z * 0.5)), 8, 4, 0xffffff); this.once('Jump_Start', 0.22); }
      else if (this.jumps < 2) { this.vel.y = JUMP * 0.92; this.jumps = 2; if (this.isPlayer || this.near()) SFX.jump(); const ring = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.6, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false })); ring.userData.op = 0.7; ring.position.copy(this.pos); ring.position.y += 0.1; ring.rotation.x = -Math.PI / 2; fadeOut(ring, 0.3, 4); this.once('Jump_Full_Short', 0.5); }
    }
    this.vel.y += GRAV * dt * (onWall && this.wallT < 0.9 ? 0.25 : 1); this.vel.y = Math.max(this.vel.y, -40);
    this.wall = null;
    this.moveAxis(0, this.vel.x * dt); this.moveAxis(2, this.vel.z * dt);
    const wasGrounded = this.grounded, fallV = this.vel.y; this.grounded = false;
    this.moveAxis(1, this.vel.y * dt);
    if (this.pos.y <= 0) { this.pos.y = 0; if (this.vel.y < 0) { this.vel.y = 0; this.grounded = true; } }
    if (this.grounded) { this.jumps = 0; this.airT = 0; if (!wasGrounded) { if (this.isPlayer || this.near()) SFX.land(); if (fallV < -9) { puff(this.pos.clone().add(V3(0, 0.15, 0)), 1.8); this.once('Jump_Land', 0.25); } } } else this.airT += dt;
    if (this.attackT > 0) { this.attackT -= dt; if (this.weapon === 'sword' && !this.slashHit && this.attackT < 0.26) { this.slashHit = true; this.slashDamage(); } }
    if (input.alt) this.weapon = this.weapon === 'gun' ? 'sword' : 'gun';
    if ((input.attack || input.alt) && this.attackT <= 0) {
      if (this.weapon === 'sword') { this.attackT = 0.42; this.slashHit = false; this.trail.pts.length = 0; if (this.isPlayer || this.near()) SFX.slash(); this.once(pick(SLASHES), 0.46, 0.05); }
      else if (this.fireCd <= 0 && this.reloadT <= 0) { if (this.ammo > 0) { this.shoot(input.aimDir); this.ammo--; this.fireCd = 0.15; this.attackT = 0.12; this.once('1H_Ranged_Shoot', 0.3, 0.04); if (this.ammo === 0) { this.reloadT = 1.4; if (this.isPlayer) SFX.reload(); this.once('1H_Ranged_Reload', 1.4); } } else { this.reloadT = 1.4; this.once('1H_Ranged_Reload', 1.4); } }
    }
    if (this.grounded && moving && !this.dashT) { this.stepT -= dt * Math.hypot(this.vel.x, this.vel.z); if (this.stepT <= 0) { this.stepT = 2.6; if (this.isPlayer) SFX.step(); } }
    this.mesh.position.copy(this.pos); this.mesh.rotation.set(0, this.yaw, 0);
    if (this.rig) this.poseRig(dt, moving, mx, mz); else this.poseBoxes(dt, moving);
  }
  moveAxis(axis, d) {
    if (Math.abs(d) < 1e-6) return;
    const key = axis === 0 ? 'x' : axis === 1 ? 'y' : 'z'; this.pos[key] += d; const bb = this.aabb();
    for (const c of colliders) {
      if (bb.max.x <= c.min.x || bb.min.x >= c.max.x || bb.max.y <= c.min.y || bb.min.y >= c.max.y || bb.max.z <= c.min.z || bb.min.z >= c.max.z) continue;
      if (axis === 1) { if (d < 0) { this.pos.y = c.max.y; this.vel.y = 0; this.grounded = true; } else { this.pos.y = c.min.y - HALF.y * 2; this.vel.y = 0; } }
      else {
        const lift = c.max.y - this.pos.y;
        if (lift > 0 && lift <= STEP_UP) { const test = this.aabb(_v2.copy(this.pos).setY(c.max.y + 0.01)); let free = true; for (const o of colliders) { if (test.max.x <= o.min.x || test.min.x >= o.max.x || test.max.y <= o.min.y || test.min.y >= o.max.y || test.max.z <= o.min.z || test.min.z >= o.max.z) continue; free = false; break; } if (free) { this.pos.y = c.max.y + 0.01; continue; } }
        if (axis === 0) { this.pos.x = d > 0 ? c.min.x - HALF.x - 0.001 : c.max.x + HALF.x + 0.001; this.wall = V3(d > 0 ? -1 : 1, 0, 0); this.vel.x = 0; }
        else { this.pos.z = d > 0 ? c.min.z - HALF.z - 0.001 : c.max.z + HALF.z + 0.001; this.wall = V3(0, 0, d > 0 ? -1 : 1); this.vel.z = 0; }
      }
      break;
    }
    this.pos.x = clamp(this.pos.x, -HW + HALF.x, HW - HALF.x); this.pos.z = clamp(this.pos.z, -HD + HALF.z, HD - HALF.z);
  }
  poseRig(dt, moving, mx, mz) {
    const r = this.rig, sp = Math.hypot(this.vel.x, this.vel.z), run = moving && this.grounded;
    const busy = r.shot && perfTime < r.shot.until;
    if (!busy) {
      if (!this.grounded) this.base(this.wall ? 'Running_A' : 'Jump_Idle', 0.12, this.wall ? 1.4 : 1);
      else if (run) {
        const f = this.forward(), fwd = f.x * this.vel.x + f.z * this.vel.z, side = -f.z * this.vel.x + f.x * this.vel.z;
        const name = Math.abs(side) > Math.abs(fwd) * 1.2 ? (side > 0 ? 'Running_Strafe_Right' : 'Running_Strafe_Left') : (fwd < -1 ? 'Walking_Backwards' : 'Running_A');
        this.base(name, 0.12, clamp(sp / SPEED, 0.7, 1.5));
      } else this.base(this.weapon === 'gun' ? '1H_Ranged_Aiming' : 'Idle', 0.2);
    }
    r.mixer.update(dt);
    // lean into dashes, roll on walls, aim with the spine
    const targetRoll = this.wall && !this.grounded ? (this.wall.x * Math.cos(this.yaw) + this.wall.z * Math.sin(this.yaw)) * 0.4 : 0; this.roll = lerp(this.roll, targetRoll, 10 * dt);
    r.model.rotation.set(lerp(r.model.rotation.x, this.dashT > 0 ? -0.35 : 0, 10 * dt), Math.PI, -this.roll);
    if (r.spine && this.weapon === 'gun' && !busy) r.spine.rotation.x -= this.pitch * 0.55;
    if (r.head) r.head.rotation.x -= this.pitch * 0.3;
    if (r.sword) r.sword.visible = this.weapon === 'sword'; r.gun.visible = this.weapon === 'gun'; r.gun.userData.flash.visible = this.weapon === 'gun' && this.attackT > 0.06;
    const flash = this.hurtT > 0 ? 0.55 : 0; for (const m of r.mats) { m.emissive.setHex(0xff2222); m.emissiveIntensity = flash; }
    this.trailUpdate(r.tip, r.hilt);
  }
  poseBoxes(dt, moving) {
    const u = this.mesh.userData, sp = Math.hypot(this.vel.x, this.vel.z), run = moving && this.grounded;
    this.anim += dt * (run ? 8 + sp * 0.5 : 2.2); const s = Math.sin(this.anim), c = Math.cos(this.anim);
    if (run) { u.legL.t.rotation.x = s * 0.85; u.legL.k.rotation.x = Math.max(0, -c * 1.1); u.legR.t.rotation.x = -s * 0.85; u.legR.k.rotation.x = Math.max(0, c * 1.1); }
    else if (!this.grounded) { u.legL.t.rotation.x = lerp(u.legL.t.rotation.x, 0.5, 8 * dt); u.legR.t.rotation.x = lerp(u.legR.t.rotation.x, -0.2, 8 * dt); u.legL.k.rotation.x = lerp(u.legL.k.rotation.x, 1.0, 8 * dt); u.legR.k.rotation.x = lerp(u.legR.k.rotation.x, 0.5, 8 * dt); }
    else { for (const l of [u.legL, u.legR]) { l.t.rotation.x = lerp(l.t.rotation.x, 0, 10 * dt); l.k.rotation.x = lerp(l.k.rotation.x, 0, 10 * dt); } }
    u.armL.s.rotation.x = run ? -s * 0.8 : lerp(u.armL.s.rotation.x, this.grounded ? 0.05 : -0.9, 8 * dt); u.armL.e.rotation.x = run ? -0.6 - Math.max(0, -s) * 0.6 : lerp(u.armL.e.rotation.x, -0.3, 8 * dt);
    u.hips.position.y = 0.98 + (run ? Math.abs(s) * 0.05 : 0);
    const f = this.forward(), fwd = f.x * this.vel.x + f.z * this.vel.z;
    this.lean = lerp(this.lean, this.dashT > 0 ? 0.55 : clamp(fwd / SPEED, -1, 1) * 0.14, 10 * dt); u.torso.rotation.x = this.lean;
    u.hips.rotation.z = this.wall && !this.grounded ? (this.wall.x * Math.cos(this.yaw) + this.wall.z * Math.sin(this.yaw)) * 0.45 : lerp(u.hips.rotation.z, 0, 10 * dt);
    u.sword.visible = this.weapon === 'sword'; u.gun.visible = this.weapon === 'gun'; u.gun.userData.flash.visible = this.weapon === 'gun' && this.attackT > 0.06;
    if (this.weapon === 'gun') { u.armR.s.rotation.x = -Math.PI / 2 - this.pitch * 0.9 + (this.attackT > 0 ? 0.35 : 0); u.armR.e.rotation.x = 0; u.torso.rotation.y = -0.35; }
    else if (this.attackT > 0) { const k = 1 - this.attackT / 0.42; u.armR.s.rotation.x = k < 0.3 ? -2.8 + k * 2 : -2.2 + (k - 0.3) * 5.2; u.armR.e.rotation.x = k < 0.3 ? -1.2 : -0.2; u.torso.rotation.y = 0.55 - k * 1.2; }
    else { u.armR.s.rotation.x = run ? s * 0.8 : lerp(u.armR.s.rotation.x, -0.15, 10 * dt); u.armR.e.rotation.x = lerp(u.armR.e.rotation.x, -0.5, 10 * dt); u.torso.rotation.y = lerp(u.torso.rotation.y, 0, 10 * dt); }
    u.cloth.emissive.setHex(this.hurtT > 0 ? 0xff2222 : 0x000000); u.cloth.emissiveIntensity = this.hurtT > 0 ? 0.6 : 0;
    this.trailUpdate(u.tip, u.hilt);
  }
  trailUpdate(tipObj, hiltObj) {
    const tr = this.trail;
    if (tipObj && hiltObj && this.weapon === 'sword' && this.attackT > 0 && this.attackT < 0.36) {
      this.mesh.updateMatrixWorld(true); const a = V3(), b = V3(); tipObj.getWorldPosition(a); hiltObj.getWorldPosition(b); tr.pts.push([a, b]); if (tr.pts.length > tr.N) tr.pts.shift();
      const pos = tr.mesh.geometry.attributes.position, col = tr.mesh.geometry.attributes.color; const n = tr.pts.length;
      for (let i = 0; i < tr.N; i++) { const p = tr.pts[Math.min(i, n - 1)]; const k = n > 1 ? i / (n - 1) : 1; pos.setXYZ(i * 2, p[0].x, p[0].y, p[0].z); pos.setXYZ(i * 2 + 1, p[1].x, p[1].y, p[1].z); col.setXYZ(i * 2, tr.col.r * k, tr.col.g * k, tr.col.b * k); col.setXYZ(i * 2 + 1, tr.col.r * k * 0.4, tr.col.g * k * 0.4, tr.col.b * k * 0.4); }
      pos.needsUpdate = true; col.needsUpdate = true; tr.mesh.visible = n > 1;
    } else { tr.mesh.visible = false; tr.pts.length = 0; }
  }
  afterimage() { for (let i = 1; i <= 3; i++) { const ghost = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.9, 4, 8), new THREE.MeshBasicMaterial({ color: this.accent, transparent: true, opacity: 0.32 / i })); ghost.userData.op = 0.32 / i; ghost.position.copy(this.pos).add(V3(-this.vel.x * 0.03 * i, 1.0, -this.vel.z * 0.03 * i)); fadeOut(ghost, 0.12 + i * 0.03); } }
  muzzleWorld() { const g = this.rig ? this.rig.gun : this.mesh.userData.gun; this.mesh.updateMatrixWorld(true); const p = V3(); g.userData.muzzle.getWorldPosition(p); return p; }
  shoot(aimDir) {
    const from = this.eye(); const dir = aimDir ? aimDir.clone() : this.aim();
    if (!this.isPlayer) { dir.x += rand(-0.08, 0.08); dir.y += rand(-0.06, 0.06); dir.z += rand(-0.08, 0.08); dir.normalize(); }
    ray.set(from, dir); ray.far = 90;
    const hits = ray.intersectObjects(levelMeshes, false); let end = from.clone().addScaledVector(dir, hits.length ? hits[0].distance : 90);
    let victim = null, best = hits.length ? hits[0].distance : 90;
    for (const f of fighters) { if (f === this || f.dead) continue; const c = f.pos.clone().setY(f.pos.y + 1.0); const t = c.clone().sub(from).dot(dir); if (t < 0 || t > best) continue; const perp = c.sub(from.clone().addScaledVector(dir, t)).length(); if (perp < 0.75) { victim = f; best = t; } }
    if (victim) end = from.clone().addScaledVector(dir, best);
    const mz = this.muzzleWorld(); tracer(mz, end); flashLight(mz); if (this.isPlayer || this.near()) SFX.shot();
    if (victim) { victim.damage(19, this); sparks(end, 8, 5); } else { sparks(end, 4, 3, 0xc9c9c9); if (hits.length && hits[0].face) decal(end, hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld)); }
    if (this.isPlayer) { this.pitch += 0.012; recoil = 0.7; }
  }
  slashDamage() {
    const f0 = this.forward(); let any = false;
    for (const f of fighters) { if (f === this || f.dead) continue; const d = f.pos.clone().sub(this.pos); d.y = 0; const dist = d.length(); if (dist > 3.0) continue; if (d.normalize().dot(f0) < 0.4) continue; f.damage(34, this); f.vel.addScaledVector(f0, 7).y += 3; sparks(f.pos.clone().add(V3(0, 1.1, 0)), 14, 7, 0xfacc15); any = true; }
    if (any) { if (this.isPlayer || this.near()) SFX.clang(); if (this.isPlayer) { hitStop = 0.045; camShake = 0.5; } }
  }
  damage(n, by) {
    if (this.dead) return; if (this.isPlayer && (GOD || !controlTaken)) n = 0; if (this.guard > 0) n = 0; if (this.isPlayer) n = Math.round(n * 0.65); this.hp -= n; if (n > 0) { this.hurtT = 0.2; this.sinceHit = 0; } this.lastHitBy = by; this.label.userData.draw(this.hp / this.maxHp * 100);
    if (n > 0) { hitText(this.pos.clone().add(V3(0, 1.9, 0)), `-${n}`, by && by.isPlayer ? '#facc15' : '#ff8a8a'); if (this.rig && !(this.rig.shot && perfTime < this.rig.shot.until) && this.attackT <= 0) this.once('Hit_A', 0.3, 0.05); }
    if (this.isPlayer) { $('vig').classList.add('hit'); setTimeout(() => $('vig').classList.remove('hit'), 140); SFX.hit(); camShake = Math.max(camShake, 0.5); }
    if (by && by.isPlayer) { $('cross').classList.add('mark'); setTimeout(() => $('cross').classList.remove('mark'), 120); }
    if (this.hp <= 0) this.die(by);
  }
  die(by) {
    this.dead = true; this.deaths++; this.respawnT = 3.0; this.hp = 0; this.trail.mesh.visible = false;
    if (this.rig) this.once(pick(['Death_A', 'Death_B']), 1.1, 0.05); else this.mesh.rotation.x = 0.1;
    sparks(this.pos.clone().add(V3(0, 1, 0)), 30, 9, this.accent); puff(this.pos.clone().add(V3(0, 1, 0)), 3, 0xffffff); if (this.isPlayer || this.near()) SFX.die();
    if (by) { by.kills++; feed(by, this); if (by.isPlayer) $('kills').textContent = by.kills; }
    if (this.isPlayer) { $('dead').style.display = 'grid'; $('dead-by').textContent = by ? `${by.name} took you down` : 'you fell'; }
  }
}

// ------------------------------------------------------------------ bot brain
function botThink(f, dt) {
  const b = f.brain, out = { move: { x: 0, z: 0 }, jump: false, dash: false, attack: false, alt: false, reload: false, swap: false, aimDir: null };
  if (f.dead) return out;
  b.losT -= dt; b.dodgeT = Math.max(0, b.dodgeT - dt);
  if (!b.target || b.target.dead || b.losT <= 0) {
    let best = null, bd = 1e9; for (const o of fighters) { if (o === f || o.dead || (o.isPlayer && (!controlTaken || o.guard > 0))) continue; let d = o.pos.distanceToSquared(f.pos); if (o.isPlayer) { if (d > 14 * 14) continue; d += 36; } if (d < bd) { bd = d; best = o; } }
    b.target = best; b.losT = 0.3;
    if (best) { const from = f.eye(), dir = best.pos.clone().setY(best.pos.y + 1).sub(from); const dist = dir.length(); dir.normalize(); ray.set(from, dir); ray.far = dist; b.los = ray.intersectObjects(levelMeshes, false).length === 0; }
  }
  const t = b.target; let goal;
  if (t) {
    const to = t.pos.clone().sub(f.pos); to.y = 0; const dist = to.length(); to.normalize();
    f.yaw = Math.atan2(-to.x, -to.z); f.pitch = clamp(Math.atan2(t.pos.y - f.pos.y, dist), -0.6, 0.6);
    const strafe = V3(-to.z, 0, to.x).multiplyScalar(b.strafe * Math.sin(perfTime * 1.7 + f.name.length));
    if (dist > 3.0) goal = to.clone().add(strafe.multiplyScalar(0.6)); else goal = strafe.multiplyScalar(0.8).add(to.clone().multiplyScalar(-0.2));
    if (Math.random() < dt * 0.4) b.strafe *= -1;
    if (f.hurtT > 0.15 && b.dodgeT <= 0 && Math.random() < 0.5) { out.dash = true; b.dodgeT = 2; }
    if (dist < 3.2) { if (f.weapon !== 'sword') out.swap = true; else out.attack = Math.random() < dt * 4; }
    else if (b.los && dist < 30) { if (f.weapon !== 'gun') out.swap = true; else { b.burstT -= dt; if (b.burstT <= 0) { out.attack = true; b.burst++; if (b.burst >= 3) { b.burst = 0; b.burstT = rand(0.9, 1.6); } else b.burstT = 0.18; } out.aimDir = t.pos.clone().setY(t.pos.y + 1.0).sub(f.eye()).normalize(); } }
    b.dashCd -= dt; if (b.dashCd <= 0 && dist > 5 && dist < 16 && Math.random() < 0.6) { out.dash = true; b.dashCd = rand(2.5, 5); } else if (b.dashCd <= 0) b.dashCd = 1;
    if (t.pos.y > f.pos.y + 1.5 && Math.random() < dt * 1.2) out.jump = true;
  } else {
    b.wanderT -= dt; if (b.wanderT <= 0) { b.wander.set(rand(-HW + 3, HW - 3), 0, rand(-HD + 3, HD - 3)); b.wanderT = rand(2, 4); }
    const to = b.wander.clone().sub(f.pos); to.y = 0; goal = to.length() > 1 ? to.normalize() : V3(); if (goal.length()) f.yaw = Math.atan2(-goal.x, -goal.z);
  }
  if (goal) { out.move.x = goal.x; out.move.z = goal.z; }
  const sp = Math.hypot(f.vel.x, f.vel.z);
  if (goal && goal.length() > 0.3 && sp < 1.5 && f.grounded) { b.blockedT += dt; if (b.blockedT > 0.35) { out.jump = true; b.blockedT = 0; } } else b.blockedT = 0;
  if (f.wall && !f.grounded && Math.random() < dt * 3) out.jump = true;
  if (f.ammo === 0 && f.reloadT <= 0) out.reload = true;
  return out;
}

// ------------------------------------------------------------------ input
const keys = {}; let mouseDX = 0, mouseDY = 0, mouseL = false, locked = false, actions = 0, actionsT = 0;
const edge = { jump: false, dash: false, attack: false, alt: false, reload: false, swap: false };
const keyEl = {}; document.querySelectorAll('#keys .k').forEach((el) => { keyEl[el.dataset.k] = el; });
function setKey(code, on) { keys[code] = on; const el = keyEl[code]; if (el) el.classList.toggle('on', on); if (on) actions++; }
addEventListener('keydown', (e) => { if (e.repeat) return; setKey(e.code, true); if (e.code === 'Space') edge.jump = true; if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') edge.dash = true; if (e.code === 'KeyQ') edge.swap = true; if (e.code === 'KeyR') edge.reload = true; if (e.code === 'Tab') $('board').style.display = 'grid'; if (e.code === 'Space' || e.code === 'Tab') e.preventDefault(); });
addEventListener('keyup', (e) => { setKey(e.code, false); if (e.code === 'Tab') $('board').style.display = 'none'; });
// pointer lock is the normal path; where it is refused (embedded views, some browsers) the first click switches to free-look:
// raw mouse movement still steers, clicks still attack, and the cursor is hidden over the canvas
let freeLook = false;
const inControl = () => locked || freeLook;
addEventListener('mousemove', (e) => { if (!inControl()) return; mouseDX += e.movementX; mouseDY += e.movementY; });
addEventListener('mousedown', (e) => { if (!inControl()) return; if (e.button === 0) { mouseL = true; edge.attack = true; setKey('MouseL', true); } if (e.button === 2) { edge.alt = true; setKey('MouseR', true); } });
addEventListener('mouseup', (e) => { if (e.button === 0) { mouseL = false; setKey('MouseL', false); } if (e.button === 2) setKey('MouseR', false); });
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('wheel', () => { if (inControl()) edge.swap = true; }, { passive: true });
let player = null, controlTaken = DEMO || !!RECORD_FPS;   // until the mouse is grabbed the player is a spectator: untargetable and unhurt
function enableFreeLook() { if (locked || freeLook) return; freeLook = true; controlTaken = true; renderer.domElement.style.cursor = 'none'; $('grab').style.display = 'none'; }
let lockTried = false;
function grabMouse() {
  if (lockTried) { enableFreeLook(); return; }
  lockTried = true; let settled = false;
  try { Promise.resolve(renderer.domElement.requestPointerLock()).catch(() => { settled = true; enableFreeLook(); }); } catch { settled = true; enableFreeLook(); }
  setTimeout(() => { if (!settled && !locked) enableFreeLook(); }, 400);
}
document.addEventListener('pointerlockchange', () => { locked = document.pointerLockElement === renderer.domElement; if (locked) { controlTaken = true; freeLook = false; renderer.domElement.style.cursor = ''; } $('grab').style.display = locked || freeLook || DEMO ? 'none' : 'block'; });
renderer.domElement.addEventListener('click', () => { if (!inControl() && !DEMO && player && !player.dead) { SFX.init(); grabMouse(); } });

function playerInput() {
  const inp = { move: { x: 0, z: 0 }, jump: edge.jump, dash: edge.dash, attack: edge.attack || (mouseL && player.weapon === 'gun'), alt: edge.alt, reload: edge.reload, swap: edge.swap, aimDir: null };
  for (const k in edge) edge[k] = false;
  player.yaw -= mouseDX * 0.0022; player.pitch = clamp(player.pitch - mouseDY * 0.0022, -1.2, 1.1); mouseDX = mouseDY = 0;
  const f = player.forward(), r = V3(-f.z, 0, f.x); let ax = 0, az = 0;
  if (keys.KeyW) { ax += f.x; az += f.z; } if (keys.KeyS) { ax -= f.x; az -= f.z; } if (keys.KeyD) { ax += r.x; az += r.z; } if (keys.KeyA) { ax -= r.x; az -= r.z; }
  const l = Math.hypot(ax, az); if (l > 0) { ax /= l; az /= l; } inp.move.x = ax; inp.move.z = az;
  const dir = V3(); camera.getWorldDirection(dir); inp.aimDir = dir; return inp;
}

// ------------------------------------------------------------------ camera
const camPos = V3(); let camYaw = null;
function updateCamera(dt) {
  const head = player.pos.clone().add(V3(0, 1.55, 0));
  const cp = DEMO ? clamp(player.pitch, -0.3, 0.12) : player.pitch;   // the bot brain aims up at balconies; keep the demo camera level
  if (camYaw === null) camYaw = player.yaw;
  if (DEMO) { let d = player.yaw - camYaw; d = Math.atan2(Math.sin(d), Math.cos(d)); camYaw += d * (1 - Math.pow(0.02, dt)); } else camYaw = player.yaw;
  const back = V3(Math.sin(camYaw) * Math.cos(cp), -Math.sin(cp), Math.cos(camYaw) * Math.cos(cp));
  const side = V3(Math.cos(camYaw), 0, -Math.sin(camYaw));
  const want = head.clone().addScaledVector(back, DEMO ? 5.6 : 4.4).addScaledVector(side, 0.5).add(V3(0, DEMO ? 1.0 : 0.7, 0));
  ray.set(head, want.clone().sub(head).normalize()); ray.far = head.distanceTo(want);
  const hit = ray.intersectObjects(levelMeshes, false)[0]; if (hit) want.copy(head).addScaledVector(ray.ray.direction, Math.max(0.6, hit.distance - 0.25));
  camPos.lerp(want, 1 - Math.pow(0.0005, dt)); camera.position.copy(camPos);
  const aimV = DEMO ? V3(-Math.sin(camYaw) * Math.cos(cp), Math.sin(cp), -Math.cos(camYaw) * Math.cos(cp)) : player.aim();
  camera.lookAt(head.clone().addScaledVector(side, 0.5).addScaledVector(aimV, 7));
  recoil = Math.max(0, recoil - dt * 6); camShake = Math.max(0, camShake - dt * 4);
  camera.position.x += (Math.random() - 0.5) * (camShake + recoil * 0.2) * 0.12; camera.position.y += recoil * 0.06 + (Math.random() - 0.5) * camShake * 0.08;
  camera.fov = lerp(camera.fov, player.dashT > 0 ? 80 : 68, 8 * dt); camera.updateProjectionMatrix();
}

// ------------------------------------------------------------------ hud
function feed(by, victim) {
  const el = document.createElement('div'); el.innerHTML = `<b>${by.name}</b> <i>${by.weapon === 'sword' ? '⚔' : '✦'}</i> ${victim.name}`; if (by.isPlayer || victim.isPlayer) el.className = 'me';
  const f = $('feed'); f.prepend(el); while (f.children.length > 5) f.lastChild.remove(); setTimeout(() => el.remove(), 6000);
}
let fpsAcc = 0, fpsN = 0, gameT = 0, boardT = 0;
function updateHUD(dt) {
  $('hp').querySelector('i').style.width = clamp(player.hp / player.maxHp * 100, 0, 100) + '%'; $('hp-n').textContent = Math.max(0, Math.round(player.hp));
  $('st').querySelector('i').style.width = clamp(player.stam, 0, 100) + '%'; $('st-n').textContent = Math.round(player.stam);
  $('ammo').textContent = player.reloadT > 0 ? '…' : player.ammo; $('ammo-l').textContent = player.reloadT > 0 ? 'reloading' : 'rounds · ∞';
  $('w-sword').classList.toggle('on', player.weapon === 'sword'); $('w-gun').classList.toggle('on', player.weapon === 'gun');
  gameT += dt; const m = Math.floor(gameT / 60), s = Math.floor(gameT % 60); $('clock').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`; $('kd').textContent = `${player.kills} / ${player.deaths}`;
  actionsT += dt; if (actionsT >= 1) { $('apm').textContent = Math.round(actions * 60 / actionsT); actions = 0; actionsT = 0; }
  fpsAcc += dt; fpsN++; if (fpsAcc >= 0.5) { $('fps').textContent = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
  if (player.dead) $('dead-t').textContent = Math.ceil(Math.max(0, player.respawnT)); else if ($('dead').style.display === 'grid') $('dead').style.display = 'none';
  const dir = V3(); camera.getWorldDirection(dir); let hot = false;
  for (const f of fighters) { if (f === player || f.dead) continue; const c = f.pos.clone().setY(f.pos.y + 1).sub(camera.position); const t = c.dot(dir); if (t > 0 && t < 60 && c.sub(dir.clone().multiplyScalar(t)).length() < 0.9) { hot = true; break; } }
  $('cross').classList.toggle('hot', hot); $('cross').style.transform = `scale(${1 + recoil * 0.5})`;
  boardT -= dt; if (boardT <= 0) { boardT = 0.5; $('board-rows').innerHTML = [...fighters].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths).map((f, i) => `<tr class="${f.isPlayer ? 'me' : ''}"><td>${i + 1}</td><td><i style="background:#${new THREE.Color(f.accent).getHexString()}"></i>${f.name}</td><td>${f.kills}</td><td>${f.deaths}</td></tr>`).join(''); }
}

// ------------------------------------------------------------------ post
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
if (POST) {
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.42, 0.55, 0.92));
  const vig = new ShaderPass(VignetteShader); vig.uniforms.offset.value = 0.95; vig.uniforms.darkness.value = 1.15; composer.addPass(vig);
  composer.addPass(new SMAAPass(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio()));
}
composer.addPass(new OutputPass());
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight); });

// ------------------------------------------------------------------ loop
function update(dt) {
  perfTime += dt;
  if (hitStop > 0) { hitStop -= dt; dt *= 0.15; }
  const pin = DEMO ? botThink(player, dt) : playerInput();
  player.step(dt, pin);
  for (const f of fighters) { if (f.isPlayer) continue; f.step(dt, botThink(f, dt)); }
  for (const f of fighters) if (!f.isPlayer) f.label.lookAt(camera.position);
  for (let i = 0; i < flames.length; i++) { const k = 0.85 + 0.25 * Math.sin(perfTime * 13 + i * 1.7) * Math.sin(perfTime * 7.3 + i); flames[i].scale.set(0.45 * k, 0.8 * k, 1); }
  const dp = dustGeo.attributes.position.array; for (let i = 0; i < dustN; i++) { dp[i * 3 + 1] += Math.sin(perfTime * 0.5 + dustSeed[i]) * 0.002; dp[i * 3] += Math.cos(perfTime * 0.3 + dustSeed[i]) * 0.002; } dustGeo.attributes.position.needsUpdate = true;
  updateFX(dt); updateCamera(dt); updateHUD(dt);
}
const clock = new THREE.Clock(); let acc = 0; const FIXED = 1 / 60;
function frame() { const dt = Math.min(0.05, clock.getDelta()); acc += dt; while (acc >= FIXED) { update(FIXED); acc -= FIXED; } composer.render(); requestAnimationFrame(frame); }

async function boot() {
  await loadCharacters();
  const kinds = Object.keys(CHARS);
  player = new Fighter({ name: 'Kevin', color: 0xf97316, accent: 0xfacc15, kind: kinds.includes('Knight') ? 'Knight' : kinds[0], isPlayer: true });
  fighters.push(player);
  const botKinds = ['Rogue', 'Barbarian', 'Knight'].filter((k) => kinds.includes(k));
  for (let i = 0; i < BOT_COUNT; i++) fighters.push(new Fighter({ name: `${NAMES[i % NAMES.length]} ${i + 1}`, color: TEAM_COLS[i % TEAM_COLS.length], accent: 0xffffff, kind: botKinds.length ? botKinds[i % botKinds.length] : null }));
  $('loading').style.display = 'none';
  $('grab').style.display = DEMO || RECORD_FPS ? 'none' : 'block';
  camPos.set(player.pos.x, player.pos.y + 3, player.pos.z + 6);
  if (RECORD_FPS) {
    window.__step = () => { const n = Math.round(60 / RECORD_FPS); for (let i = 0; i < n; i++) update(FIXED); composer.render(); return true; };
    for (let i = 0; i < 90; i++) update(FIXED); composer.render(); window.__ready = true;
  } else frame();
}
boot().catch((e) => { console.error(e); $('grab').style.display = 'block'; $('grab').querySelector('.pill').textContent = 'could not start: ' + e.message; });
