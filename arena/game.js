// Gunslash Arena — a third-person wall-running sword-and-gun arena.
// Original work: every mesh, texture and sound here is generated in code.
//
// URL params:  ?bots=8      number of bots (free-for-all)
//              ?demo=1      the player is driven by the bot brain (for capture)
//              ?record=12   deterministic stepping at 12 fps; window.__step() advances one frame
//              ?bloom=0     disable the bloom pass

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const Q = new URLSearchParams(location.search);
const BOT_COUNT = Math.max(0, Math.min(20, parseInt(Q.get('bots') || '8', 10) || 8));
const DEMO = Q.get('demo') === '1';
const RECORD_FPS = parseInt(Q.get('record') || '0', 10) || 0;
const BLOOM = Q.get('bloom') !== '0';
const GOD = Q.get('god') === '1';   // the player shrugs off damage (used for the README capture)

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ------------------------------------------------------------------ audio (synthesised)
const SFX = {
  ctx: null,
  init() {
    if (this.ctx || RECORD_FPS) return;
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { this.ctx = null; }
    if (!this.ctx) return;
    const n = this.ctx.sampleRate * 1.5, buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;
    this.master = this.ctx.createGain(); this.master.gain.value = 0.35; this.master.connect(this.ctx.destination);
  },
  env(node, t0, a, d, peak = 1) { const g = this.ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(peak, t0 + a); g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d); node.connect(g); g.connect(this.master); return g; },
  burst(dur, freq, qv, peak, type = 'lowpass') {
    if (!this.ctx) return; const t = this.ctx.currentTime, s = this.ctx.createBufferSource(); s.buffer = this.noise;
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = qv; s.connect(f); this.env(f, t, 0.005, dur, peak); s.start(t); s.stop(t + dur + 0.05);
  },
  tone(f0, f1, dur, peak = 0.4, type = 'square') {
    if (!this.ctx) return; const t = this.ctx.currentTime, o = this.ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur); this.env(o, t, 0.005, dur, peak); o.start(t); o.stop(t + dur + 0.05);
  },
  shot() { this.burst(0.18, 1400, 0.7, 0.9); this.tone(180, 40, 0.12, 0.5, 'sawtooth'); },
  slash() { this.burst(0.22, 3200, 1.2, 0.5, 'bandpass'); },
  hit() { this.tone(900, 300, 0.08, 0.35, 'triangle'); },
  clang() { this.tone(1800, 1200, 0.12, 0.3, 'square'); },
  jump() { this.tone(300, 620, 0.12, 0.25, 'sine'); },
  dash() { this.burst(0.25, 900, 0.5, 0.45, 'highpass'); },
  step() { this.burst(0.05, 500, 0.8, 0.12); },
  reload() { this.tone(500, 800, 0.06, 0.25, 'square'); setTimeout(() => this.tone(800, 400, 0.06, 0.25, 'square'), 180); },
  die() { this.tone(400, 60, 0.5, 0.5, 'sawtooth'); this.burst(0.4, 600, 0.6, 0.6); },
  wall() { this.burst(0.12, 700, 0.9, 0.2, 'bandpass'); },
};

// ------------------------------------------------------------------ procedural textures
function canvasTex(size, draw, repeat = [1, 1]) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
function speckle(g, s, n, alpha, col = '#000') { g.fillStyle = col; for (let i = 0; i < n; i++) { g.globalAlpha = Math.random() * alpha; g.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 2, 1 + Math.random() * 2); } g.globalAlpha = 1; }
const TEX = {
  stone: (rep) => canvasTex(512, (g, s) => {
    g.fillStyle = '#5c5751'; g.fillRect(0, 0, s, s); speckle(g, s, 9000, 0.35); speckle(g, s, 4000, 0.25, '#fff');
    const bh = 64, bw = 128; g.strokeStyle = 'rgba(20,16,12,.85)'; g.lineWidth = 4;
    for (let y = 0; y < s; y += bh) { g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke(); const off = (y / bh) % 2 ? bw / 2 : 0; for (let x = off; x < s; x += bw) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + bh); g.stroke(); } }
  }, rep),
  plank: (rep) => canvasTex(512, (g, s) => {
    g.fillStyle = '#6e4a2a'; g.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 64) { g.fillStyle = `hsl(28,45%,${22 + Math.random() * 10}%)`; g.fillRect(0, y, s, 62); g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 2; g.strokeRect(0, y, s, 62); }
    g.globalAlpha = 0.25; g.strokeStyle = '#2a1608'; for (let i = 0; i < 140; i++) { g.beginPath(); const y = Math.random() * s; g.moveTo(0, y); g.bezierCurveTo(s / 3, y + rand(-6, 6), 2 * s / 3, y + rand(-6, 6), s, y + rand(-4, 4)); g.stroke(); } g.globalAlpha = 1;
  }, rep),
  carpet: (rep) => canvasTex(256, (g, s) => {
    g.fillStyle = '#7a1424'; g.fillRect(0, 0, s, s); speckle(g, s, 6000, 0.3); speckle(g, s, 2000, 0.15, '#ffb0b0');
    g.fillStyle = '#d9a441'; g.fillRect(0, 0, s, 10); g.fillRect(0, s - 10, s, 10); g.fillStyle = '#2b0810'; g.fillRect(0, 12, s, 4); g.fillRect(0, s - 16, s, 4);
  }, rep),
  marble: (rep) => canvasTex(512, (g, s) => {
    g.fillStyle = '#d8d4cc'; g.fillRect(0, 0, s, s); speckle(g, s, 3000, 0.08);
    g.strokeStyle = 'rgba(70,60,60,.35)'; g.lineWidth = 1.5;
    for (let i = 0; i < 40; i++) { g.beginPath(); let x = Math.random() * s, y = Math.random() * s; g.moveTo(x, y); for (let k = 0; k < 6; k++) { x += rand(-80, 80); y += rand(-80, 80); g.lineTo(x, y); } g.stroke(); }
  }, rep),
  gold: () => canvasTex(64, (g, s) => { g.fillStyle = '#c9982f'; g.fillRect(0, 0, s, s); speckle(g, s, 200, 0.3, '#fff'); }),
  ceiling: (rep) => canvasTex(256, (g, s) => { g.fillStyle = '#1d1a20'; g.fillRect(0, 0, s, s); g.strokeStyle = 'rgba(255,255,255,.06)'; g.lineWidth = 3; for (let i = 0; i < s; i += 64) { g.strokeRect(i + 6, 6, 52, 52); g.strokeRect(6, i + 6, 52, 52); } }, rep),
};

