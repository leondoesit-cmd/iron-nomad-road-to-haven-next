/**
 * Skip re-uploading float array uniforms that have not changed.
 *
 * three caches what it last sent for a single uniform and skips the GL call when nothing changed, but sends array uniforms
 * every time a material's uniforms are refreshed (each change of material in the draw list). The fire lights
 * (`fireLightPos`, `fireLightCol`, in every lit material) and the sun's shadow matrix (`directionalShadowMatrix`) are
 * arrays, so a split-screen frame re-sent about 740 of them, nearly all with the values the program already held (no fire
 * burning: all zeros). A uniform's value belongs to its program and stays until changed, so a call is skipped only when the
 * values are exactly the ones this program's uniform was last given: the picture cannot change.
 */

/** Float uniform types and the numbers in one element of each (GL enums). */
const BLOCK: Record<number, number> = {
  0x1406: 1, // FLOAT
  0x8b50: 2, // FLOAT_VEC2
  0x8b51: 3, // FLOAT_VEC3
  0x8b52: 4, // FLOAT_VEC4
  0x8b5a: 4, // FLOAT_MAT2
  0x8b5b: 9, // FLOAT_MAT3
  0x8b5c: 16, // FLOAT_MAT4
};

type Setter = (gl: WebGL2RenderingContext, v: unknown, textures?: unknown) => void;
/** three's uniform objects as far as this needs them: a pure array uniform has a `size`, a struct its own `seq`. */
interface UniformNode {
  id: string | number;
  type?: number;
  size?: number;
  setValue?: Setter;
  seq?: UniformNode[];
}
interface ProgramLike {
  getUniforms(): { seq: UniformNode[] };
}

const patched = new WeakSet<object>();

/** The value as one flat list of numbers, the way three flattens it for upload (null for a shape this does not know). */
function flat(v: unknown, size: number, block: number, scratch: Float32Array): ArrayLike<number> | null {
  const a = v as ArrayLike<unknown>;
  if (!a || typeof a.length !== 'number' || a.length === 0) return null;
  if (typeof a[0] === 'number') return a as ArrayLike<number>;
  for (let i = 0; i < size; i++) {
    const e = a[i] as { toArray?: (out: Float32Array, offset: number) => unknown } | undefined;
    if (!e || typeof e.toArray !== 'function') return null;
    e.toArray(scratch, i * block);
  }
  return scratch;
}

/** Give one array uniform a memory of what it last sent. */
export function cacheArrayUniform(u: UniformNode) {
  const block = u.type !== undefined ? BLOCK[u.type] : undefined;
  const set = u.setValue;
  if (!block || !u.size || !set) return;
  const size = u.size;
  const scratch = new Float32Array(size * block);
  let last: Float32Array | null = null;
  u.setValue = function (this: unknown, gl, v, textures) {
    const f = flat(v, size, block, scratch);
    if (f && last && last.length === f.length) {
      let same = true;
      for (let i = 0; i < f.length; i++) {
        if (f[i] !== last[i]) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    set.call(this, gl, v, textures);
    if (!f) last = null;
    else if (last && last.length === f.length) last.set(f as ArrayLike<number>);
    else last = Float32Array.from(f);
  };
}

/** Cache every float array uniform of a program (once per program; its uniforms already exist once it has drawn). */
export function cacheArrayUniforms(program: ProgramLike) {
  if (patched.has(program)) return;
  patched.add(program);
  const visit = (seq: UniformNode[]) => {
    for (const u of seq) {
      if (u.seq) visit(u.seq);
      else if (u.size !== undefined) cacheArrayUniform(u);
    }
  };
  visit(program.getUniforms().seq);
}
