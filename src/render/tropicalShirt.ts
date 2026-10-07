import { Matrix4 } from 'three';
import { MeshBuilder, S } from './builder';

type Point = [number, number, number];
type Surface = (u: number, v: number, lift?: number) => Point;

/** Body and garment use the same oval profile, with the cloth consistently outside the skin. */
function torsoSurface(a: number, y: number, cloth: boolean, lift = 0): Point {
  const chest = Math.max(0, Math.min(1, (y - 0.20) / 0.13));
  const hem = cloth ? Math.max(0, (0.08 - y) / 0.3) : 0;
  const clearance = cloth ? 0 : -0.016;
  const rx = 0.174 + chest * 0.04 + hem * 0.038 + clearance + lift;
  const rz = 0.144 + hem * 0.013 + clearance + lift;
  const shoulder = Math.max(0, Math.min(1, (y - 0.40) / 0.10));
  return [Math.sin(a) * rx, y - Math.abs(Math.sin(a)) * shoulder * 0.035, Math.cos(a) * rz];
}

/** Surface ribbons keep the thousands of individual hairs within the existing torso and arm draw calls. */
function strand(b: MeshBuilder, points: Point[], width: number, color: number) {
  const ink = S.cloth(color, 0.01);
  for (let k = 1; k < points.length; k++) {
    const a = points[k - 1], c = points[k];
    const dx = c[0] - a[0], dy = c[1] - a[1], dz = c[2] - a[2];
    const n = Math.hypot(a[0], a[2]) || 1;
    const nx = a[0] / n, nz = a[2] / n;
    const wx = -nz * dy, wy = nz * dx - nx * dz, wz = nx * dy;
    const s = width / (Math.hypot(wx, wy, wz) || 1);
    const offset = (p: Point, sign: number): Point => [p[0] + wx * s * sign, p[1] + wy * s * sign, p[2] + wz * s * sign];
    b.quad(offset(a, -1), offset(c, -1), offset(c, 1), offset(a, 1), ink);
  }
}

/** Fine curled hairs on the exposed oval surface, rather than a few isolated straight marks. */
function bodyHair(b: MeshBuilder) {
  const colors = [0x30271f, 0x3b3026, 0x49392a, 0x665443];
  for (let i = 0; i < 1550; i++) {
    const chest = i < 1100;
    const q = ((i * 0.61803398875) % 1) * 2 - 1;
    // A broad dense chest patch, with a hairy trail down the belly and scattered hairs toward its sides.
    const y = chest ? 0.255 + ((i * 0.41421356237) % 1) * 0.225 : 0.025 + ((i * 0.73205080757) % 1) * 0.23;
    const chestWidth = 0.26 + Math.sin((y - 0.255) / 0.225 * Math.PI) * 0.36;
    const a = q * (chest ? chestWidth : i % 4 === 0 ? 0.51 : 0.34);
    const len = 0.010 + ((i * 0.37) % 1) * 0.009;
    const phase = i * 2.399;
    strand(b, Array.from({ length: 5 }, (_, k) => {
      const t = k / 4;
      return torsoSurface(a + Math.sin(phase + t * 4.6) * 0.020, y + t * len - len * 0.5, false, 0.0015 + Math.sin(t * Math.PI) * 0.001);
    }), 0.00065, colors[i % colors.length]);
  }
}

