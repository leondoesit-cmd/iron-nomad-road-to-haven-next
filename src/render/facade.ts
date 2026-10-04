import * as THREE from 'three';
import { KIT } from './materials';
import { grungeTexture, macroTexture, terrainTextures } from './proctex';

/**
 * Procedural building facades. Each wall quad carries metre UVs (u along the wall, v up) and a style
 * vector, and the shader draws everything else per pixel: the window grid, frames and sills, brick or
 * concrete panels, a ground-floor shop band, grime and soot. Windows use interior mapping (a ray traced
 * into a box room behind the glass), so the city has depth without a single extra triangle; some rooms are
 * lit at night. Styles: 0 concrete panel, 1 brick, 2 stucco, 3 glass curtain wall.
 */

const VERT_PARS = /* glsl */ `
attribute vec4 fdata;
varying vec2 vFUv;
varying vec4 vFData;
varying vec3 vFWPos;
varying vec3 vFWN;
`;

const VERT_MAIN = /* glsl */ `
vFUv = uv;
vFData = fdata;
vFWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vFWN = normalize( mat3( modelMatrix ) * objectNormal );
`;

const FRAG_PARS = /* glsl */ `
varying vec2 vFUv;
varying vec4 vFData;
varying vec3 vFWPos;
varying vec3 vFWN;
uniform sampler2D tGrungeF;
uniform sampler2D tMacroF;
uniform sampler2D tCrack;
uniform float uGlowF;
float fHash( vec2 p ) {
  vec3 p3 = fract( vec3( p.xyx ) * 0.1031 );
  p3 += dot( p3, p3.yzx + 33.33 );
  return fract( ( p3.x + p3.y ) * p3.z );
}
`;

