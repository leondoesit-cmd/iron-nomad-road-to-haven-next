import * as THREE from 'three';

/**
 * Surface gloss for screen-space reflections, carried in the alpha channel of the HDR scene target.
 *
 * Every opaque PBR material writes `1 - R` into alpha, where `R = gloss^4 * F0` (F0 slides from 0.04 for dielectrics to 0.9
 * for metal). A matte surface therefore leaves alpha at 1, which is also what the target is cleared to, and anything blended
 * on top (smoke, dust, glass panes) can only push alpha towards 1: a mistake can only take a reflection away, never invent
 * one. Water draws with its own blend state (see water.ts) and writes alpha 0, which the SSR pass reads as "mirror".
 *
 * The material's own roughness and metalness feed it, so the kit's per-vertex surface values, the terrain's wet shoreline
 * and the rain puddles all steer the reflections with no extra render pass or G-buffer.
 */

/** Largest R an opaque surface can write: anything above this is the water code. */
export const GLOSS_MAX = 0.95;

let installed = false;

/** Patch three's opaque output chunk. Idempotent; call before any material compiles. */
export function installGloss() {
  if (installed) return;
  installed = true;
  const src = 'gl_FragColor = vec4( outgoingLight, diffuseColor.a );';
  const chunk = THREE.ShaderChunk.opaque_fragment;
  if (!chunk.includes(src)) return;
  THREE.ShaderChunk.opaque_fragment = chunk.replace(
    src,
    /* glsl */ `
#if defined( OPAQUE ) && defined( STANDARD )
{
  float glGloss = 1.0 - clamp( roughnessFactor, 0.0, 1.0 );
  float glG2 = glGloss * glGloss;
  float glR = glG2 * glG2 * mix( 0.04, 0.9, clamp( metalnessFactor, 0.0, 1.0 ) );
  diffuseColor.a = 1.0 - min( glR, ${GLOSS_MAX.toFixed(2)} );
}
#endif
${src}`,
  );
}