/** Botanical print in the reference's navy, turquoise, lime and orange palette, built into the garment mesh. */
function print(b: MeshBuilder, at: Surface, width: number, height: number) {
  const patch = (pts: [number, number][], color: number, lift = 0.003) => {
    const area = pts.reduce((sum, p, i) => sum + p[0] * pts[(i + 1) % 4][1] - p[1] * pts[(i + 1) % 4][0], 0);
    const [a, c, d, e] = (area < 0 ? [...pts].reverse() : pts).map(([u, v]) => at(u, v, lift));
    b.quad(a, c, d, e, S.cloth(color, 0.08));
  };
  const leaf = (u: number, v: number, len: number, angle: number, color: number) => {
    const dx = Math.cos(angle) * len, dy = Math.sin(angle) * len;
    const wx = -Math.sin(angle) * len * 0.23, wy = Math.cos(angle) * len * 0.23;
    patch([[u, v], [u + dx * 0.5 + wx, v + dy * 0.5 + wy], [u + dx, v + dy], [u + dx * 0.5 - wx, v + dy * 0.5 - wy]], color);
    patch([[u, v], [u + dx * 0.45, v + dy * 0.45], [u + dx, v + dy], [u + dx * 0.47 + wx * 0.14, v + dy * 0.47 + wy * 0.14]], 0xb4c581, 0.0035);
  };
  // Staggered fronds interleaved with little spotted orange cats, like the photographed shirt.
  for (let row = 0; row < Math.ceil(height / 0.105); row++) {
    for (let col = 0; col < Math.ceil(width / 0.115); col++) {
      const u = 0.03 + col * 0.115 + (row % 2) * 0.036;
      const v = 0.045 + row * 0.105;
      if (u + 0.066 > width || v + 0.05 > height) continue;
      const angle = 0.7 + Math.sin(col * 3.1 + row * 1.9) * 1.1;
      for (let k = 0; k < 5; k++) {
        const rootU = u + Math.cos(angle) * k * 0.009;
        const rootV = v + Math.sin(angle) * k * 0.009;
        for (const side of [-1, 1]) leaf(rootU, rootV, 0.037 - k * 0.003, angle + side * 0.9, [0x249f9c, 0x5cad88, 0x2786a7, 0xb3ba4b][(k + col + row) % 4]);
      }
      const x = u + 0.037, y = v - 0.028;
      patch([[x - 0.019, y - 0.008], [x + 0.017, y - 0.011], [x + 0.025, y + 0.009], [x - 0.024, y + 0.012]], 0xe6a23b);
      leaf(x + 0.022, y + 0.002, 0.024, -0.9, 0xe18432);
      leaf(x - 0.02, y, 0.022, -2.4, 0xedb94e);
      for (let k = 0; k < 8; k++) {
        const sx = x - 0.017 + (k % 4) * 0.009;
        const sy = y - 0.005 + Math.floor(k / 4) * 0.009;
        patch([[sx - 0.0018, sy], [sx, sy - 0.002], [sx + 0.0024, sy], [sx, sy + 0.0025]], 0x382735, 0.004);
      }
      leaf(u + 0.061, v - 0.045, 0.036, 2.2, 0xca4d6c);
    }
  }
}