// ------------------------------------------------------------------ renderer / scene
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: !!RECORD_FPS });
renderer.setPixelRatio(Math.min(devicePixelRatio, RECORD_FPS ? 1 : 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0a10);
scene.fog = new THREE.Fog(0x0b0a10, 45, 130);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.1, 200);

scene.add(new THREE.HemisphereLight(0x9a8cff, 0x3a2a18, 1.1));
scene.add(new THREE.AmbientLight(0xffe6c8, 0.35));
const sun = new THREE.DirectionalLight(0xffe3c0, 2.2);
sun.position.set(18, 30, -12); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -45; sun.shadow.camera.right = 45; sun.shadow.camera.top = 40; sun.shadow.camera.bottom = -40; sun.shadow.camera.far = 90; sun.shadow.bias = -0.0008;
scene.add(sun);

// ------------------------------------------------------------------ level
const colliders = [];   // { min:Vector3, max:Vector3 }
const levelMeshes = [];
const level = new THREE.Group(); scene.add(level);
const MAT = {
  stone: new THREE.MeshStandardMaterial({ map: TEX.stone([6, 3]), roughness: 0.9 }),
  stoneWide: new THREE.MeshStandardMaterial({ map: TEX.stone([14, 3]), roughness: 0.9 }),
  plank: new THREE.MeshStandardMaterial({ map: TEX.plank([12, 8]), roughness: 0.7 }),
  carpet: new THREE.MeshStandardMaterial({ map: TEX.carpet([10, 1]), roughness: 1.0 }),
  marble: new THREE.MeshStandardMaterial({ map: TEX.marble([2, 2]), roughness: 0.35, metalness: 0.05 }),
  gold: new THREE.MeshStandardMaterial({ map: TEX.gold(), roughness: 0.35, metalness: 0.8 }),
  ceiling: new THREE.MeshStandardMaterial({ map: TEX.ceiling([12, 8]), roughness: 0.9 }),
  crate: new THREE.MeshStandardMaterial({ map: TEX.plank([1, 1]), roughness: 0.8 }),
  glow: new THREE.MeshStandardMaterial({ color: 0xffe0b0, emissive: 0xffc070, emissiveIntensity: 2.4 }),
  window: new THREE.MeshStandardMaterial({ color: 0x9fbfff, emissive: 0x7aa8ff, emissiveIntensity: 1.6 }),
  painting: new THREE.MeshStandardMaterial({ color: 0x2a1f2e, roughness: 0.6 }),
};
function box(w, h, d, x, y, z, mat, { solid = true, shadow = true, rot = 0 } = {}) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z); m.rotation.y = rot; m.castShadow = shadow; m.receiveShadow = true; level.add(m); levelMeshes.push(m);
  if (solid) colliders.push({ min: new THREE.Vector3(x - w / 2, y - h / 2, z - d / 2), max: new THREE.Vector3(x + w / 2, y + h / 2, z + d / 2) });
  return m;
}
const HW = 30, HD = 20, HH = 14;               // half width, half depth, height
box(2 * HW + 2, 1, 2 * HD + 2, 0, -0.5, 0, MAT.plank);                          // floor
box(2 * HW - 2, 0.06, 8, 0, 0.03, 0, MAT.carpet, { solid: false, shadow: false }); // carpet
box(2 * HW + 2, 1, 2 * HD + 2, 0, HH + 0.5, 0, MAT.ceiling, { shadow: false });   // ceiling
box(2 * HW + 2, HH, 1, 0, HH / 2, -HD - 0.5, MAT.stoneWide);                     // walls
box(2 * HW + 2, HH, 1, 0, HH / 2, HD + 0.5, MAT.stoneWide);
box(1, HH, 2 * HD + 2, -HW - 0.5, HH / 2, 0, MAT.stone);
box(1, HH, 2 * HD + 2, HW + 0.5, HH / 2, 0, MAT.stone);
// balcony ring at y=5 along the long walls, stairs at both ends
const BY = 5, BW = 6;
box(2 * HW, 0.6, BW, 0, BY - 0.3, -HD + BW / 2, MAT.marble);
box(2 * HW, 0.6, BW, 0, BY - 0.3, HD - BW / 2, MAT.marble);
box(2 * HW, 1.0, 0.2, 0, BY + 0.5, -HD + BW, MAT.gold, { shadow: false });        // railings
box(2 * HW, 1.0, 0.2, 0, BY + 0.5, HD - BW, MAT.gold, { shadow: false });
for (const sx of [-1, 1]) {
  for (let i = 0; i < 10; i++) {                                                  // staircases
    const h = 0.5 * (i + 1), depth = 1.0;
    box(8, h, depth, sx * (HW - 4), h / 2, -HD + BW + 0.5 + i * depth, MAT.marble);
    box(8, h, depth, sx * (HW - 4), h / 2, HD - BW - 0.5 - i * depth, MAT.marble);
  }
  box(8, 0.6, 2 * HD - 2 * BW - 20, sx * (HW - 4), BY - 0.3, 0, MAT.marble);      // landing bridging the two stairs
  box(0.2, 1.0, 2 * HD - 2 * BW - 20, sx * (HW - 8) , BY + 0.5, 0, MAT.gold, { shadow: false });
}
for (let i = 0; i < 4; i++) for (const sz of [-1, 1]) {                           // pillars under the balconies
  const x = -18 + i * 12, z = sz * (HD - BW - 0.9);
  const p = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.0, BY, 18), MAT.marble); p.position.set(x, BY / 2, z); p.castShadow = p.receiveShadow = true; level.add(p); levelMeshes.push(p);
  colliders.push({ min: new THREE.Vector3(x - 0.9, 0, z - 0.9), max: new THREE.Vector3(x + 0.9, BY, z + 0.9) });
  const cap = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.4, 2.4), MAT.gold); cap.position.set(x, BY - 0.2, z); level.add(cap);
}
box(14, 1.2, 9, 0, 0.6, 0, MAT.marble);                                          // central stage
box(2.4, 2.4, 2.4, -4, 2.4, 1.5, MAT.crate); box(2.4, 2.4, 2.4, 4.5, 2.4, -1.5, MAT.crate);
for (const [x, z, s] of [[-22, 6, 2.2], [22, -6, 2.2], [-12, -9, 1.6], [12, 9, 1.6], [-24, -3, 3.2], [24, 3, 3.2], [0, -12, 1.4], [0, 12, 1.4]]) box(s, s, s, x, s / 2, z, MAT.crate);
for (const sz of [-1, 1]) for (let i = 0; i < 5; i++) {                           // windows and paintings
  const x = -24 + i * 12;
  box(4, 6, 0.2, x, 9, sz * (HD + 0.35), MAT.window, { solid: false, shadow: false });
  box(4.6, 6.6, 0.1, x, 9, sz * (HD + 0.42), MAT.gold, { solid: false, shadow: false });
  if (i % 2) { box(3, 2.2, 0.15, x + 6, 3.2, sz * (HD + 0.4), MAT.painting, { solid: false, shadow: false }); box(3.4, 2.6, 0.1, x + 6, 3.2, sz * (HD + 0.44), MAT.gold, { solid: false, shadow: false }); }
}
for (const x of [-16, 0, 16]) {                                                   // chandeliers
  const g = new THREE.Group(); g.position.set(x, 10.5, 0);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.12, 8, 24), MAT.gold); ring.rotation.x = Math.PI / 2; g.add(ring);
  for (let k = 0; k < 8; k++) { const b = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), MAT.glow); b.position.set(Math.cos(k / 8 * 6.283) * 1.6, 0.25, Math.sin(k / 8 * 6.283) * 1.6); g.add(b); }
  const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.5, 6), MAT.gold); chain.position.y = 1.75; g.add(chain);
  const l = new THREE.PointLight(0xffc98a, 320, 70, 2); l.position.y = -0.4; g.add(l);
  level.add(g);
}
for (const sz of [-1, 1]) for (let i = 0; i < 5; i++) { const l = new THREE.PointLight(0xffb070, 60, 26, 2); l.position.set(-24 + i * 12, 7.5, sz * (HD - 1.2)); level.add(l); }
const SPAWNS = [[-26, 0, -16], [26, 0, 16], [-26, 0, 16], [26, 0, -16], [0, 1.2, 0], [-14, BY, -17], [14, BY, 17], [-25, BY, 0], [25, BY, 0], [12, 0, -12], [-12, 0, 12]];