const FRAG_COLOR = /* glsl */ `
#include <color_fragment>
vec2 fUv = vFUv;
float fStyleRaw = vFData.x;
// Styles 10 and up are the plain variants: no painted windows (real openings are cut in the geometry).
float fPlain = step( 9.5, fStyleRaw );
float fStyle = fStyleRaw - 10.0 * fPlain;
float fSeed = vFData.y;
float fFloor = vFData.z;
float fCellW = vFData.w;
float fGround = fFloor * 1.3;
bool fShop = fPlain < 0.5 && fUv.y < fGround;
vec2 fCell = vec2( fUv.x / fCellW, ( fUv.y - fGround ) / fFloor );
vec2 fCi = floor( fCell );
vec2 fCf = fract( fCell );
float fH1 = fHash( fCi + fSeed * 17.31 );
float fH2 = fHash( fCi.yx * 1.7 + fSeed * 5.13 + 3.1 );
float fH3 = fHash( fCi * 2.3 + fSeed * 9.7 + 11.0 );
// Window rectangle inside the cell, per style.
vec4 fWin = fStyle < 0.5 ? vec4( 0.2, 0.26, 0.8, 0.82 ) : fStyle < 1.5 ? vec4( 0.28, 0.2, 0.72, 0.8 ) : fStyle < 2.5 ? vec4( 0.32, 0.28, 0.68, 0.8 ) : vec4( 0.04, 0.06, 0.96, 0.96 );
float fInX = step( fWin.x, fCf.x ) * step( fCf.x, fWin.z );
float fInY = step( fWin.y, fCf.y ) * step( fCf.y, fWin.w );
float fIn = ( fShop || fPlain > 0.5 ) ? 0.0 : fInX * fInY;
// Frame and sill band around each window.
vec2 fFr = vec2( 0.035 * 3.0 / fCellW, 0.035 * 3.3 / fFloor );
float fFrame = ( fShop || fPlain > 0.5 ) ? 0.0 : ( step( fWin.x - fFr.x, fCf.x ) * step( fCf.x, fWin.z + fFr.x ) * step( fWin.y - fFr.y, fCf.y ) * step( fCf.y, fWin.w + fFr.y ) ) * ( 1.0 - fIn );
float fSill = ( fShop || fPlain > 0.5 ) ? 0.0 : step( fWin.x - fFr.x * 2.0, fCf.x ) * step( fCf.x, fWin.z + fFr.x * 2.0 ) * step( fWin.y - fFr.y * 3.0, fCf.y ) * step( fCf.y, fWin.y - fFr.y );
float fBroken = step( 0.78, fH1 );
float fBoard = step( 0.86, fH2 ) * ( 1.0 - fBroken );
float fLit = step( 0.8, fH3 ) * ( 1.0 - fBroken ) * ( 1.0 - fBoard );
float fCurtain = step( 0.55, fH2 ) * ( 1.0 - fBoard );
vec4 fG = texture2D( tGrungeF, vec2( vFWPos.x + vFWPos.z, vFWPos.y ) * 0.35 );
vec4 fM = texture2D( tMacroF, vec2( vFWPos.x + vFWPos.z, vFWPos.y ) * 0.02 + fSeed );
// Wall material.
vec3 fWall = diffuseColor.rgb;
float fRough = 0.9;
if ( fStyle < 0.5 ) {
  // Precast concrete panels with joints at every floor and cell.
  vec2 pj = abs( fract( vec2( fUv.x / ( fCellW * 2.0 ), fUv.y / fFloor ) + 0.5 ) - 0.5 ) * vec2( fCellW * 2.0, fFloor );
  float joint = 1.0 - smoothstep( 0.015, 0.035, min( pj.x, pj.y ) );
  fWall *= 1.0 - joint * 0.35;
  fWall *= 0.92 + fHash( floor( vec2( fUv.x / ( fCellW * 2.0 ), fUv.y / fFloor ) ) + fSeed ) * 0.14;
} else if ( fStyle < 1.5 ) {
  // Running-bond brick.
  vec2 bs = vec2( 0.25, 0.075 );
  vec2 bc = fUv / bs;
  bc.x += step( 1.0, mod( floor( bc.y ), 2.0 ) ) * 0.5;
  vec2 bf = fract( bc );
  vec2 bi = floor( bc );
  float mortar = 1.0 - smoothstep( 0.0, 0.08, min( min( bf.x, 1.0 - bf.x ) * bs.x / bs.y, min( bf.y, 1.0 - bf.y ) ) );
  float tone = fHash( bi + fSeed );
  fWall *= mix( 0.78 + tone * 0.3, 1.25, mortar );
} else if ( fStyle < 2.5 ) {
  // Stucco: blotchy render with cracks.
  fWall *= 0.9 + fM.r * 0.2;
  float crack = 1.0 - texture2D( tCrack, fUv * 0.12 ).b;
  fWall *= 1.0 - smoothstep( 0.55, 0.85, crack ) * 0.35;
} else if ( fStyle < 3.5 ) {
  // Curtain wall: spandrel panels between floors, mullions on the grid.
  fWall = mix( fWall * 0.55, vec3( 0.05, 0.07, 0.08 ), 0.4 );
  fRough = 0.35;
} else if ( fStyle < 4.5 ) {
  // Weatherboard siding: shadow lines under each board, faded paint, bare wood showing through.
  float bd = fUv.y / 0.16;
  float bf = fract( bd );
  float bt = fHash( vec2( floor( bd ), floor( fUv.x / 2.4 ) + fSeed ) );
  fWall *= 0.88 + bt * 0.2;
  fWall *= mix( 0.7, 1.0, smoothstep( 0.0, 0.2, bf ) );
  float bare = smoothstep( 0.78, 0.95, fM.g + fG.r * 0.3 + bt * 0.12 );
  fWall = mix( fWall, vec3( 0.46, 0.37, 0.28 ) * ( 0.8 + bt * 0.3 ), bare * 0.4 );
} else if ( fStyle < 5.5 ) {
  // Interior wall: plaster over a wainscot, chair rail and skirting, damp creeping up from the floor.
  float v = fUv.y;
  fWall *= 1.18 * ( 0.92 + fM.r * 0.16 );
  float wain = 1.0 - smoothstep( 1.0, 1.04, v );
  fWall = mix( fWall, fWall * vec3( 0.82, 0.86, 0.84 ), wain );
  float rail = smoothstep( 0.035, 0.0, abs( v - 1.04 ) );
  fWall = mix( fWall, fWall * 1.25, rail );
  float skirt = 1.0 - smoothstep( 0.1, 0.12, v );
  fWall = mix( fWall, fWall * 0.55, skirt );
  float stripe = step( 0.5, fract( fUv.x / 0.24 + fSeed ) ) * step( 0.5, fHash( vec2( floor( fSeed * 7.0 ), 1.0 ) ) ) * ( 1.0 - wain );
  fWall *= 1.0 - stripe * 0.05;
  float damp2 = smoothstep( 0.4, 0.95, fG.r * 0.6 + fM.g * 0.5 ) * ( 1.0 - smoothstep( 0.0, 1.6, v ) );
  fWall *= 1.0 - damp2 * 0.2;
  float stain = smoothstep( 0.66, 0.85, fG.a + fM.b * 0.3 ) * 0.5;
  fWall *= 1.0 - stain * 0.2;
} else if ( fStyle < 6.5 ) {
  // Corrugated sheet metal, rusted along the seams.
  float rib = abs( fract( fUv.x / 0.1 ) - 0.5 );
  fWall *= 0.78 + rib * 0.55;
  fRough = 0.52;
  float rust = smoothstep( 0.52, 0.75, fM.g + fG.r * 0.45 + ( 1.0 - smoothstep( 0.0, 1.2, fUv.y ) ) * 0.25 );
  fWall = mix( fWall, vec3( 0.42, 0.22, 0.12 ) * ( 0.7 + fM.r * 0.5 ), rust * 0.4 );
  float sheet = abs( fract( fUv.x / 0.9 + fSeed ) - 0.5 );
  fWall *= 1.0 - smoothstep( 0.46, 0.5, sheet ) * 0.3;
} else if ( fStyle < 7.5 ) {
  // Floorboards.
  float pr = fUv.y / 0.14;
  float prow = floor( pr );
  float pu = fUv.x / 1.5 + fHash( vec2( prow, fSeed ) ) * 7.0;
  float pt = fHash( vec2( prow, floor( pu ) + fSeed * 3.0 ) );
  fWall *= 0.74 + pt * 0.4;
  float seam = min( min( fract( pr ), 1.0 - fract( pr ) ) * 0.14, min( fract( pu ), 1.0 - fract( pu ) ) * 1.5 );
  fWall *= mix( 0.45, 1.0, smoothstep( 0.0, 0.006, min( min( fract( pr ), 1.0 - fract( pr ) ) * 0.14, 0.2 ) ) );
  fWall *= mix( 0.6, 1.0, smoothstep( 0.0, 0.012, min( fract( pu ), 1.0 - fract( pu ) ) * 1.5 ) );
  fWall *= 0.85 + fM.g * 0.3;
  fWall *= 1.0 - smoothstep( 0.6, 0.85, fG.r + fM.b * 0.4 ) * 0.4;
  fRough = 0.7;
} else if ( fStyle < 8.5 ) {
  // Square tiles with grout, a few cracked or missing.
  vec2 tc = fUv / 0.3;
  vec2 tf = abs( fract( tc ) - 0.5 );
  float grout = step( 0.465, max( tf.x, tf.y ) );
  float tt = fHash( floor( tc ) + fSeed );
  fWall *= 0.82 + tt * 0.26;
  fWall = mix( fWall, vec3( 0.32, 0.3, 0.27 ), grout );
  fWall *= 1.0 - smoothstep( 0.7, 0.9, fG.r + fM.b * 0.4 ) * 0.35;
  fRough = 0.35 + grout * 0.5;
} else {
  // Poured concrete floor: mottled, with cracks and saw joints.
  fWall *= 0.82 + fM.r * 0.3;
  float crack = 1.0 - texture2D( tCrack, fUv * 0.25 ).b;
  fWall *= 1.0 - smoothstep( 0.55, 0.85, crack ) * 0.4;
  vec2 jf = abs( fract( fUv / 2.4 ) - 0.5 );
  fWall *= 1.0 - step( 0.492, max( jf.x, jf.y ) ) * 0.25;
  fWall *= 1.0 - smoothstep( 0.62, 0.85, fG.r + fM.b * 0.5 ) * 0.3;
  fRough = 0.88;
}
// Ground floor shops: a sign band, a big window or a rolling shutter per bay.
vec3 fCol = fWall;
float fGlass = 0.0;
float fShopLit = 0.0;
if ( fShop ) {
  float bay = floor( fUv.x / ( fCellW * 2.0 ) );
  float bf2 = fract( fUv.x / ( fCellW * 2.0 ) );
  float hb = fHash( vec2( bay, fSeed * 3.7 ) );
  float band = step( fGround - 0.95, fUv.y ) * step( fUv.y, fGround - 0.25 );
  vec3 signCol = 0.5 + 0.5 * cos( 6.2831 * ( hb + vec3( 0.0, 0.33, 0.67 ) ) );
  float opening = step( 0.06, bf2 ) * step( bf2, 0.94 ) * step( 0.12, fUv.y ) * step( fUv.y, fGround - 1.15 );
  if ( band > 0.5 ) {
    fCol = mix( fWall * 0.6, signCol * 0.45, step( 0.25, hb ) );
  } else if ( opening > 0.5 ) {
    if ( hb < 0.45 ) {
      // Rolling shutter, corrugated.
      float rib = abs( fract( fUv.y * 9.0 ) - 0.5 );
      fCol = vec3( 0.32, 0.33, 0.34 ) * ( 0.75 + rib * 0.5 );
      fRough = 0.55;
      // Graffiti blotches.
      fCol = mix( fCol, signCol * 0.5, smoothstep( 0.62, 0.72, fM.g + fG.r * 0.2 ) * 0.7 );
    } else {
      fGlass = hb < 0.8 ? 1.0 : 0.5;
      fShopLit = step( 0.9, hb );
    }
  }
}
// Window contents: interior-mapped rooms behind glass, boards, or a dark hole.
vec3 fRoom = vec3( 0.0 );
if ( fIn > 0.5 || fGlass > 0.0 ) {
  vec3 N = normalize( vFWN );
  vec3 T = normalize( cross( vec3( 0.0, 1.0, 0.0 ), N ) );
  // Camera-relative: vFWPos - cameraPosition loses precision far from the origin and the ray shimmers into noise.
  vec3 V = inverseTransformDirection( - normalize( vViewPosition ), viewMatrix );
  vec3 rd = vec3( dot( V, T ), V.y, -dot( V, N ) );
  float roomW = fShop ? fCellW * 2.0 : fCellW;
  float roomH = fShop ? fGround : fFloor;
  vec2 lp = fShop ? vec2( fract( fUv.x / roomW ), fUv.y / roomH ) : fCf;
  vec3 ro = vec3( lp.x * roomW, lp.y * roomH, 0.0 );
  float depth = 3.6;
  vec3 tb = vec3( ( rd.x > 0.0 ? roomW - ro.x : -ro.x ) / ( abs( rd.x ) < 1e-4 ? 1e-4 : rd.x ), ( rd.y > 0.0 ? roomH - ro.y : -ro.y ) / ( abs( rd.y ) < 1e-4 ? 1e-4 : rd.y ), depth / max( rd.z, 1e-4 ) );
  float t = min( min( tb.x, tb.y ), tb.z );
  vec3 hp = ro + rd * t;
  float roomSeed = fHash( fCi + fSeed * 3.3 );
  vec3 wallC = mix( vec3( 0.42, 0.38, 0.32 ), vec3( 0.3, 0.34, 0.36 ), roomSeed );
  if ( t == tb.y ) fRoom = rd.y > 0.0 ? vec3( 0.34, 0.33, 0.31 ) : vec3( 0.15, 0.11, 0.08 );
  else if ( t == tb.x ) fRoom = wallC * 0.75;
  else {
    fRoom = wallC * 0.6;
    // A dark silhouette of furniture against the back wall.
    float fur = step( hp.y, 0.9 + roomSeed * 0.5 ) * step( 0.3 + roomSeed * 0.4, hp.x / roomW ) * step( hp.x / roomW, 0.75 + roomSeed * 0.2 );
    fRoom = mix( fRoom, vec3( 0.08, 0.07, 0.06 ), fur );
  }
  // Light falls off toward the back of the room.
  fRoom *= mix( 1.0, 0.45, clamp( hp.z / depth, 0.0, 1.0 ) );
  fRoom *= 0.42 + roomSeed * 0.2;
  if ( fCurtain > 0.5 && !fShop ) {
    float cw = smoothstep( 0.35, 0.3, abs( lp.x - 0.5 ) - 0.18 * fHash( fCi * 3.1 ) );
    fRoom = mix( fRoom, vec3( 0.55, 0.42, 0.3 ) * ( 0.6 + 0.4 * fHash( fCi * 1.3 ) ), ( 1.0 - cw ) * 0.9 );
  }
}
if ( fIn > 0.5 ) {
  if ( fBoard > 0.5 ) {
    float plank = fract( fCf.y * 6.0 + fCf.x * 0.3 );
    fCol = vec3( 0.32, 0.24, 0.16 ) * ( 0.7 + 0.5 * fHash( floor( vec2( fCf.y * 6.0 + fCf.x * 0.3, fCi.x ) ) ) );
    fRough = 0.9;
  } else if ( fBroken > 0.5 ) {
    fCol = fRoom * 0.35;
    fRough = 1.0;
  } else {
    fCol = fRoom;
    fGlass = 1.0;
  }
}
if ( fStyle > 2.5 && fStyle < 3.5 && !fShop && fPlain < 0.5 ) {
  // Curtain-wall mullions.
  vec2 mf = abs( fract( fCell ) - 0.5 );
  float mull = step( 0.47, max( mf.x, mf.y ) );
  fCol = mix( fCol, vec3( 0.12, 0.13, 0.14 ), mull );
  fGlass *= 1.0 - mull;
}
if ( fShop && fGlass > 0.0 ) {
  fCol = fRoom;
}
fCol = mix( fCol, fWall * 0.62, fFrame );
fCol = mix( fCol, fWall * 1.18, fSill );
// Grime: soft rain streaks under sills, dirt at the base, soot above broken windows.
float streakMask = ( 1.0 - fPlain ) * fInX * step( fCf.y, fWin.y ) * smoothstep( fWin.y - 0.55, fWin.y, fCf.y );
float streak = streakMask * texture2D( tGrungeF, vec2( vFWPos.x + vFWPos.z, vFWPos.y * 0.25 ) * 0.12 ).a;
fCol *= 1.0 - streak * 0.25 * ( 1.0 - fGlass );
fCol *= mix( 0.6, 1.0, smoothstep( 0.0, 1.6, fUv.y ) );
float soot = fBroken * fInX * step( fWin.w, fCf.y ) * ( 1.0 - smoothstep( fWin.w, 1.0, fCf.y ) );
fCol *= 1.0 - soot * 0.75 * smoothstep( 0.4, 0.8, fG.r + 0.3 );
fCol *= 0.85 + fM.g * 0.3;
diffuseColor.rgb = fCol;
float fEmit = ( fLit * fIn + fShopLit * step( 0.5, fGlass ) * ( fShop ? 1.0 : 0.0 ) ) * ( 1.0 - fBoard );
`;

