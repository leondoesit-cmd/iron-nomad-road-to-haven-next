import * as THREE from 'three';
import { applyKit } from '../materials';
import { shared } from '../dispose';

/**
 * The weapons' material: the kit material (vertex surfaces, grime and rust) plus what a gun needs up close, all procedural
 * from the weapon-frame position so there are still no UVs: the finish of each part (`wpn.x`, see `F` in `kit.ts`) and
 * honest wear on its edges (`wpn.y`), where a coat rubs through to the metal under it.
 *
 * - Oiled walnut and beech get a grain along the gun (growth rings, figure, open pores); checkered wood a cut diamond pattern.
 * - Parkerized steel a fine phosphate tooth; blued steel and anodized aluminium a smooth satin; all three wear to bright
 *   metal on the edges, patchily.
 * - Polymer a moulded matte texture, its grip panels stippled; rubber and tape a soft weave; knurled steel a diamond knurl.
 * - Brass tarnishes in patches; a polished blade is brushed along its length.
 *
 * Fine patterns fade out as they get smaller than a pixel, so a gun in a partner's hands across the street does not
 * shimmer. The kit's own dent texture is off: it reads as clay at this scale.
 */

const VERT_PARS = /* glsl */ `
attribute vec3 wpn;
varying vec3 vWpn;
`;

const FRAG_PARS = /* glsl */ `
varying vec3 vWpn;
float wHash( vec3 p ) {
  p = fract( p * 0.3183099 + vec3( 0.71, 0.113, 0.419 ) );
  p *= 17.0;
  return fract( p.x * p.y * p.z * ( p.x + p.y + p.z ) );
}
float wNoise( vec3 x ) {
  vec3 i = floor( x );
  vec3 f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mix( wHash( i ), wHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( wHash( i + vec3( 0, 1, 0 ) ), wHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
              mix( mix( wHash( i + vec3( 0, 0, 1 ) ), wHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( wHash( i + vec3( 0, 1, 1 ) ), wHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}
float wFbm( vec3 x ) {
  return wNoise( x ) * 0.55 + wNoise( x * 2.13 + 3.1 ) * 0.3 + wNoise( x * 4.37 + 7.7 ) * 0.15;
}
// Peaks of a diamond pattern (checkering, knurling) in the plane (u, v): 1 on a point, 0 in a groove.
float wDiamond( vec2 uv, float pitch ) {
  vec2 d = vec2( uv.x + uv.y, uv.x - uv.y ) / pitch;
  vec2 t = abs( fract( d ) - 0.5 ) * 2.0;
  return min( t.x, t.y );
}
// The plane a pattern is laid in, from the face's normal: (u, v) across the face.
vec2 wPlane( vec3 p, vec3 n ) {
  vec3 a = abs( n );
  if ( a.x >= a.y && a.x >= a.z ) return p.zy;
  if ( a.y >= a.z ) return p.zx;
  return p.xy;
}
`;