// ------------------------------------------------------------------ characters
const NAMES = ['Breaker', 'Vanta', 'Rook', 'Sable', 'Nix', 'Juno', 'Pike', 'Mara', 'Onyx', 'Tess', 'Kael', 'Lumen', 'Dusk', 'Aria', 'Cinder', 'Wren', 'Vex', 'Ilo', 'Ash', 'Tarn'];
const TEAM_COLS = [0x58a6ff, 0xa371f7, 0x3fb950, 0x2dd4bf, 0xf472b6, 0xfbbf24, 0x60a5fa, 0xc084fc];
function labelSprite(text, color) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 64; const g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })); sp.scale.set(2.2, 0.55, 1);
  sp.userData.draw = (hp) => {
    g.clearRect(0, 0, 256, 64); g.font = '700 26px system-ui, sans-serif'; g.textAlign = 'center'; g.fillStyle = '#000a'; g.fillText(text, 130, 30); g.fillStyle = color; g.fillText(text, 128, 28);
    g.fillStyle = '#0008'; g.fillRect(48, 40, 160, 10); g.fillStyle = hp > 50 ? '#3fb950' : hp > 25 ? '#f97316' : '#ef4444'; g.fillRect(48, 40, 160 * clamp(hp / 100, 0, 1), 10); tex.needsUpdate = true;
  };
  sp.userData.draw(100); return sp;
}
function humanoid(col, accent) {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xe8c39e, roughness: 0.8 });
  const cloth = new THREE.MeshStandardMaterial({ color: col, roughness: 0.6, metalness: 0.15 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1a22, roughness: 0.7 });
  const trim = new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.5, roughness: 0.4 });
  const mk = (w, h, d, m, x, y, z, parent = g) => { const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); mesh.position.set(x, y, z); mesh.castShadow = true; parent.add(mesh); return mesh; };
  const hips = new THREE.Group(); hips.position.y = 0.95; g.add(hips);
  const torso = mk(0.62, 0.7, 0.36, cloth, 0, 0.35, 0, hips);
  mk(0.64, 0.12, 0.38, trim, 0, 0.02, 0, hips);                                   // belt
  const headG = new THREE.Group(); headG.position.set(0, 0.86, 0); hips.add(headG);
  mk(0.4, 0.42, 0.4, skin, 0, 0, 0, headG); mk(0.44, 0.2, 0.44, dark, 0, 0.16, -0.02, headG); // hair
  mk(0.08, 0.06, 0.02, dark, -0.1, 0.02, 0.21, headG); mk(0.08, 0.06, 0.02, dark, 0.1, 0.02, 0.21, headG);
  const armL = new THREE.Group(); armL.position.set(-0.42, 0.62, 0); hips.add(armL); mk(0.2, 0.7, 0.2, cloth, 0, -0.32, 0, armL); mk(0.16, 0.16, 0.16, skin, 0, -0.72, 0, armL);
  const armR = new THREE.Group(); armR.position.set(0.42, 0.62, 0); hips.add(armR); mk(0.2, 0.7, 0.2, cloth, 0, -0.32, 0, armR); mk(0.16, 0.16, 0.16, skin, 0, -0.72, 0, armR);
  const legL = new THREE.Group(); legL.position.set(-0.17, 0, 0); hips.add(legL); mk(0.26, 0.9, 0.28, dark, 0, -0.47, 0, legL);
  const legR = new THREE.Group(); legR.position.set(0.17, 0, 0); hips.add(legR); mk(0.26, 0.9, 0.28, dark, 0, -0.47, 0, legR);
  // weapons live in the right hand
  const sword = new THREE.Group(); sword.position.set(0, -0.75, 0.1); armR.add(sword);
  mk(0.07, 0.1, 0.34, trim, 0, 0, 0.05, sword); const blade = mk(0.05, 0.08, 1.15, new THREE.MeshStandardMaterial({ color: 0xdfe6f5, metalness: 0.9, roughness: 0.15 }), 0, 0, 0.8, sword);
  const gun = new THREE.Group(); gun.position.set(0, -0.75, 0.1); armR.add(gun);
  mk(0.12, 0.18, 0.5, dark, 0, 0, 0.2, gun); mk(0.08, 0.08, 0.42, new THREE.MeshStandardMaterial({ color: 0x8f97a6, metalness: 0.8, roughness: 0.3 }), 0, 0.06, 0.45, gun); mk(0.06, 0.06, 0.1, trim, 0, 0.06, 0.7, gun);
  const muzzle = new THREE.Object3D(); muzzle.position.set(0, 0.06, 0.78); gun.add(muzzle);
  g.userData = { hips, torso, headG, armL, armR, legL, legR, sword, gun, blade, muzzle };
  return g;
}

