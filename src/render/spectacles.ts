import { MeshBuilder, S } from './builder';
import type { PortraitSpec } from './portrait';

/** Clear rectangular frames in the portrait's head-local coordinates. */
export function drawGlasses(b: MeshBuilder, spec: PortraitSpec, frame: number, rounded = false) {
  const s = spec.shape, y = s.eyeY + 0.001, z = s.eyeZ + 0.026;
  const rim = S.plastic(frame, 0.05);
  // Open, clear lenses keep the eyes visible; thin corner glints suggest the glass without an opaque plate.
  for (const side of [-1, 1]) {
    const x = side * (s.eyeX + 0.004), w = 0.027, h = rounded ? 0.0185 : 0.021;
    const pts: [number, number, number][] = [[x - w + 0.004, y + h, z], [x + w - 0.004, y + h, z], [x + w, y + h - 0.004, z], [x + w - 0.002, y - h + 0.005, z], [x + w - 0.006, y - h, z], [x - w + 0.006, y - h, z], [x - w + 0.002, y - h + 0.005, z], [x - w, y + h - 0.004, z], [x - w + 0.004, y + h, z]];
    if (rounded) {
      pts.length = 0;
      const r = 0.007;
      for (let corner = 0; corner < 4; corner++) {
        const sx = corner === 0 || corner === 3 ? 1 : -1;
        const sy = corner < 2 ? 1 : -1;
        for (let i = 0; i <= 5; i++) {
          const a = (corner + i / 5) * Math.PI / 2;
          pts.push([x + sx * (w - r) + Math.cos(a) * r, y + sy * (h - r) + Math.sin(a) * r, z]);
        }
      }
      pts.push(pts[0]);
    }
    b.pipe(pts, 0.0028, rim, 6);
    b.capsule(x + side * w, y + h - 0.005, z, side * (s.halfW + 0.006), y + 0.012, s.eyeZ + s.ear.z + 0.005, 0.003, rim, 6);
    b.pipe([[x - w + 0.007, y + h - 0.006, z + 0.001], [x - w + 0.012, y + h - 0.005, z + 0.001]], 0.0008, S.glass(0xb8d6db), 4);
  }
  b.pipe([[-0.011, y + 0.012, z], [0, y + 0.016, z + 0.001], [0.011, y + 0.012, z]], 0.0024, rim, 6);
}
