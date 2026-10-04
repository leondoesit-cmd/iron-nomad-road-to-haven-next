import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { HERO_IDS, isHero, type HeroId } from '../data/heroes';
import { Humanoid, type Palette } from '../render/humanoid';
import { HERO_LOOKS } from '../render/heroLooks';
import { TEX_H, TEX_W, paintPortraitNow } from '../render/portrait';
import { identityOf, lookOf } from '../render/outfit';
import { heroLoadout } from '../game/campaign';
import { newGear, type Loadout } from '../sim/gear';

/**
 * A close look at the two heroes, outside the game: their faces under even light, turned to any angle, in any of a few
 * outfits, optionally beside the photograph they were drawn from.
 *
 * Open /portrait.html on the dev server. Query parameters (also settable from the console with `__portrait.set({...})`):
 *   hero  chinsky | leo | both         view  close | face | bust | body  yaw  degrees (0 faces the camera)
 *   kit   start | own | helmet | cap | goggles | gasmask                 light studio | sun
 *   ref   URL of a reference photo to show alongside                     ui    0 hides the buttons
 */

interface Params {
  hero: HeroId | 'both';
  view: 'close' | 'face' | 'bust' | 'body';
  yaw: number;
  kit: 'start' | 'own' | 'helmet' | 'cap' | 'goggles' | 'gasmask';
  light: 'studio' | 'sun';
  ref: string;
  ui: boolean;
}

const q = new URLSearchParams(location.search);
const params: Params = {
  hero: isHero(q.get('hero')) ? (q.get('hero') as HeroId) : q.get('hero') === 'both' ? 'both' : 'leo',
  view: (['close', 'face', 'bust', 'body'] as const).find((v) => v === q.get('view')) ?? 'face',
  yaw: Number(q.get('yaw') ?? 0),
  kit: (['start', 'own', 'helmet', 'cap', 'goggles', 'gasmask'] as const).find((v) => v === q.get('kit')) ?? 'start',
  light: q.get('light') === 'sun' ? 'sun' : 'studio',
  ref: q.get('ref') ?? '',
  ui: q.get('ui') !== '0',
};