// ------------------------------------------------------------------ effects
const FX = { sparks: [], tracers: [], flashes: [] };
const sparkGeo = new THREE.SphereGeometry(0.05, 5, 5);
const sparkMats = [0xfacc15, 0xf97316, 0xffffff, 0xec4899].map((c) => new THREE.MeshBasicMaterial({ color: c }));
function sparks(p, n = 10, spread = 6, col = null) {
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(sparkGeo, col ? new THREE.MeshBasicMaterial({ color: col }) : pick(sparkMats)); m.position.copy(p); scene.add(m);
    FX.sparks.push({ m, v: new THREE.Vector3(rand(-1, 1), rand(0.2, 1.4), rand(-1, 1)).normalize().multiplyScalar(rand(2, spread)), t: rand(0.25, 0.55) });
  }
}
function tracer(a, b, col = 0xffd27a) {
  const g = new THREE.BufferGeometry().setFromPoints([a, b]);
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.9 })); scene.add(l); FX.tracers.push({ l, t: 0.09 });
}
function flash(p, col = 0xffc070, power = 14) { const l = new THREE.PointLight(col, power, 8, 2); l.position.copy(p); scene.add(l); FX.flashes.push({ l, t: 0.07 }); }
function updateFX(dt) {
  for (let i = FX.sparks.length - 1; i >= 0; i--) { const s = FX.sparks[i]; s.t -= dt; s.v.y -= 14 * dt; s.m.position.addScaledVector(s.v, dt); s.m.scale.setScalar(Math.max(0.05, s.t * 2)); if (s.t <= 0) { scene.remove(s.m); FX.sparks.splice(i, 1); } }
  for (let i = FX.tracers.length - 1; i >= 0; i--) { const s = FX.tracers[i]; s.t -= dt; s.l.material.opacity = Math.max(0, s.t / 0.09); if (s.t <= 0) { scene.remove(s.l); s.l.geometry.dispose(); FX.tracers.splice(i, 1); } }
  for (let i = FX.flashes.length - 1; i >= 0; i--) { const s = FX.flashes[i]; s.t -= dt; s.l.intensity *= 0.6; if (s.t <= 0) { scene.remove(s.l); FX.flashes.splice(i, 1); } }
}

// ------------------------------------------------------------------ fighters
const HALF = new THREE.Vector3(0.4, 0.9, 0.4);   // player AABB half extents (feet at pos.y)
const GRAV = -26, SPEED = 8.0, JUMP = 9.6, DASH = 19, STEP_UP = 0.55;
const fighters = [];
const ray = new THREE.Raycaster();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