/** Long, fully open overshirt: the bare hairy chest and abdomen remain visible between purple-edged fronts. */
export function drawTropicalBody(b: MeshBuilder, skin: number, trim: number) {
  const bare = S.skin(skin);
  // A rounded chest, not a box: its corners must never project through the oval overshirt.
  for (let i = 0; i < 64; i++) for (let j = 0; j < 24; j++) {
    const a = i * Math.PI * 2 / 64, da = Math.PI * 2 / 64;
    const y = 0.02 + j * 0.48 / 24, dy = 0.48 / 24;
    b.quad(torsoSurface(a, y, false), torsoSurface(a + da, y, false), torsoSurface(a + da, y + dy, false), torsoSurface(a, y + dy, false), bare);
  }
  // Close the shoulder surface; the neck above it is supplied by the body rig. The fan's centre goes last: the builder takes
  // a quad's normal from its first and last corners, and a centre in both places left it zero, which shaded as a white blaze.
  for (let i = 0; i < 64; i++) {
    const a = i * Math.PI * 2 / 64, da = Math.PI * 2 / 64;
    b.quad(torsoSurface(a, 0.5, false), torsoSurface(a + da, 0.5, false), [0, 0.5, 0], [0, 0.5, 0], bare);
  }
  const gap = 0.68, width = (Math.PI * 2 - gap * 2) * 0.215, height = 0.72;
  const at: Surface = (u, v, lift = 0) => {
    return torsoSurface(gap + u / 0.215, v - 0.22, true, lift);
  };
  const cloth = S.cloth(0x143f50, 0.1);
  for (let i = 0; i < 48; i++) for (let j = 0; j < 20; j++) {
    const u = i * width / 48, v = j * height / 20;
    const a = at(u, v), c = at(u + width / 48, v), d = at(u + width / 48, v + height / 20), e = at(u, v + height / 20);
    b.quad(a, c, d, e, cloth);
    b.quad(e, d, c, a, cloth);
  }
  // Cloth over the sloping shoulders joins the collar to the sleeves, rather than leaving an open flat rim.
  for (let i = 0; i < 48; i++) {
    const a = gap + i * (Math.PI * 2 - gap * 2) / 48, da = (Math.PI * 2 - gap * 2) / 48;
    const neck = (ang: number): Point => [Math.sin(ang) * 0.067, 0.508, Math.cos(ang) * 0.067];
    b.quad(neck(a), torsoSurface(a, 0.5, true), torsoSurface(a + da, 0.5, true), neck(a + da), cloth);
  }
  print(b, at, width, height);
  const edging = S.cloth(trim, 0.08);
  for (const u of [0, width]) b.pipe(Array.from({ length: 20 }, (_, i) => at(u, height * i / 19, 0.002)), 0.006, edging, 6);
  b.pipe(Array.from({ length: 49 }, (_, i) => at(width * i / 48, 0, 0.002)), 0.005, edging, 6);
  // Folded pointed collar beside the neck, over the two fronts.
  for (const side of [-1, 1]) {
    b.quad([side * 0.042, 0.51, 0.06], [side * 0.1, 0.50, 0.09], [side * 0.14, 0.40, 0.122], [side * 0.065, 0.46, 0.125], cloth);
    b.pipe([[side * 0.042, 0.51, 0.063], [side * 0.065, 0.46, 0.128], [side * 0.14, 0.40, 0.125]], 0.004, edging, 5);
  }
  bodyHair(b);
  b.add('sphere', 0, 0.092, 0.130, 0.012, 0.017, 0.003, S.skin(0x946f54));
}

/** Dense forearm hair on the skin below Iati's rolled cuffs; follows the forearm's taper. */
export function drawTropicalArmHair(b: MeshBuilder) {
  for (let i = 0; i < 340; i++) {
    // Independent angular and height sequences avoid concentrating the hairs into one diagonal band.
    const a = i * 2.399, y = -0.012 - ((i * 0.41421356237) % 1) * 0.176;
    const len = 0.009 + (i % 7) * 0.001;
    strand(b, Array.from({ length: 4 }, (_, k) => {
      const t = k / 3, ang = a + Math.sin(i + t * 2.8) * 0.06;
      const yy = y + t * len - len * 0.5, r = 0.052 + yy * 0.04 + 0.001;
      return [Math.sin(ang) * r, yy, Math.cos(ang) * r] as Point;
    }), 0.0005, i % 3 ? 0x49392a : 0x6c5843);
  }
}

/** The same printed fabric on the sleeves, pushed up to the elbows with a purple cuff. */
export function drawTropicalSleeve(b: MeshBuilder, trim: number) {
  const width = Math.PI * 2 * 0.061, height = 0.255;
  const at: Surface = (u, v, lift = 0) => {
    const a = u / 0.061, r = 0.070 - v * 0.044 + lift;
    return [Math.sin(a) * r, -0.015 - v, Math.cos(a) * r];
  };
  b.sphereAt(0, -0.025, 0, 0.070, S.cloth(0x143f50, 0.1));
  for (let i = 0; i < 24; i++) for (let j = 0; j < 8; j++) {
    const u = i * width / 24, v = j * height / 8;
    b.quad(at(u, v + height / 8), at(u + width / 24, v + height / 8), at(u + width / 24, v), at(u, v), S.cloth(0x143f50, 0.1));
  }
  // Reverse winding for this downward-facing parameterization.
  const reverse = new MeshBuilder();
  print(reverse, at, width, height);
  for (let i = 0; i < reverse.idx.length; i += 3) [reverse.idx[i], reverse.idx[i + 2]] = [reverse.idx[i + 2], reverse.idx[i]];
  b.appendMatrix(reverse, new Matrix4());
  b.torus(0, -0.265, 0, 0.059, 0.008, S.cloth(trim, 0.08), Math.PI / 2, 0, 0, 6, 20);
}
