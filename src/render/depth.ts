import type * as THREE from 'three';

/**
 * Depth precision for the whole renderer, and the one place that knows which way the depth buffer runs.
 *
 * A view reaches from the first-person arms 0.2 m in front of the eye to the far plane up to 3.4 km out: 17000 to 1. A
 * conventional depth buffer (0 at the near plane, 1 at the far) spends nearly all of its precision on the first few metres:
 * at 24 bits it cannot tell apart two surfaces 7 cm apart at 500 m, or 30 cm at a kilometre, and the far roads, ledges and
 * window sills flicker through each other as the camera moves.
 *
 * So the renderer asks three for a reversed depth buffer (EXT_clip_control): 1 at the near plane, 0 at the far, and the
 * scene target stores its depth as 32-bit float. The float's exponent packs ever finer steps toward 0 just as the depth
 * values crowd there, and the two cancel: precision is about 1e-7 of the distance everywhere, a tenth of a millimetre at a
 * kilometre. The near plane can stay close for the arms with no cost far out. This is what current engines do (Unreal,
 * Frostbite, Decima all draw reversed float depth).
 *
 * Where the extension is missing three draws the conventional buffer. Everything that reads depth back goes through the
 * helpers here (`DEPTH_GLSL` in shaders, the functions below in script), which handle both.
 */
export const DEPTH = {
  /** The depth buffer is reversed (1 near, 0 far). Set once by the renderer; three then defines USE_REVERSED_DEPTH_BUFFER in every program. */
  reversed: false,
  /** The scene target keeps its depth as 32-bit float (the post chain's target; the canvas's own buffer is whatever the browser gives). */
  float: false,
};

/**
 * Depth helpers for shaders that read the depth buffer back. `nf` is the camera's (near, far). Every depth read in the post
 * chain goes through these: never compare a depth value with 1.0 or 0.0 directly.
 */
export const DEPTH_GLSL = /* glsl */ `
// View-space z (negative, ahead of the camera) of a value read from the depth buffer.
float depthViewZ( float d, vec2 nf ) {
#ifdef USE_REVERSED_DEPTH_BUFFER
  return ( nf.x * nf.y ) / ( ( nf.x - nf.y ) * d - nf.x );
#else
  return ( nf.x * nf.y ) / ( ( nf.y - nf.x ) * d - nf.y );
#endif
}
// Nothing was drawn here: the buffer still holds its cleared value (the sky does not write depth).
bool depthIsSky( float d ) {
#ifdef USE_REVERSED_DEPTH_BUFFER
  return d <= 0.0;
#else
  return d >= 1.0;
#endif
}
// The sky, or a surface within a whisker of the far plane (a few hundred metres short of it at most).
bool depthNearFar( float d ) {
#ifdef USE_REVERSED_DEPTH_BUFFER
  return d <= 1e-5;
#else
  return d >= 0.99999;
#endif
}
`;

/** View-space z (negative ahead) of a depth-buffer value, the script twin of `depthViewZ`. */
export function depthToViewZ(d: number, near: number, far: number, reversed = DEPTH.reversed): number {
  return reversed ? (near * far) / ((near - far) * d - near) : (near * far) / ((far - near) * d - far);
}

/** The depth-buffer value (0..1) a point `dist` metres ahead of the camera is stored with. */
export function viewDistToDepth(dist: number, near: number, far: number, reversed = DEPTH.reversed): number {
  return reversed ? (near * (far - dist)) / (dist * (far - near)) : (far * (dist - near)) / (dist * (far - near));
}

/** Spacing of representable float32 values around `x` (0 < x <= 1). */
function floatUlp(x: number): number {
  return 2 ** (Math.floor(Math.log2(Math.max(x, 1e-38))) - 23);
}

/**
 * The smallest gap between two surfaces, in metres along the line of sight, that the depth buffer still tells apart at
 * `dist` metres: one storage step of the depth value there, through the slope of depth against distance. `bits` is the
 * width of a fixed-point buffer; `float` a 32-bit float one.
 */
export function depthResolution(dist: number, near: number, far: number, o: { reversed: boolean; float: boolean; bits?: number }): number {
  const d = viewDistToDepth(dist, near, far, o.reversed);
  const step = o.float ? floatUlp(o.reversed ? d : Math.max(d, 1e-30)) : 2 ** -(o.bits ?? 24);
  const slope = (far * near) / ((far - near) * dist * dist);
  return step / slope;
}

