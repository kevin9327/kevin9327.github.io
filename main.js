// kevin9327.github.io — the contribution calendar as a live WebGL city.
// Data comes from data/contrib.json (GitHub GraphQL contributionCalendar),
// refreshed daily by .github/workflows/refresh.yml.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const STEP = 0.62, FOOT = 0.5;
const PALETTE = {
  slab: new THREE.Color(0x1b2130),
  green: new THREE.Color(0x3fb950),
  blue: new THREE.Color(0x58a6ff),
  violet: new THREE.Color(0xa371f7),
  orange: new THREE.Color(0xf97316),
  yellow: new THREE.Color(0xfacc15),
};

const $ = (id) => document.getElementById(id);

async function loadCalendar() {
  const res = await fetch('./data/contrib.json', { cache: 'no-cache' });
  const json = await res.json();
  const cal = json.data.user.contributionsCollection.contributionCalendar;
  const days = [];
  cal.weeks.forEach((w, wi) => w.contributionDays.forEach((d) => days.push({ wi, wd: d.weekday, date: d.date, count: d.contributionCount })));
  return { total: cal.totalContributions, weeks: cal.weeks.length, days };
}

function heightFor(count, max) {
  if (count <= 0) return 0.05;
  return 0.10 + 3.2 * Math.pow(count / max, 0.45);
}

function colourFor(count, max) {
  if (count <= 0) return [PALETTE.slab, 0.08];
  const q = Math.sqrt(count / max);
  if (q < 0.22) return [PALETTE.green, 0.55];
  if (q < 0.42) return [PALETTE.blue, 0.75];
  if (q < 0.62) return [PALETTE.violet, 1.0];
  if (q < 0.82) return [PALETTE.orange, 1.25];
  return [PALETTE.yellow, 1.5];
}

function stats(days) {
  let peak = days[0], active = 0, streak = 0, best = 0;
  for (const d of days) {
    if (d.count > 0) { active++; streak++; best = Math.max(best, streak); } else streak = 0;
    if (d.count > peak.count) peak = d;
  }
  return { active, peak, best };
}