const FRAG_ROUGH = /* glsl */ `
float roughnessFactor = mix( fRough, 0.08, fGlass * ( 1.0 - fBroken * fIn ) );
`;

const FRAG_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += fRoom * vec3( 2.6, 1.9, 1.2 ) * fEmit * max( uGlowF - 1.0, 0.0 ) * 2.2;
`;

let facadeMat: THREE.MeshStandardMaterial | null = null;

/** Shared facade material (window glow follows KIT.uGlow, which rises at night). */
export function facadeMaterial(): THREE.MeshStandardMaterial {
  if (facadeMat) return facadeMat;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.tGrungeF = { value: grungeTexture() };
    shader.uniforms.tMacroF = { value: macroTexture() };
    shader.uniforms.tCrack = { value: terrainTextures().a };
    shader.uniforms.uGlowF = KIT.uGlow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <project_vertex>', `${VERT_MAIN}\n#include <project_vertex>`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <color_fragment>', FRAG_COLOR)
      .replace('#include <roughnessmap_fragment>', FRAG_ROUGH)
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = 0.0;')
      .replace('#include <emissivemap_fragment>', FRAG_EMISSIVE)
      .replace(
        '#include <opaque_fragment>',
        '#include <opaque_fragment>\ndiffuseColor.a = 1.0;\ngl_FragColor.a = 1.0;',
      );
  };
  m.customProgramCacheKey = () => 'facade';
  m.userData.shared = true;
  facadeMat = m;
  return m;
}