const canvas = document.getElementById('gl') as HTMLCanvasElement;
const refImg = document.getElementById('ref') as HTMLImageElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2520);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
const hemi = new THREE.HemisphereLight(0xfff4e6, 0x6a5848, 0.6);
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -1.5;
sun.shadow.camera.right = 1.5;
sun.shadow.camera.top = 2.2;
sun.shadow.camera.bottom = -0.2;
sun.shadow.bias = -0.0003;
sun.shadow.normalBias = 0.01;
scene.add(hemi, sun, sun.target);
const floor = new THREE.Mesh(new THREE.CircleGeometry(4, 48), new THREE.MeshStandardMaterial({ color: 0x4a4038, roughness: 0.95 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = false;
controls.addEventListener('change', () => render());

function outfit(kit: Params['kit']): Loadout['worn'] {
  const l = heroLoadout();
  const w = { ...l.worn };
  switch (kit) {
    case 'own':
      return {};
    case 'helmet':
      return { ...w, head: newGear('h_scrap') };
    case 'cap':
      return { ...w, head: newGear('h_cap') };
    case 'goggles':
      return { ...w, face: newGear('f_goggles') };
    case 'gasmask':
      return { ...w, face: newGear('f_gas') };
    default:
      return w;
  }
}

let people: { id: HeroId; h: Humanoid }[] = [];

function build() {
  for (const p of people) scene.remove(p.h.root);
  const ids = params.hero === 'both' ? [...HERO_IDS] : [params.hero];
  people = ids.map((id, i) => {
    // Seats as in split screen: Chinsky is player 1 (left), Leo player 2 (right).
    const seat = id === 'chinsky' ? 0 : 1;
    const pal: Palette = { ...identityOf(seat), look: lookOf(outfit(params.kit)), hero: id };
    const h = new Humanoid(pal);
    h.update(0.016, 'stand', 0, 0, 0);
    h.root.position.x = ids.length > 1 ? (i === 0 ? -0.45 : 0.45) : 0;
    h.root.rotation.y = (params.yaw * Math.PI) / 180;
    h.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
    });
    scene.add(h.root);
    return { id, h };
  });
  frame();
}

/** Point the camera at the face, the bust or the whole body of whoever is shown. */
function frame() {
  // The middle of the head, wherever the pose has put it.
  const head = new THREE.Vector3();
  for (const p of people) {
    p.h.root.updateMatrixWorld(true);
    head.add(new THREE.Vector3(0, 0.1, 0.01).applyMatrix4(p.h.head.matrixWorld));
  }
  head.divideScalar(people.length);
  const t = head.clone();
  let dist = 1.05;
  let fov = 24;
  if (params.view === 'close') {
    t.y += 0.005;
    dist = 0.5;
  } else if (params.view === 'bust') {
    t.y -= 0.22;
    dist = 1.6;
  } else if (params.view === 'body') {
    t.y = 0.95 * Math.max(...people.map((p) => HERO_LOOKS[p.id].scale));
    dist = 3.6;
    fov = 34;
  }
  if (params.hero === 'both' && params.view === 'face') dist = 1.9;
  camera.fov = fov;
  camera.position.set(t.x, t.y + (params.view === 'body' ? 0.25 : 0.02), t.z + dist);
  controls.target.copy(t);
  controls.update();
  lights();
  layout();
}

function lights() {
  if (params.light === 'sun') {
    // Late-afternoon desert: a low warm sun to one side and a bright sky.
    sun.color.set(0xffe2b8);
    sun.intensity = 2.6;
    sun.position.set(-2.2, 2.6, 2.0);
    hemi.color.set(0xcfe0ff);
    hemi.groundColor.set(0x8a6a48);
    hemi.intensity = 0.55;
    scene.environmentIntensity = 0.5;
  } else {
    // Studio: a key light high and to the left at the game's sun strength, and a fill about as strong as the game's sky.
    sun.color.set(0xffffff);
    sun.intensity = 2.0;
    sun.position.set(-1.2, 3.0, 2.8);
    hemi.color.set(0xfff4e6);
    hemi.groundColor.set(0x6a5848);
    hemi.intensity = 0.45;
    scene.environmentIntensity = 0.4;
  }
  sun.target.position.set(0, 1.4, 0);
}

function layout() {
  refImg.style.display = params.ref ? 'block' : 'none';
  if (params.ref && refImg.getAttribute('src') !== params.ref) refImg.src = params.ref;
  const w = canvas.parentElement!.clientWidth * (params.ref ? 0.5 : 1);
  const h = canvas.parentElement!.clientHeight;
  renderer.setSize(w, h, false);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
  render();
}

function render() {
  renderer.render(scene, camera);
}

// ------------------------------------------------------------------------------------------ buttons

const bar = document.getElementById('bar')!;
function buttons() {
  bar.classList.toggle('hide', !params.ui);
  const groups: [keyof Params, (string | number)[]][] = [
    ['hero', ['chinsky', 'leo', 'both']],
    ['view', ['close', 'face', 'bust', 'body']],
    ['yaw', [0, 35, 90, 180, -35]],
    ['kit', ['start', 'own', 'helmet', 'cap', 'goggles', 'gasmask']],
    ['light', ['studio', 'sun']],
  ];
  bar.innerHTML = '';
  for (const [key, opts] of groups) {
    for (const o of opts) {
      const b = document.createElement('button');
      b.textContent = `${key === 'yaw' ? '' : ''}${o}`;
      b.className = params[key] === o ? 'on' : '';
      b.onclick = () => set({ [key]: o } as Partial<Params>);
      bar.appendChild(b);
    }
  }
}

function set(p: Partial<Params>) {
  Object.assign(params, p);
  buttons();
  build();
}

/**
 * Show the painted texture of a hero's head over the view, cropped to [u0, v0, u1, v1] (the face is round u 0.5), at
 * `scale` screen pixels per texel. Paints it here first if the worker has not finished yet.
 */
function showTexture(id: HeroId, crop: [number, number, number, number] = [0.35, 0.3, 0.65, 0.72], scale = 1) {
  const data = paintPortraitNow(HERO_LOOKS[id].portrait);
  const [u0, v0, u1, v1] = crop;
  const x0 = Math.floor(u0 * TEX_W);
  const x1 = Math.ceil(u1 * TEX_W);
  const y0 = Math.floor(v0 * TEX_H);
  const y1 = Math.ceil(v1 * TEX_H);
  const c = document.createElement('canvas');
  c.width = x1 - x0;
  c.height = y1 - y0;
  const g = c.getContext('2d')!;
  const img = g.createImageData(c.width, c.height);
  // Texture rows run bottom to top; the canvas runs top to bottom. Alpha (roughness) is shown opaque.
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      const s = ((y1 - 1 - y) * TEX_W + (x0 + x)) * 4;
      const d = (y * c.width + x) * 4;
      img.data[d] = data[s];
      img.data[d + 1] = data[s + 1];
      img.data[d + 2] = data[s + 2];
      img.data[d + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  c.style.cssText = `position:absolute;right:0;top:0;width:${c.width * scale}px;height:${c.height * scale}px;image-rendering:pixelated;z-index:5`;
  c.id = 'texview';
  document.getElementById('texview')?.remove();
  document.body.appendChild(c);
}

declare global {
  interface Window {
    __portrait?: { set: typeof set; params: Params; render: typeof render; people: () => typeof people; showTexture: typeof showTexture };
  }
}
window.__portrait = { set, params, render, people: () => people, showTexture };
window.addEventListener('resize', layout);
buttons();
{
  // What the heads cost: sculpting the meshes on build, painting the textures on the first draw.
  const t0 = performance.now();
  build();
  const t1 = performance.now();
  render();
  console.info(`portrait: build ${(t1 - t0).toFixed(0)} ms, first draw ${(performance.now() - t1).toFixed(0)} ms`);
}
// Keep drawing, so the page always has a fresh frame to show (and to screenshot).
const loop = () => {
  render();
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);