async function main() {
  const { total, weeks, days } = await loadCalendar();
  const max = Math.max(1, ...days.map((d) => d.count));
  const { active, peak, best } = stats(days);
  $('s-total').textContent = total.toLocaleString();
  $('s-days').textContent = active;
  $('s-peak').textContent = peak.count.toLocaleString();
  $('s-streak').textContent = `${best}d`;

  const GW = weeks, CX = (GW - 1) * STEP / 2, CZ = 3 * STEP;

  // ---------------------------------------------------------------- renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  $('app').appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05040c);
  scene.fog = new THREE.FogExp2(0x05040c, 0.022);

  const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 400);
  const home = new THREE.Vector3(CX - 18, 11, CZ + 26);
  camera.position.copy(home);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(CX, 0.6, CZ);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.55;
  controls.enablePan = false;
  controls.minDistance = 8;
  controls.maxDistance = 70;
  controls.maxPolarAngle = Math.PI * 0.47;

  // ---------------------------------------------------------------- lights
  scene.add(new THREE.HemisphereLight(0x6f5cff, 0x080610, 0.35));
  const key = new THREE.DirectionalLight(0xffd9b8, 1.6);
  key.position.set(CX - 20, 22, CZ - 18);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8c6cff, 1.1);
  rim.position.set(CX + 22, 14, CZ + 20);
  scene.add(rim);

  // ---------------------------------------------------------------- floor + grid
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(220, 220),
    new THREE.MeshStandardMaterial({ color: 0x07060f, metalness: 0.6, roughness: 0.35 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(CX, -0.001, CZ);
  scene.add(floor);
  const grid = new THREE.GridHelper(120, Math.round(120 / STEP), 0x5b3fd6, 0x2a1d5c);
  grid.position.set(CX, 0, CZ);
  grid.material.transparent = true;
  grid.material.opacity = 0.45;
  scene.add(grid);

  // ---------------------------------------------------------------- towers (one instanced mesh)
  const geo = new THREE.BoxGeometry(FOOT, 1, FOOT);
  geo.translate(0, 0.5, 0); // grow from the floor
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.8, metalness: 0.35, roughness: 0.4 });
  // let each instance tint its own glow, not just its diffuse colour
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )\n totalEmissiveRadiance *= vColor;\n#endif'
    );
  };
  const towers = new THREE.InstancedMesh(geo, mat, days.length);
  towers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const m = new THREE.Matrix4(), tint = new THREE.Color();
  const base = new Float32Array(days.length), amp = new Float32Array(days.length), phase = new Float32Array(days.length);
  let mx = 0, mz = 0, mass = 0;
  days.forEach((d, i) => {
    const h = heightFor(d.count, max);
    const [c, glow] = colourFor(d.count, max);
    const x = d.wi * STEP, z = (6 - d.wd) * STEP;
    base[i] = h;
    amp[i] = d.count > 0 ? 0.02 + 0.06 * Math.sqrt(d.count / max) : 0;
    phase[i] = d.wi * 0.35 + d.wd * 0.5;
    m.makeScale(1, h, 1).setPosition(x, 0, z);
    towers.setMatrixAt(i, m);
    tint.copy(c).multiplyScalar(glow);
    towers.setColorAt(i, tint);
    if (d.count > 0) { mx += x * d.count; mz += z * d.count; mass += d.count; }
  });
  towers.instanceColor.needsUpdate = true;
  scene.add(towers);

  // ---------------------------------------------------------------- light sweep across the year
  const sweep = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 1.6, 7 * STEP + 1.2),
    new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.85 })
  );
  sweep.position.set(0, -1, CZ);
  scene.add(sweep);

  // ---------------------------------------------------------------- sparks
  const P = 320;
  const pos = new Float32Array(P * 3), seed = new Float32Array(P * 3);
  const cols = new Float32Array(P * 3);
  const pal = [PALETTE.yellow, PALETTE.orange, PALETTE.violet, PALETTE.green];
  for (let i = 0; i < P; i++) {
    seed[i * 3] = Math.random() * 6.28; seed[i * 3 + 1] = Math.random() * 6.28; seed[i * 3 + 2] = Math.random();
    pos[i * 3] = -4 + Math.random() * ((GW - 1) * STEP + 8);
    pos[i * 3 + 1] = 0.3 + Math.random() * 6;
    pos[i * 3 + 2] = -4 + Math.random() * (6 * STEP + 8);
    const c = pal[i % pal.length]; cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  pg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  const sprite = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const g = c.getContext('2d'), r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.35, 'rgba(255,255,255,.6)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, 64, 64);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
  })();
  const sparks = new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.28, map: sprite, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true }));
  scene.add(sparks);

  // ---------------------------------------------------------------- bloom
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.85, 0.55, 0.72);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // ---------------------------------------------------------------- hover
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2(-9, -9), tip = $('tip');
  let hover = -1;
  addEventListener('pointermove', (e) => { mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1); tip.style.left = e.clientX + 'px'; tip.style.top = e.clientY + 'px'; });
  addEventListener('pointerleave', () => mouse.set(-9, -9));
  const fmt = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

  // ---------------------------------------------------------------- controls
  const spinBtn = $('spin');
  const setSpin = (on) => { controls.autoRotate = on; spinBtn.textContent = on ? '⏸ orbit' : '▶ orbit'; };
  spinBtn.addEventListener('click', () => setSpin(!controls.autoRotate));
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); setSpin(!controls.autoRotate); }
    if (e.key === 'r' || e.key === 'R') { camera.position.copy(home); controls.target.set(CX, 0.6, CZ); }
  });
  let idle = 0;
  renderer.domElement.addEventListener('pointerdown', () => { idle = 0; $('hint').style.opacity = 0; });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight);
  });

  $('loading').remove();

  // ---------------------------------------------------------------- loop
  const clock = new THREE.Clock();
  const LOOP = 14; // seconds per sweep
  function frame() {
    const t = clock.getElapsedTime();
    for (let i = 0; i < days.length; i++) {
      if (amp[i] === 0) continue;
      const h = base[i] + amp[i] * Math.sin(t * 1.4 + phase[i]);
      towers.getMatrixAt(i, m);
      const e = m.elements; e[5] = h; // scale y lives at [5]
      towers.setMatrixAt(i, m);
    }
    towers.instanceMatrix.needsUpdate = true;

    const u = (t % LOOP) / LOOP;
    sweep.position.x = -1 + ((GW - 1) * STEP + 2) * u;
    const s = Math.sin(Math.PI * u);
    sweep.position.y = -0.9 + 1.5 * s * s;

    const pa = pg.attributes.position.array;
    for (let i = 0; i < P; i++) {
      pa[i * 3 + 1] += Math.sin(t * 0.7 + seed[i * 3]) * 0.004;
      pa[i * 3] += Math.cos(t * 0.5 + seed[i * 3 + 1]) * 0.003;
    }
    pg.attributes.position.needsUpdate = true;

    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObject(towers, false)[0];
    const id = hit ? hit.instanceId : -1;
    if (id !== hover) {
      hover = id;
      if (id >= 0) {
        const d = days[id];
        tip.innerHTML = `<b>${d.count.toLocaleString()}</b> contribution${d.count === 1 ? '' : 's'} · ${fmt(d.date)}`;
        tip.style.display = 'block';
      } else tip.style.display = 'none';
    }

    controls.update();
    composer.render();
    requestAnimationFrame(frame);
  }
  frame();
}

main().catch((err) => {
  console.error(err);
  $('loading').textContent = 'could not load the calendar: ' + err.message;
});