class Fighter {
  constructor({ name, color, accent, isPlayer = false }) {
    this.name = name; this.color = color; this.isPlayer = isPlayer;
    this.mesh = humanoid(color, accent); scene.add(this.mesh);
    this.label = labelSprite(name, '#' + new THREE.Color(accent).getHexString()); this.label.position.y = 2.25; this.mesh.add(this.label);
    if (isPlayer) this.label.visible = false;
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3(); this.yaw = 0; this.pitch = 0;
    this.hp = 100; this.stam = 100; this.grounded = false; this.jumps = 0; this.wall = null; this.wallT = 0; this.wallCd = 0;
    this.dashT = 0; this.dashCd = 0; this.weapon = 'gun'; this.ammo = 12; this.reloadT = 0; this.attackT = 0; this.slashHit = false; this.fireCd = 0;
    this.dead = false; this.respawnT = 0; this.kills = 0; this.deaths = 0; this.anim = 0; this.stepT = 0; this.hurtT = 0; this.lastHitBy = null;
    this.brain = { target: null, wander: new THREE.Vector3(), wanderT: 0, losT: 0, los: false, burst: 0, burstT: 0, strafe: 1, blockedT: 0, dashCd: rand(2, 5) };
    this.spawn();
  }
  spawn() {
    const s = pick(SPAWNS); this.pos.set(s[0] + rand(-1, 1), s[1] + 0.05, s[2] + rand(-1, 1)); this.vel.set(0, 0, 0);
    this.hp = 100; this.stam = 100; this.dead = false; this.ammo = 12; this.reloadT = 0; this.attackT = 0; this.mesh.visible = true; this.mesh.rotation.set(0, 0, 0);
    this.yaw = Math.atan2(-this.pos.x, -this.pos.z); this.label.userData.draw(100);
  }
  aabb(pos = this.pos) { return { min: new THREE.Vector3(pos.x - HALF.x, pos.y, pos.z - HALF.z), max: new THREE.Vector3(pos.x + HALF.x, pos.y + HALF.y * 2, pos.z + HALF.z) }; }
  eye() { return _v.set(this.pos.x, this.pos.y + 1.55, this.pos.z).clone(); }
  forward() { return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }
  aim() { return new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch)).normalize(); }

  // input: { move: {x,z} in world space, jump: bool(edge), dash: bool(edge), attack: bool(edge), alt: bool(edge), reload: bool(edge), swap: bool(edge) }
  step(dt, input) {
    if (this.dead) { this.respawnT -= dt; this.mesh.rotation.x = Math.min(Math.PI / 2, this.mesh.rotation.x + dt * 4); this.mesh.position.y = Math.max(-1.2, this.mesh.position.y - dt * 0.6); if (this.respawnT <= 0) this.spawn(); return; }
    this.dashCd = Math.max(0, this.dashCd - dt); this.wallCd = Math.max(0, this.wallCd - dt); this.fireCd = Math.max(0, this.fireCd - dt); this.hurtT = Math.max(0, this.hurtT - dt);
    this.stam = Math.min(100, this.stam + dt * 22);
    if (this.reloadT > 0) { this.reloadT -= dt; if (this.reloadT <= 0) { this.ammo = 12; this.reloadT = 0; } }
    if (input.swap) this.weapon = this.weapon === 'gun' ? 'sword' : 'gun';
    if (input.reload && this.ammo < 12 && this.reloadT <= 0) { this.reloadT = 1.4; if (this.isPlayer) SFX.reload(); }

    // ---- horizontal motion
    const mx = input.move.x, mz = input.move.z, moving = (mx * mx + mz * mz) > 0.01;
    const accel = this.grounded ? 60 : 18;
    if (this.dashT > 0) { this.dashT -= dt; }
    else {
      this.vel.x = lerp(this.vel.x, mx * SPEED, clamp(accel * dt / SPEED, 0, 1));
      this.vel.z = lerp(this.vel.z, mz * SPEED, clamp(accel * dt / SPEED, 0, 1));
      if (!moving && this.grounded) { this.vel.x *= Math.max(0, 1 - 14 * dt); this.vel.z *= Math.max(0, 1 - 14 * dt); }
    }
    if (input.dash && this.dashCd <= 0 && this.stam >= 25) {
      const d = moving ? _v2.set(mx, 0, mz).normalize() : this.forward(); this.vel.x = d.x * DASH; this.vel.z = d.z * DASH; if (!this.grounded) this.vel.y = Math.max(this.vel.y, 1.5);
      this.dashT = 0.16; this.dashCd = 0.85; this.stam -= 25; if (this.isPlayer || this.near()) SFX.dash(); this.afterimage();
    }
    // ---- wall run: airborne, touching a wall, pushing along it
    const onWall = !this.grounded && this.wall && this.wallCd <= 0 && moving;
    if (onWall) {
      this.wallT += dt;
      if (this.wallT < 0.9) {
        const n = this.wall, t = _v3.set(-n.z, 0, n.x); if (t.x * mx + t.z * mz < 0) t.negate();
        const speed = Math.max(SPEED, Math.hypot(this.vel.x, this.vel.z)); this.vel.x = t.x * speed; this.vel.z = t.z * speed;
        this.vel.y = Math.max(this.vel.y, 0) * 0.5 + 1.2; this.jumps = 1;
      }
    } else this.wallT = 0;
    // ---- jump / double jump / wall jump
    if (input.jump) {
      if (this.grounded) { this.vel.y = JUMP; this.jumps = 1; if (this.isPlayer || this.near()) SFX.jump(); }
      else if (this.wall && this.wallCd <= 0) { const n = this.wall; this.vel.x = n.x * 9 + this.vel.x * 0.4; this.vel.z = n.z * 9 + this.vel.z * 0.4; this.vel.y = 9.5; this.jumps = 1; this.wallCd = 0.35; this.wallT = 0; if (this.isPlayer || this.near()) { SFX.jump(); SFX.wall(); } sparks(this.pos.clone().add(new THREE.Vector3(-n.x * 0.5, 1, -n.z * 0.5)), 6, 4, 0xffffff); }
      else if (this.jumps < 2) { this.vel.y = JUMP * 0.92; this.jumps = 2; if (this.isPlayer || this.near()) SFX.jump(); sparks(this.pos.clone().add(new THREE.Vector3(0, 0.2, 0)), 5, 3, 0xffffff); }
    }
    this.vel.y += GRAV * dt * (onWall && this.wallT < 0.9 ? 0.25 : 1);
    this.vel.y = Math.max(this.vel.y, -40);
    // ---- integrate + collide
    this.wall = null;
    this.moveAxis(0, this.vel.x * dt); this.moveAxis(2, this.vel.z * dt);
    const wasGrounded = this.grounded; this.grounded = false;
    this.moveAxis(1, this.vel.y * dt);
    if (this.pos.y <= 0) { this.pos.y = 0; if (this.vel.y < 0) { this.vel.y = 0; this.grounded = true; } }
    if (this.grounded) { this.jumps = 0; if (!wasGrounded && this.isPlayer) SFX.step(); }
    // ---- attacks
    if (this.attackT > 0) {
      this.attackT -= dt;
      if (this.weapon === 'sword' && !this.slashHit && this.attackT < 0.22) { this.slashHit = true; this.slashDamage(); }
    }
    const wantAttack = input.attack, wantAlt = input.alt;
    if (wantAlt) { this.weapon = this.weapon === 'gun' ? 'sword' : 'gun'; }
    if ((wantAttack || wantAlt) && this.attackT <= 0) {
      if (this.weapon === 'sword') { this.attackT = 0.42; this.slashHit = false; if (this.isPlayer || this.near()) SFX.slash(); }
      else if (this.fireCd <= 0 && this.reloadT <= 0) { if (this.ammo > 0) { this.shoot(input.aimDir); this.ammo--; this.fireCd = 0.15; this.attackT = 0.12; if (this.ammo === 0) { this.reloadT = 1.4; if (this.isPlayer) SFX.reload(); } } else { this.reloadT = 1.4; } }
    }
    // ---- footsteps
    if (this.grounded && moving && !this.dashT) { this.stepT -= dt * Math.hypot(this.vel.x, this.vel.z); if (this.stepT <= 0) { this.stepT = 2.6; if (this.isPlayer) SFX.step(); } }
    // ---- pose
    this.mesh.position.copy(this.pos); this.mesh.rotation.set(0, this.yaw, 0);
    this.pose(dt, moving);
  }
  near() { return player && this.pos.distanceTo(player.pos) < 18; }
  moveAxis(axis, d) {
    if (Math.abs(d) < 1e-6) return;
    const key = axis === 0 ? 'x' : axis === 1 ? 'y' : 'z';
    this.pos[key] += d;
    const bb = this.aabb();
    for (const c of colliders) {
      if (bb.max.x <= c.min.x || bb.min.x >= c.max.x || bb.max.y <= c.min.y || bb.min.y >= c.max.y || bb.max.z <= c.min.z || bb.min.z >= c.max.z) continue;
      if (axis === 1) {
        if (d < 0) { this.pos.y = c.max.y; this.vel.y = 0; this.grounded = true; } else { this.pos.y = c.min.y - HALF.y * 2; this.vel.y = 0; }
      } else {
        // try to step up small ledges first
        const lift = c.max.y - this.pos.y;
        if (lift > 0 && lift <= STEP_UP && this.grounded !== false) { const test = this.aabb(_v2.copy(this.pos).setY(c.max.y + 0.01)); let free = true; for (const o of colliders) { if (test.max.x <= o.min.x || test.min.x >= o.max.x || test.max.y <= o.min.y || test.min.y >= o.max.y || test.max.z <= o.min.z || test.min.z >= o.max.z) continue; free = false; break; } if (free) { this.pos.y = c.max.y + 0.01; continue; } }
        if (axis === 0) { this.pos.x = d > 0 ? c.min.x - HALF.x - 0.001 : c.max.x + HALF.x + 0.001; this.wall = new THREE.Vector3(d > 0 ? -1 : 1, 0, 0); this.vel.x = 0; }
        else { this.pos.z = d > 0 ? c.min.z - HALF.z - 0.001 : c.max.z + HALF.z + 0.001; this.wall = new THREE.Vector3(0, 0, d > 0 ? -1 : 1); this.vel.z = 0; }
      }
      break;
    }
    // arena bounds (the walls are colliders too, this is a safety net)
    this.pos.x = clamp(this.pos.x, -HW + HALF.x, HW - HALF.x); this.pos.z = clamp(this.pos.z, -HD + HALF.z, HD - HALF.z);
  }
  pose(dt, moving) {
    const u = this.mesh.userData, sp = Math.hypot(this.vel.x, this.vel.z);
    this.anim += dt * (moving ? 9 + sp * 0.4 : 3);
    const sw = moving && this.grounded ? 0.9 : (this.grounded ? 0.08 : 0.5);
    u.legL.rotation.x = Math.sin(this.anim) * sw; u.legR.rotation.x = -Math.sin(this.anim) * sw;
    u.armL.rotation.x = -Math.sin(this.anim) * sw * 0.7;
    u.hips.position.y = 0.95 + (moving && this.grounded ? Math.abs(Math.sin(this.anim)) * 0.06 : 0);
    u.hips.rotation.z = this.wall && !this.grounded ? this.wall.x * 0.35 : lerp(u.hips.rotation.z, 0, 10 * dt);
    u.torso.rotation.x = this.dashT > 0 ? -0.5 : lerp(u.torso.rotation.x, this.grounded ? 0 : -0.15, 8 * dt);
    u.sword.visible = this.weapon === 'sword'; u.gun.visible = this.weapon === 'gun';
    if (this.weapon === 'gun') { u.armR.rotation.x = -Math.PI / 2 - this.pitch * 0.8; u.armR.rotation.z = 0; if (this.attackT > 0) u.armR.rotation.x += 0.35; }
    else if (this.attackT > 0) { const k = 1 - this.attackT / 0.42; u.armR.rotation.x = -2.6 + k * 3.4; u.armR.rotation.z = -0.4 + k * 0.9; u.hips.rotation.y = 0.45 - k * 0.9; }
    else { u.armR.rotation.x = lerp(u.armR.rotation.x, -0.5 + Math.sin(this.anim) * sw * 0.4, 10 * dt); u.armR.rotation.z = lerp(u.armR.rotation.z, -0.35, 10 * dt); u.hips.rotation.y = lerp(u.hips.rotation.y, 0, 10 * dt); }
    u.headG.rotation.x = -this.pitch * 0.5;
    if (this.reloadT > 0 && this.weapon === 'gun') u.armL.rotation.x = -1.4 + Math.sin(this.reloadT * 14) * 0.3;
  }
  afterimage() {
    const ghost = this.mesh.userData.torso.clone(); ghost.material = new THREE.MeshBasicMaterial({ color: this.color, transparent: true, opacity: 0.5 });
    ghost.position.copy(this.pos).add(new THREE.Vector3(0, 1.3, 0)); ghost.scale.set(1.2, 1.3, 1.2); scene.add(ghost);
    FX.tracers.push({ l: ghost, t: 0.09 });
  }
  shoot(aimDir) {
    const from = this.eye(); const dir = aimDir ? aimDir.clone() : this.aim();
    if (!this.isPlayer) { dir.x += rand(-0.05, 0.05); dir.y += rand(-0.04, 0.04); dir.z += rand(-0.05, 0.05); dir.normalize(); }
    ray.set(from, dir); ray.far = 90;
    const hits = ray.intersectObjects(levelMeshes, false); let end = from.clone().addScaledVector(dir, hits.length ? hits[0].distance : 90);
    let victim = null, best = hits.length ? hits[0].distance : 90;
    for (const f of fighters) { if (f === this || f.dead) continue; const c = f.pos.clone().setY(f.pos.y + 1.0); const t = c.clone().sub(from).dot(dir); if (t < 0 || t > best) continue; const perp = c.sub(from.clone().addScaledVector(dir, t)).length(); if (perp < 0.75) { victim = f; best = t; } }
    if (victim) end = from.clone().addScaledVector(dir, best);
    const u = this.mesh.userData; const mz = new THREE.Vector3(); u.muzzle.getWorldPosition(mz);
    tracer(mz, end); flash(mz); if (this.isPlayer || this.near()) SFX.shot();
    if (victim) { victim.damage(19, this); sparks(end, 8, 5); } else sparks(end, 4, 3, 0xc9c9c9);
    if (this.isPlayer) { this.pitch += 0.012; recoil = 0.6; }
  }
  slashDamage() {
    const f0 = this.forward(); let any = false;
    for (const f of fighters) { if (f === this || f.dead) continue; const d = f.pos.clone().sub(this.pos); d.y = 0; const dist = d.length(); if (dist > 2.9) continue; if (d.normalize().dot(f0) < 0.45) continue; f.damage(34, this); f.vel.addScaledVector(f0, 7).y += 3; sparks(f.pos.clone().add(new THREE.Vector3(0, 1.1, 0)), 12, 7, 0xfacc15); any = true; }
    if (any && (this.isPlayer || this.near())) SFX.clang();
  }
  damage(n, by) {
    if (this.dead) return; if (this.isPlayer && GOD) n = 0; this.hp -= n; this.hurtT = 0.25; this.lastHitBy = by; this.label.userData.draw(this.hp);
    if (this.isPlayer) { $('vig').classList.add('hit'); setTimeout(() => $('vig').classList.remove('hit'), 140); SFX.hit(); }
    if (this.hp <= 0) this.die(by);
  }
  die(by) {
    this.dead = true; this.deaths++; this.respawnT = 3.0; this.hp = 0; this.mesh.rotation.x = 0.1;
    sparks(this.pos.clone().add(new THREE.Vector3(0, 1, 0)), 26, 9, this.color); if (this.isPlayer || this.near()) SFX.die();
    if (by) { by.kills++; feed(by, this); if (by.isPlayer) { $('kills').textContent = by.kills; } }
    if (this.isPlayer) { $('dead').style.display = 'grid'; $('dead-by').textContent = by ? `${by.name} took you down` : 'you fell'; }
  }
}

