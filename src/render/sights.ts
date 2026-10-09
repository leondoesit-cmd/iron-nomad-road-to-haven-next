import { smoothstep } from '../core/math';

/**
 * What the eye sees with the sights up in first person, worked out for the post chain (`dof.ts`, the composite in
 * `post.ts`) and the arms and gun in `viewmodel.ts`:
 *
 * - Depth of field. Behind iron sights the eye settles on the front sight: what is nearer (the rear sight, the receiver, the
 *   arms) goes soft, the front sight and the target stay sharp. Through a red dot the eye is on the target and the dot, so the
 *   whole gun goes soft, all but the dot in the middle. A handgun at arm's length stays sharp; the arms reaching out to it
 *   do not.
 * - A scope's eyepiece. With a scope up to the eye its picture fills a large round window in the middle of the view (the
 *   scope's apparent field, much the same whatever the power), magnified and sharp, with the reticle on it. Round it is the
 *   black of the eyepiece, and past that the world out of focus and dim. Off the line of the scope (a shot's kick, a step)
 *   the exit pupil's shadow creeps in from one side.
 *
 * All distances across the view are in the view's NDC height (1 is half the view's height), measured from its middle, the
 * width scaled by the aspect so a circle is round.
 */

export type OpticKind = 'iron' | 'dot' | 'scope';

/** One view's sights this frame, as the player hands them to the renderer. */
export interface SightView {
  /** How far the sights are up, 0 (hip) to 1. */
  ads: number;
  optic: OpticKind;
  /** The sight's look (`GunKit.sight`): picks the eyepiece and its reticle. */
  sight: string;
  /** A handgun held out at arm's length (its sights stay sharp, only the arms soften). */
  handgun: boolean;
  /** Where the exit pupil's shadow is drawn from: the scope's eyepiece off the line of the eye, NDC height. */
  offX: number;
  offY: number;
}

export const newSightView = (): SightView => ({ ads: 0, optic: 'iron', sight: 'iron', handgun: false, offX: 0, offY: 0 });

/** Reticles drawn on a scope's picture (the composite's `reticle`). */
export const RETICLE = { post: 1, duplex: 2, mildot: 3 } as const;

/**
 * A scope's eyepiece: the radius of its picture (NDC height, so 0.76 fills 76% of the view's height) and its reticle. Low
 * powers have the widest window; the long scopes a little less. `lit` puts a lit red dot in the middle.
 */
export const EYEPIECE: Record<string, { r: number; reticle: number; lit?: boolean }> = {
  scope: { r: 0.8, reticle: RETICLE.post },
  scope4: { r: 0.76, reticle: RETICLE.duplex },
  hunt: { r: 0.75, reticle: RETICLE.duplex },
  tactical: { r: 0.72, reticle: RETICLE.mildot, lit: true },
  scope8: { r: 0.7, reticle: RETICLE.mildot, lit: true },
};
const DEFAULT_EYEPIECE = EYEPIECE.scope4;

/** How far a scope's eyepiece has come to the eye, 0 to 1, for how far the sights are up: it fills in over the last stretch. */
export const eyepieceK = (ads: number) => smoothstep(0.68, 0.97, ads);

/**
 * The eyepiece's picture this frame: its radius (NDC height; 0 with no scope up) and reticle. It opens from a smaller window
 * to the full one as the scope comes in, and stays inside a narrow view (a split screen's tall half).
 */
export function eyepiece(s: SightView | null | undefined, aspect: number): { k: number; r: number; reticle: number; lit: boolean } {
  if (!s || s.optic !== 'scope') return { k: 0, r: 0, reticle: 0, lit: false };
  const k = eyepieceK(s.ads);
  if (k <= 0) return { k: 0, r: 0, reticle: 0, lit: false };
  const e = EYEPIECE[s.sight] ?? DEFAULT_EYEPIECE;
  const full = Math.min(e.r, aspect * 0.92);
  return { k, r: full * (0.62 + 0.38 * k), reticle: e.reticle, lit: !!e.lit };
}

/** One view's depth of field: near blur from `near0` (full) to `near1` (sharp) metres, its size, and the sharp middle. */
export interface DofView {
  near0: number;
  near1: number;
  /** The largest near blur, as a share of the view's height (a radius). */
  nearCoc: number;
  /** A disc this wide (NDC height) in the middle keeps sharp: the dot of a red dot, the hole of a rear aperture. */
  keep: number;
  /** The blur over everything outside a scope's picture (share of the view's height), and the picture's radius. */
  scopeCoc: number;
  scopeR: number;
}

export const noDof = (): DofView => ({ near0: 0, near1: 0, nearCoc: 0, keep: 0, scopeCoc: 0, scopeR: 0 });

/**
 * The depth of field for one view's sights, scaled by `strength` (the setting, 0 to 1). Fades in as the sights come up, so
 * the hip view is never blurred.
 */
export function dofFor(s: SightView | null | undefined, aspect: number, strength: number, out: DofView = noDof()): DofView {
  Object.assign(out, noDof());
  if (!s || strength <= 0) return out;
  const k = smoothstep(0.35, 0.95, s.ads) * strength;
  if (k <= 0) return out;
  if (s.optic === 'iron') {
    // On the front sight: a long gun's sits 0.5 m or more out, a handgun's at arm's length.
    out.near0 = 0.24;
    out.near1 = s.handgun ? 0.46 : 0.5;
    out.nearCoc = (s.handgun ? 0.011 : 0.016) * k;
    out.keep = s.handgun ? 0 : 0.022;
  } else {
    // On the target: the whole gun goes soft, the dot or the scope's picture in the middle does not.
    out.near0 = 0.26;
    out.near1 = 1.2;
    out.nearCoc = 0.02 * k;
    out.keep = 0.04;
  }
  const e = eyepiece(s, aspect);
  if (e.k > 0) {
    out.scopeCoc = 0.03 * e.k * strength;
    out.scopeR = e.r;
  }
  return out;
}

/** Whether a view's depth of field draws anything at all. */
export const dofActive = (d: DofView) => d.nearCoc > 1e-4 || d.scopeCoc > 1e-4;