/** Accumulates facade quads with metre UVs and per-building style data. */
export class FacadeBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  fd: number[] = [];
  idx: number[] = [];

  /**
   * One wall: from (x0, z0) to (x1, z1) along the ground, from y0 to y1. The face points along
   * (-dz, dx): walk a box's corners (minX,maxZ) -> (maxX,maxZ) -> (maxX,minZ) -> (minX,minZ) to face outward.
   * `u0` is the distance along the building's perimeter so the window grid stays continuous round corners.
   */
  wall(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, u0: number, tint: THREE.Color, style: number, seed: number, floorH: number, cellW: number, vOff = 0) {
    const base = this.pos.length / 3;
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    const nx = -dz / len;
    const nz = dx / len;
    const pts: [number, number, number][] = [[x0, y0, z0], [x1, y0, z1], [x1, y1, z1], [x0, y1, z0]];
    const uvs: [number, number][] = [[u0, y0 - vOff], [u0 + len, y0 - vOff], [u0 + len, y1 - vOff], [u0, y1 - vOff]];
    for (let i = 0; i < 4; i++) {
      this.pos.push(...pts[i]);
      this.nor.push(nx, 0, nz);
      this.col.push(tint.r, tint.g, tint.b);
      this.uv.push(...uvs[i]);
      this.fd.push(style, seed, floorH, cellW);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    return len;
  }

  /** A flat quad with explicit corners (counter-clockwise from the normal side) and metre UVs. */
  quad(pts: [number, number, number][], normal: [number, number, number], uvs: [number, number][], tint: THREE.Color, style: number, seed: number, floorH: number, cellW: number) {
    const base = this.pos.length / 3;
    for (let i = 0; i < 4; i++) {
      this.pos.push(...pts[i]);
      this.nor.push(...normal);
      this.col.push(tint.r, tint.g, tint.b);
      this.uv.push(...uvs[i]);
      this.fd.push(style, seed, floorH, cellW);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  get empty() {
    return this.pos.length === 0;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('fdata', new THREE.Float32BufferAttribute(this.fd, 4));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
