import type { BufferAttribute } from 'three';

/** Keep pending writes until WebGL consumes them, including invisible or multi-view batches. */
export function uploadPrefix(attribute: BufferAttribute, count: number) {
  if (count <= 0) return;
  const size = count * attribute.itemSize;
  const pending = attribute.updateRanges[0];
  if (pending?.start === 0) pending.count = Math.max(pending.count, size);
  else attribute.addUpdateRange(0, size);
  attribute.needsUpdate = true;
}