/** Runs after the kit's colour: sets the finish's albedo, and the roughness, metalness and bump the later stages use. */
const FRAG_COLOR = /* glsl */ `
float wFin = floor( vWpn.x + 0.5 );
float wEdge = vWpn.y;
float wSeed = vWpn.z;
vec3 wP = vKitPos;
vec3 wN = normalize( vKitNrm );
// Metres per pixel here: patterns finer than a couple of pixels are faded out.
float wPix = max( length( fwidth( wP ) ), 1e-6 );
float wRough = -1.0;
float wMetal = -1.0;
float wH = 0.0;
// Wear through the finish on the edges, broken up so it reads as rubbed and chipped, not painted on.
float wWearK = clamp( vSurf.z * 1.7 + 0.25, 0.0, 1.2 );
float wChip = wNoise( wP * 140.0 + wSeed * 31.0 ) * 0.65 + wNoise( wP * 520.0 ) * 0.35;
float wEw = smoothstep( 0.12, 0.75, wEdge ) * smoothstep( 0.32, 0.72, wChip + wEdge * 0.25 ) * wWearK;
vec3 wBare = vec3( 0.52, 0.53, 0.54 );
if ( wFin > 0.5 && wFin < 3.5 ) {
  // Coated metal: parkerized (1), blued (2), anodized (3).
  float fine = mix( 1.0, wNoise( wP * 1400.0 ), 1.0 - smoothstep( 0.0004, 0.0012, wPix ) );
  float blot = wNoise( wP * vec3( 22.0, 22.0, 9.0 ) + wSeed * 7.0 );
  if ( wFin < 1.5 ) {
    diffuseColor.rgb *= 0.86 + 0.22 * blot;
    diffuseColor.rgb *= 0.94 + 0.12 * fine;
    wRough = clamp( vSurf.x + ( fine - 0.5 ) * 0.16 + ( blot - 0.5 ) * 0.12, 0.25, 0.95 );
    wMetal = vSurf.y;
    wH = ( fine - 0.5 ) * 0.00003;
  } else if ( wFin < 2.5 ) {
    diffuseColor.rgb *= 0.88 + 0.22 * blot;
    wRough = clamp( vSurf.x + ( blot - 0.5 ) * 0.14, 0.12, 0.8 );
    wMetal = vSurf.y;
    wBare = vec3( 0.62, 0.62, 0.64 );
  } else {
    diffuseColor.rgb *= 0.9 + 0.14 * blot;
    wRough = clamp( vSurf.x + ( fine - 0.5 ) * 0.1, 0.2, 0.9 );
    wMetal = vSurf.y;
    wBare = vec3( 0.66, 0.67, 0.69 );
  }
  diffuseColor.rgb = mix( diffuseColor.rgb, wBare, wEw );
  wRough = mix( wRough, 0.3, wEw );
  wMetal = mix( wMetal, 1.0, wEw );
} else if ( wFin > 3.5 && wFin < 5.5 ) {
  // Polymer (4) and stippled grip panels (5).
  float tex = wNoise( wP * 900.0 );
  float fade = 1.0 - smoothstep( 0.0003, 0.0011, wPix );
  float mottle = wNoise( wP * vec3( 30.0, 30.0, 12.0 ) + wSeed * 5.0 );
  diffuseColor.rgb *= 0.9 + 0.16 * mottle;
  wRough = clamp( vSurf.x + ( tex - 0.5 ) * 0.12 * fade, 0.3, 0.95 );
  wMetal = 0.0;
  wH = ( tex - 0.5 ) * 0.00002 * fade;
  if ( wFin > 4.5 ) {
    // Stipple: a field of little bumps.
    float st = wNoise( wP * 2100.0 ) * 0.7 + wNoise( wP * 4400.0 ) * 0.3;
    float sf = 1.0 - smoothstep( 0.00018, 0.0006, wPix );
    wH = ( st - 0.5 ) * 0.00016 * sf;
    wRough = clamp( vSurf.x + 0.08 - ( st - 0.5 ) * 0.2, 0.4, 1.0 );
  }
  // Scuffed lighter where the edges are handled.
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 1.7 + 0.03, wEw * 0.6 );
  wRough = mix( wRough, wRough * 0.75, wEw );
} else if ( wFin > 5.5 && wFin < 6.5 || wFin > 7.5 && wFin < 8.5 ) {
  // Wood (6) and checkered wood (8): rings across the gun, warped along it, with figure and open pores.
  vec3 q = wP + vec3( wSeed * 0.31, wSeed * 0.17, wSeed * 1.3 );
  float warp = wFbm( q * vec3( 60.0, 60.0, 9.0 ) ) * 1.6 + wNoise( q * vec3( 170.0, 170.0, 30.0 ) ) * 0.35;
  float rings = fract( ( q.y * 0.83 + q.x * 0.55 ) * 210.0 + warp * 2.4 );
  float late = smoothstep( 0.5, 0.92, rings ) * ( 1.0 - smoothstep( 0.92, 1.0, rings ) );
  float pfade = 1.0 - smoothstep( 0.00015, 0.0005, wPix );
  float pore = wNoise( q * vec3( 2600.0, 2600.0, 260.0 ) );
  float figure = wFbm( q * vec3( 14.0, 14.0, 4.0 ) );
  diffuseColor.rgb *= mix( 1.12, 0.66, late ) * ( 0.8 + 0.4 * figure );
  diffuseColor.rgb *= 1.0 - smoothstep( 0.62, 0.9, pore ) * 0.35 * pfade;
  wRough = clamp( vSurf.x + late * 0.1 + ( pore - 0.5 ) * 0.12 * pfade, 0.25, 0.95 );
  wMetal = 0.0;
  wH = -late * 0.00004 - smoothstep( 0.62, 0.9, pore ) * 0.00004 * pfade;
  if ( wFin > 7.5 ) {
    float d = wDiamond( wPlane( wP, wN ), 0.0017 );
    float cf = 1.0 - smoothstep( 0.00025, 0.0008, wPix );
    wH = ( smoothstep( 0.0, 0.7, d ) - 0.5 ) * 0.00028 * cf + wH * 0.4;
    diffuseColor.rgb *= mix( 1.0, 0.7 + 0.4 * d, cf );
    wRough = clamp( wRough + 0.12, 0.3, 1.0 );
  }
  // Handling polishes the edges lighter and smoother.
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 1.35, wEw * 0.7 );
  wRough = mix( wRough, wRough * 0.7, wEw );
} else if ( wFin > 6.5 && wFin < 7.5 || wFin > 11.5 && wFin < 13.5 || wFin > 14.5 ) {
  // Rubber (7), tape (12), leather (13), cord (15).
  float fade = 1.0 - smoothstep( 0.00025, 0.0009, wPix );
  float t = 0.0;
  if ( wFin < 7.5 ) t = wNoise( wP * 1500.0 );
  else if ( wFin < 12.5 ) {
    vec2 uv = wPlane( wP, wN );
    t = ( sin( uv.x * 4200.0 ) * sin( uv.y * 4200.0 ) ) * 0.5 + 0.5;
  } else if ( wFin < 13.5 ) t = wNoise( wP * 900.0 ) * 0.6 + wNoise( wP * 2400.0 ) * 0.4;
  else {
    // Cord: a twisted weave along its length.
    t = sin( ( wP.x + wP.y + wP.z ) * 2600.0 + sin( ( wP.x - wP.z ) * 1300.0 ) * 1.5 ) * 0.5 + 0.5;
  }
  diffuseColor.rgb *= 0.88 + 0.22 * t * fade + 0.12 * ( 1.0 - fade );
  wRough = clamp( vSurf.x + ( t - 0.5 ) * 0.16 * fade, 0.3, 1.0 );
  wMetal = 0.0;
  wH = ( t - 0.5 ) * ( wFin > 14.5 ? 0.0003 : 0.00007 ) * fade;
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * 1.4, wEw * 0.5 );
} else if ( wFin > 8.5 && wFin < 9.5 ) {
  // Knurled steel.
  float d = wDiamond( wPlane( wP, wN ), 0.0011 );
  float kf = 1.0 - smoothstep( 0.00015, 0.0005, wPix );
  wH = ( d - 0.5 ) * 0.00022 * kf;
  diffuseColor.rgb *= mix( 1.0, 0.75 + 0.5 * d, kf );
  wRough = clamp( vSurf.x + ( 0.5 - d ) * 0.2 * kf, 0.15, 0.9 );
  wMetal = vSurf.y;
} else if ( wFin > 9.5 && wFin < 10.5 ) {
  // Brass, tarnished in patches and bright where it is handled.
  float tarnish = wFbm( wP * 45.0 + wSeed * 9.0 );
  diffuseColor.rgb *= mix( 1.08, 0.58, smoothstep( 0.35, 0.8, tarnish ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.62, 0.42, 0.14 ) * 1.1, wEw * 0.6 );
  wRough = clamp( vSurf.x + smoothstep( 0.35, 0.8, tarnish ) * 0.3 - wEw * 0.15, 0.12, 0.9 );
  wMetal = 1.0;
} else if ( wFin > 10.5 && wFin < 11.5 ) {
  // Polished steel brushed along the blade.
  float fade = 1.0 - smoothstep( 0.0002, 0.0008, wPix );
  float br = wNoise( vec3( wP.x * 4000.0, wP.y * 4000.0, wP.z * 25.0 ) );
  float smear = wFbm( wP * 40.0 + wSeed * 3.0 );
  diffuseColor.rgb *= 0.92 + 0.1 * br * fade + ( smear - 0.5 ) * 0.12;
  wRough = clamp( vSurf.x + ( br - 0.5 ) * 0.16 * fade + ( smear - 0.5 ) * 0.14, 0.08, 0.7 );
  wMetal = 1.0;
} else if ( wFin > 13.5 && wFin < 14.5 ) {
  // Paint over steel, chipped to the metal on the edges and here and there on the faces.
  float chips = smoothstep( 0.8, 0.86, wNoise( wP * 210.0 + wSeed * 5.0 ) * 0.7 + wNoise( wP * 47.0 + wSeed ) * 0.3 ) * clamp( vSurf.z * 0.9, 0.0, 1.0 );
  float k = max( wEw, chips );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.3, 0.3, 0.31 ), k );
  wRough = mix( vSurf.x, 0.35, k );
  wMetal = mix( vSurf.y, 0.95, k );
  wH = -chips * 0.00005;
}
`;