/**
 * Polygon offset for a surface drawn flush on another: a sign or a poster on a wall, a road on the ground, a decal on the
 * road. Level 1 wins over the bare surface it lies on, each level over the ones below it, so a stack of details always
 * draws in the same order however far away it is. The slope term does the work at grazing angles; the constant term is
 * the floor. Keep details lifted off their surface by a few millimetres as well: an offset hides small gaps, not big ones.
 */
export const COPLANAR = {
  /** Shopfronts, signs, posters, glass in a frame: on a wall or a pane's frame. */
  detail: 1,
  /** Roads, pavements and anything laid flat on the terrain. */
  ground: 2,
  /** Bullet holes, blood, scorch on a wall or the road. */
  decal: 3,
  /** Tyre tracks and wet marks over decals and roads. */
  mark: 4,
} as const;

/** Set a material's polygon offset for a coplanar level (see `COPLANAR`). Negative pulls toward the eye in either depth mode. */
export function coplanarOffset<T extends THREE.Material>(m: T, level: number): T {
  m.polygonOffset = level > 0;
  m.polygonOffsetFactor = -level;
  m.polygonOffsetUnits = -2 * level;
  return m;
}

/**
 * three negates a polygon offset's slope factor for a reversed depth buffer but not its constant units, so a negative
 * offset (meant to pull a decal toward the eye) pushed it away under reversed depth and buried it. Negate the units in the
 * one place every offset passes through, so `polygonOffsetUnits` means the same thing in both modes.
 */
export function fixReversedPolygonOffset(gl: WebGL2RenderingContext | WebGLRenderingContext) {
  const ctx = gl as WebGL2RenderingContext & { __offsetFixed?: boolean };
  if (ctx.__offsetFixed) return;
  ctx.__offsetFixed = true;
  const raw = ctx.polygonOffset.bind(ctx);
  ctx.polygonOffset = (factor: number, units: number) => raw(factor, -units);
}

/**
 * Depth pull, the offset for flat things laid on flat things far away: the vertex is drawn nearer the eye along its own line
 * of sight by a fraction of its distance (`depthPullGlsl`). The picture does not move (x and y keep their ratio to z), only
 * the depth it is tested with, so it is a depth offset that holds the same at every distance; a polygon offset's constant
 * term shrinks to nothing in a float buffer, and its slope term to nothing face on.
 *
 * Levels stack like `COPLANAR`: each is one `pullStep` of the distance nearer than the level below. Roads start at level 1
 * and each road crossing over others goes one up (`roadPull`); marks that lie on roads sit above every road layer.
 */
export const PULL = {
  /** A road on the terrain; a road crossing over n others is at `road + n`. */
  road: 1,
  /** Blood, bullet holes and scorch on the ground, roads and walls. */
  decal: 6,
  /** Tyre tracks over all of it. */
  mark: 7,
} as const;

/**
 * One pull level as a fraction of the distance: 5 cm per level at a kilometre with float depth (it only has to beat the
 * terrain's triangles bulging through a road), 20 cm with the conventional buffer, which cannot resolve less out there.
 */
export function pullStep(reversed = DEPTH.reversed): number {
  return reversed ? 5e-5 : 2e-4;
}

/** The pull of an open-world road crossing over `layer` others (`roadLayer`), as a fraction of its distance. */
export function roadPull(layer: number, reversed = DEPTH.reversed): number {
  return (PULL.road + layer) * pullStep(reversed);
}

/** Shared uniforms for shaders that pull: `uPullStep` is one level's fraction (set by the renderer for its depth mode). */
export const DEPTH_UNIFORMS = {
  uPullStep: { value: pullStep(false) },
};

/** Vertex snippet, after `#include <project_vertex>` (it needs `mvPosition`): pull by `levels` steps of `uPullStep`. */
export function depthPullGlsl(levels: string): string {
  return /* glsl */ `
  mvPosition.xyz *= 1.0 - uPullStep * ( ${levels} );
  gl_Position = projectionMatrix * mvPosition;
`;
}