// ------------------------------------------------------------------ bot brain
function botThink(f, dt) {
  const b = f.brain, out = { move: { x: 0, z: 0 }, jump: false, dash: false, attack: false, alt: false, reload: false, swap: false, aimDir: null };
  if (f.dead) return out;
  // pick the nearest living enemy every so often
  b.losT -= dt;
  if (!b.target || b.target.dead || b.losT <= 0) {
    let best = null, bd = 1e9; for (const o of fighters) { if (o === f || o.dead) continue; const d = o.pos.distanceToSquared(f.pos); if (d < bd) { bd = d; best = o; } }
    b.target = best; b.losT = 0.3;
    if (best) { const from = f.eye(), dir = best.pos.clone().setY(best.pos.y + 1).sub(from); const dist = dir.length(); dir.normalize(); ray.set(from, dir); ray.far = dist; b.los = ray.intersectObjects(levelMeshes, false).length === 0; }
  }
  const t = b.target; let goal;
  if (t) {
    const to = t.pos.clone().sub(f.pos); to.y = 0; const dist = to.length(); to.normalize();
    f.yaw = Math.atan2(-to.x, -to.z) + (b.los ? 0 : 0); f.pitch = clamp(Math.atan2(t.pos.y - f.pos.y, dist), -0.6, 0.6);
    const strafe = new THREE.Vector3(-to.z, 0, to.x).multiplyScalar(b.strafe * Math.sin(perfTime * 1.7 + f.name.length));
    if (dist > 3.0) goal = to.clone().multiplyScalar(1).add(strafe.multiplyScalar(0.6)); else goal = strafe.multiplyScalar(0.8).add(to.clone().multiplyScalar(-0.2));
    if (Math.random() < dt * 0.4) b.strafe *= -1;
    // weapons
    if (dist < 3.2) { if (f.weapon !== 'sword') out.swap = true; else out.attack = Math.random() < dt * 4; }
    else if (b.los && dist < 30) {
      if (f.weapon !== 'gun') out.swap = true;
      else { b.burstT -= dt; if (b.burstT <= 0) { out.attack = true; b.burst++; if (b.burst >= 3) { b.burst = 0; b.burstT = rand(0.5, 1.1); } else b.burstT = 0.16; } out.aimDir = t.pos.clone().setY(t.pos.y + 1.0).sub(f.eye()).normalize(); }
    }
    b.dashCd -= dt; if (b.dashCd <= 0 && dist > 5 && dist < 16 && Math.random() < 0.6) { out.dash = true; b.dashCd = rand(2.5, 5); } else if (b.dashCd <= 0) b.dashCd = 1;
    if (t.pos.y > f.pos.y + 1.5 && Math.random() < dt * 1.2) out.jump = true;
  } else {
    b.wanderT -= dt; if (b.wanderT <= 0) { b.wander.set(rand(-HW + 3, HW - 3), 0, rand(-HD + 3, HD - 3)); b.wanderT = rand(2, 4); }
    const to = b.wander.clone().sub(f.pos); to.y = 0; goal = to.length() > 1 ? to.normalize() : new THREE.Vector3();
    if (goal.length()) f.yaw = Math.atan2(-goal.x, -goal.z);
  }
  if (goal) { out.move.x = goal.x; out.move.z = goal.z; }
  // stuck? hop, or wall-jump if we are on a wall
  const sp = Math.hypot(f.vel.x, f.vel.z);
  if (goal && goal.length() > 0.3 && sp < 1.5 && f.grounded) { b.blockedT += dt; if (b.blockedT > 0.35) { out.jump = true; b.blockedT = 0; } } else b.blockedT = 0;
  if (f.wall && !f.grounded && Math.random() < dt * 3) out.jump = true;
  if (f.ammo === 0 && f.reloadT <= 0) out.reload = true;
  return out;
}

