import { paintTexels, type PortraitSpec } from './portraitPaint';

/** Paints a portrait head's texture off the main thread, so a hero's first appearance does not stall the frame. */

export interface PaintJob {
  id: number;
  spec: PortraitSpec;
  pos: Float32Array;
  nor: Float32Array;
  w: number;
  h: number;
}

const ctx = self as unknown as { onmessage: ((e: MessageEvent<PaintJob>) => void) | null; postMessage(m: unknown, transfer: Transferable[]): void };

ctx.onmessage = (e) => {
  const { id, spec, pos, nor, w, h } = e.data;
  const data = paintTexels(spec, pos, nor, w, h);
  ctx.postMessage({ id, data }, [data.buffer]);
};
