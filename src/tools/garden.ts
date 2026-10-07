import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { AmiratGarden, GARDEN_LAYOUT } from '../render/amiratGarden';
import { GLOBALS } from '../render/materials';

const q = new URLSearchParams(location.search);
const canvas = document.getElementById('gl') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
const scene = new THREE.Scene();
const pmrem = new THREE.PMREMGenerator(renderer);
const environment = new RoomEnvironment();
const env = pmrem.fromScene(environment, 0.04);
scene.environment = env.texture;
environment.dispose();
pmrem.dispose();
const garden = new AmiratGarden({ amirat: q.get('amirat') !== '0' });
scene.add(garden.root);
const camera = new THREE.PerspectiveCamera(43, 1, 0.05, 100);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 0.8;
controls.maxDistance = 35;
controls.maxPolarAngle = Math.PI * 0.495;
const hemi = new THREE.HemisphereLight(0xbcd4e9, 0x4c5436, 1.6);
const sun = new THREE.DirectionalLight(0xffefd0, 2.6);
sun.position.set(-5, 12, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -12;
sun.shadow.camera.right = 12;
sun.shadow.camera.top = 12;
sun.shadow.camera.bottom = -12;
sun.shadow.camera.far = 40;
sun.shadow.normalBias = 0.025;
sun.shadow.bias = -0.0002;
sun.target.position.set(0, 0, 0);
scene.add(hemi, sun, sun.target);
const porch = new THREE.PointLight(0xffe4af, 45, 16, 2);
porch.position.set(-3.2, 2.70, -3.5);
porch.castShadow = true;
porch.shadow.mapSize.set(1024, 1024);
porch.shadow.normalBias = 0.025;
scene.add(porch);
const photoFill = new THREE.PointLight(0xfff0d6, 15, 12, 2);
photoFill.position.set(-4, 2.6, -0.6);
scene.add(photoFill);
const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffeec6 }));
lamp.position.copy(porch.position);
scene.add(lamp);
// The world puts the patio 3 cm above the ground; do the same here, with the highway beyond the driveway.
const ground = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), new THREE.MeshStandardMaterial({ color: 0x8a7f62, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.03;
ground.receiveShadow = true;
scene.add(ground);
const road = new THREE.Mesh(new THREE.PlaneGeometry(90, 9), new THREE.MeshStandardMaterial({ color: 0x3b3c3d, roughness: 0.95 }));
road.rotation.x = -Math.PI / 2;
road.position.set(0, -0.025, -31.2);
road.receiveShadow = true;
scene.add(road);
const lines = new THREE.Mesh(new THREE.PlaneGeometry(90, 0.14), new THREE.MeshStandardMaterial({ color: 0xd9d3bf, roughness: 0.8 }));
lines.rotation.x = -Math.PI / 2;
lines.position.set(0, -0.022, -31.2);
scene.add(lines);

type View = 'garden' | 'photo' | 'table' | 'passage' | 'front' | 'drive';
const VIEWS = ['garden', 'photo', 'table', 'passage', 'front', 'drive'] as const;
let view: View = VIEWS.find(v => v === q.get('view')) ?? 'garden';
let daylight = q.get('light') === 'day';
let paused = q.get('paused') === '1';
garden.cover.visible = q.get('cover') !== '0';
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;

function frame(next: View) {
  view = next;
  if (view === 'photo') {
    camera.fov = 43;
    camera.position.set(GARDEN_LAYOUT.amirat[0] + 1, 2.3, GARDEN_LAYOUT.amirat[1] + 3.85);
    controls.target.set(GARDEN_LAYOUT.amirat[0], 1.02, GARDEN_LAYOUT.amirat[1] + 0.4);
  } else if (view === 'table') {
    camera.fov = 40;
    camera.position.set(-1.6, 1.75, -0.9);
    controls.target.set(0.15, 0.72, 1.05);
  } else if (view === 'drive') {
    camera.fov = 45;
    camera.position.set(-3.5, 6.5, -29);
    controls.target.set(4.2, 0.6, -15.5);
  } else if (view === 'front') {
    camera.fov = 43;
    camera.position.set(9, 7, -9);
    controls.target.set(4.9, 0.25, -12.75);
  } else if (view === 'passage') {
    camera.fov = 46;
    camera.position.set(23, 17, 4);
    controls.target.set(0, 0.5, -3.2);
  } else {
    camera.fov = 43;
    camera.position.set(13.5, 10.2, 18.5);
    controls.target.set(0, 0.5, 0.8);
  }
  camera.updateProjectionMatrix();
  controls.update();
  for (const v of VIEWS) button(v).setAttribute('aria-pressed', String(view === v));
}

function lights() {
  scene.background = new THREE.Color(daylight ? 0xb8cfcb : 0x202b31);
  scene.environmentIntensity = daylight ? 0.55 : 0.28;
  sun.intensity = daylight ? 2.8 : 0.45;
  sun.color.set(daylight ? 0xffe5bd : 0xb4cde9);
  hemi.intensity = daylight ? 1.6 : 0.7;
  porch.intensity = daylight ? 0 : 65;
  photoFill.intensity = daylight ? 0 : 22;
  lamp.visible = !daylight;
  button('light').textContent = daylight ? 'Evening' : 'Daylight';
  button('light').setAttribute('aria-pressed', String(daylight));
}

function layout() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / Math.max(1, innerHeight);
  camera.updateProjectionMatrix();
}

for (const v of VIEWS) button(v).onclick = () => frame(v);
button('light').onclick = () => { daylight = !daylight; lights(); };
button('cover').onclick = () => {
  garden.cover.visible = !garden.cover.visible;
  button('cover').textContent = garden.cover.visible ? 'Hide cover' : 'Show cover';
  button('cover').setAttribute('aria-pressed', String(!garden.cover.visible));
};
button('pause').onclick = () => {
  paused = !paused;
  button('pause').textContent = paused ? 'Resume' : 'Pause';
  button('pause').setAttribute('aria-pressed', String(paused));
};
window.addEventListener('resize', layout);
layout(); lights(); frame(view);
button('cover').textContent = garden.cover.visible ? 'Hide cover' : 'Show cover';
button('cover').setAttribute('aria-pressed', String(!garden.cover.visible));
if (paused) {
  button('pause').textContent = 'Resume';
  button('pause').setAttribute('aria-pressed', 'true');
}
let last = performance.now();
renderer.setAnimationLoop(now => {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (!paused) garden.update(dt);
  GLOBALS.uTime.value = now / 1000;
  controls.update();
  renderer.render(scene, camera);
});

declare global {
  interface Window {
    __garden?: { garden: AmiratGarden; camera: THREE.PerspectiveCamera; renderer: THREE.WebGLRenderer; frame: typeof frame; setDaylight: (on: boolean) => void; look: (from: [number, number, number], at: [number, number, number], fov?: number) => void };
  }
}
window.__garden = {
  garden, camera, renderer, frame,
  setDaylight: on => { daylight = on; lights(); },
  look: (from, at, fov = 45) => {
    camera.fov = fov;
    camera.position.set(...from);
    controls.target.set(...at);
    camera.updateProjectionMatrix();
    controls.update();
  },
};
window.addEventListener('pagehide', event => {
  // Cached pages resume with their existing scene when the user navigates back.
  if (event.persisted) return;
  renderer.setAnimationLoop(null);
  controls.dispose();
  garden.dispose();
  env.dispose();
  for (const m of [ground, road, lines]) {
    m.geometry.dispose();
    (m.material as THREE.Material).dispose();
  }
  lamp.geometry.dispose();
  (lamp.material as THREE.Material).dispose();
  renderer.dispose();
});