// ------------------------------------------------------------------ world setup
const player = new Fighter({ name: 'Kevin', color: 0xf97316, accent: 0xfacc15, isPlayer: true });
fighters.push(player);
for (let i = 0; i < BOT_COUNT; i++) fighters.push(new Fighter({ name: `${NAMES[i % NAMES.length]} ${i + 1}`, color: TEAM_COLS[i % TEAM_COLS.length], accent: 0xffffff }));

// ------------------------------------------------------------------ input
const keys = {}; let mouseDX = 0, mouseDY = 0, mouseL = false, mouseR = false, wheel = 0, locked = false, recoil = 0, actions = 0, actionsT = 0;
const edge = { jump: false, dash: false, attack: false, alt: false, reload: false, swap: false };
const keyEl = {}; document.querySelectorAll('#keys .k').forEach((el) => { keyEl[el.dataset.k] = el; });
function setKey(code, on) { keys[code] = on; const el = keyEl[code]; if (el) el.classList.toggle('on', on); if (on) actions++; }
addEventListener('keydown', (e) => { if (e.repeat) return; setKey(e.code, true); if (e.code === 'Space') edge.jump = true; if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') edge.dash = true; if (e.code === 'KeyQ') edge.swap = true; if (e.code === 'KeyR') edge.reload = true; if (e.code === 'Space' || e.code === 'Tab') e.preventDefault(); });
addEventListener('keyup', (e) => setKey(e.code, false));
addEventListener('mousemove', (e) => { if (!locked) return; mouseDX += e.movementX; mouseDY += e.movementY; });
addEventListener('mousedown', (e) => { if (!locked) return; if (e.button === 0) { mouseL = true; edge.attack = true; setKey('MouseL', true); } if (e.button === 2) { mouseR = true; edge.alt = true; setKey('MouseR', true); } });
addEventListener('mouseup', (e) => { if (e.button === 0) { mouseL = false; setKey('MouseL', false); } if (e.button === 2) { mouseR = false; setKey('MouseR', false); } });
addEventListener('contextmenu', (e) => e.preventDefault());
addEventListener('wheel', (e) => { if (locked) edge.swap = true; }, { passive: true });
document.addEventListener('pointerlockchange', () => { locked = document.pointerLockElement === renderer.domElement; $('start').style.display = locked || DEMO ? 'none' : 'grid'; });
$('play').addEventListener('click', () => { SFX.init(); if (!DEMO) renderer.domElement.requestPointerLock(); else $('start').style.display = 'none'; });
renderer.domElement.addEventListener('click', () => { if (!locked && !DEMO && !player.dead) { SFX.init(); renderer.domElement.requestPointerLock(); } });
if (DEMO || RECORD_FPS) { $('start').style.display = 'none'; }
if (RECORD_FPS) { $('hint').style.display = 'none'; }

function playerInput(dt) {
  const inp = { move: { x: 0, z: 0 }, jump: edge.jump, dash: edge.dash, attack: edge.attack || (mouseL && player.weapon === 'gun'), alt: edge.alt, reload: edge.reload, swap: edge.swap, aimDir: null };
  for (const k in edge) edge[k] = false;
  player.yaw -= mouseDX * 0.0022; player.pitch = clamp(player.pitch - mouseDY * 0.0022, -1.2, 1.1); mouseDX = mouseDY = 0;
  const f = player.forward(), r = new THREE.Vector3(-f.z, 0, f.x);
  let ax = 0, az = 0; if (keys.KeyW) { ax += f.x; az += f.z; } if (keys.KeyS) { ax -= f.x; az -= f.z; } if (keys.KeyD) { ax += r.x; az += r.z; } if (keys.KeyA) { ax -= r.x; az -= r.z; }
  const l = Math.hypot(ax, az); if (l > 0) { ax /= l; az /= l; } inp.move.x = ax; inp.move.z = az;
  // aim through the crosshair: from the camera through the screen centre
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir); inp.aimDir = dir;
  return inp;
}

// ------------------------------------------------------------------ camera
const camPos = new THREE.Vector3(); let camShake = 0;
function updateCamera(dt) {
  const head = player.pos.clone().add(new THREE.Vector3(0, 1.55, 0));
  const back = new THREE.Vector3(Math.sin(player.yaw) * Math.cos(player.pitch), -Math.sin(player.pitch), Math.cos(player.yaw) * Math.cos(player.pitch));
  const side = new THREE.Vector3(Math.cos(player.yaw), 0, -Math.sin(player.yaw));
  const want = head.clone().addScaledVector(back, DEMO ? 6.2 : 4.8).addScaledVector(side, 0.8).add(new THREE.Vector3(0, DEMO ? 1.2 : 0.7, 0));
  ray.set(head, want.clone().sub(head).normalize()); ray.far = head.distanceTo(want);
  const hit = ray.intersectObjects(levelMeshes, false)[0];
  if (hit) want.copy(head).addScaledVector(ray.ray.direction, Math.max(0.6, hit.distance - 0.25));
  camPos.lerp(want, 1 - Math.pow(0.001, dt));
  camera.position.copy(camPos);
  const look = head.clone().addScaledVector(side, 0.7).addScaledVector(player.aim(), 6);
  camera.lookAt(look);
  recoil = Math.max(0, recoil - dt * 6); camShake = Math.max(0, camShake - dt * 4);
  camera.position.x += (Math.random() - 0.5) * (camShake + recoil * 0.2) * 0.12; camera.position.y += recoil * 0.06;
  camera.fov = lerp(camera.fov, player.dashT > 0 ? 82 : 70, 8 * dt); camera.updateProjectionMatrix();
}

// ------------------------------------------------------------------ hud
function feed(by, victim) {
  const el = document.createElement('div'); el.textContent = `${by.name} ${by.weapon === 'sword' ? '⚔' : '✦'} ${victim.name}`; if (by.isPlayer || victim.isPlayer) el.className = 'me';
  const f = $('feed'); f.prepend(el); while (f.children.length > 5) f.lastChild.remove(); setTimeout(() => el.remove(), 6000);
}
let fpsAcc = 0, fpsN = 0, gameT = 0;
function updateHUD(dt) {
  $('hp').querySelector('i').style.width = clamp(player.hp, 0, 100) + '%'; $('hp').querySelector('b').textContent = Math.max(0, Math.round(player.hp));
  $('st').querySelector('i').style.width = clamp(player.stam, 0, 100) + '%'; $('st').querySelector('b').textContent = Math.round(player.stam);
  $('ammo').textContent = player.reloadT > 0 ? '…' : player.ammo; $('ammo-l').textContent = player.reloadT > 0 ? 'reloading' : 'rounds';
  $('w-sword').classList.toggle('on', player.weapon === 'sword'); $('w-gun').classList.toggle('on', player.weapon === 'gun');
  gameT += dt; const m = Math.floor(gameT / 60), s = Math.floor(gameT % 60); $('clock').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} · ${player.deaths} death${player.deaths === 1 ? '' : 's'}`;
  actionsT += dt; if (actionsT >= 1) { $('apm').textContent = Math.round(actions * 60 / actionsT); actions = 0; actionsT = 0; }
  fpsAcc += dt; fpsN++; if (fpsAcc >= 0.5) { $('fps').textContent = Math.round(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0; }
  if (player.dead) { $('dead-t').textContent = Math.ceil(Math.max(0, player.respawnT)); } else if ($('dead').style.display === 'grid') $('dead').style.display = 'none';
  // crosshair goes hot when something is in front of the gun
  const dir = new THREE.Vector3(); camera.getWorldDirection(dir); let hot = false;
  for (const f of fighters) { if (f === player || f.dead) continue; const c = f.pos.clone().setY(f.pos.y + 1).sub(camera.position); const t = c.dot(dir); if (t > 0 && t < 60 && c.sub(dir.clone().multiplyScalar(t)).length() < 0.9) { hot = true; break; } }
  $('cross').classList.toggle('hot', hot);
}

// ------------------------------------------------------------------ post
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
if (BLOOM) composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.5, 0.9));
composer.addPass(new OutputPass());
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight); });

// ------------------------------------------------------------------ loop
let perfTime = 0;
function update(dt) {
  perfTime += dt;
  const pin = DEMO ? botThink(player, dt) : playerInput(dt);
  if (DEMO) { player.yaw = player.yaw; }
  player.step(dt, pin);
  for (const f of fighters) { if (f.isPlayer) continue; f.step(dt, botThink(f, dt)); }
  for (const f of fighters) { if (!f.isPlayer) f.label.lookAt(camera.position); }
  updateFX(dt); updateCamera(dt); updateHUD(dt);
}
const clock = new THREE.Clock(); let acc = 0; const FIXED = 1 / 120;
function frame() {
  const dt = Math.min(0.05, clock.getDelta()); acc += dt;
  while (acc >= FIXED) { update(FIXED); acc -= FIXED; }
  composer.render();
  requestAnimationFrame(frame);
}
if (RECORD_FPS) {
  // deterministic stepping for frame capture: each __step() advances exactly one output frame
  camPos.set(player.pos.x, player.pos.y + 3, player.pos.z + 6);
  window.__step = () => { const n = Math.round(120 / RECORD_FPS); for (let i = 0; i < n; i++) update(FIXED); composer.render(); return true; };
  window.__ready = true;
  for (let i = 0; i < 90; i++) update(FIXED); composer.render();
} else {
  camPos.set(player.pos.x, player.pos.y + 3, player.pos.z + 6);
  frame();
}