const FRAG_ROUGH = /* glsl */ `
if ( wRough >= 0.0 ) roughnessFactor = clamp( wRough + kitDirt * 0.25 + kitRust * 0.45, 0.04, 1.0 );
`;

const FRAG_METAL = /* glsl */ `
if ( wMetal >= 0.0 ) metalnessFactor = clamp( wMetal * ( 1.0 - kitRust ) * ( 1.0 - kitDirt * 0.5 ), 0.0, 1.0 );
`;

/** The height field `wH` (metres) bent into the normal, from its screen-space slope (a surface gradient). */
const FRAG_NORMAL = /* glsl */ `
{
  vec3 wPos = -vViewPosition;
  vec3 dpx = dFdx( wPos );
  vec3 dpy = dFdy( wPos );
  float dhx = dFdx( wH );
  float dhy = dFdy( wH );
  vec3 r1 = cross( dpy, normal );
  vec3 r2 = cross( normal, dpx );
  float det = dot( dpx, r1 );
  if ( abs( det ) > 1e-14 ) {
    vec3 grad = ( dhx * r1 + dhy * r2 ) / det;
    normal = normalize( normal - grad * 1.0 );
  }
}
`;

/** Grime projection (1/m) and wear for weapons: finer and lighter than on cars and walls. */
const WEAPON_KIT = { value: new THREE.Vector4(7, 2.4, 0.75, 0) };

let cachedMat: THREE.MeshStandardMaterial | null = null;

/** The one material every weapon model is drawn with (held, in first person, on the ground and on racks). */
export function weaponMaterial(): THREE.MeshStandardMaterial {
  if (cachedMat) return cachedMat;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_PARS}`)
      .replace('#include <project_vertex>', `vWpn = wpn;\n#include <project_vertex>`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${FRAG_ROUGH}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${FRAG_METAL}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${FRAG_NORMAL}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>`);
    applyKit(shader, false);
    // The finish runs after the kit's grime colour (applyKit has put that in place of the colour include).
    shader.fragmentShader = shader.fragmentShader
      .replace('diffuseColor.rgb *= 0.9 + kitG.g * 0.2;', `diffuseColor.rgb *= 0.95 + kitG.g * 0.1;\n${FRAG_COLOR}`)
      // The grime map's rain streaks are for walls and car doors: on a gun they read as grain.
      .replace('kitG.a * kitSide * kitWear * 0.4', 'kitG.a * kitSide * kitWear * 0.04');
    shader.uniforms.uKit = WEAPON_KIT;
  };
  m.customProgramCacheKey = () => 'kit:weapon';
  cachedMat = shared(m);
  return cachedMat;
}
