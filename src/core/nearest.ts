export interface Ranked<T> { value: T; distance: number; order: number }
const compare = <T>(a: Ranked<T>, b: Ranked<T>) => (a.distance - b.distance) || (a.order - b.order);

/** Bounded max heap, then stable nearest-first output. Entries are reused between frames. */
export class Nearest<T> {
  private pool: Ranked<T>[] = [];
  private heap: Ranked<T>[] = [];
  private limit = 0;
  begin(limit: number) { this.limit = Math.max(0, Math.floor(limit)); this.heap.length = 0; }
  accepts(distance: number, order: number) {
    if (!this.limit) return false;
    const root = this.heap[0];
    return this.heap.length < this.limit || distance < root.distance || (distance === root.distance && order < root.order);
  }
  offer(value: T, distance: number, order: number) {
    if (!this.accepts(distance, order)) return;
    const h = this.heap;
    if (h.length < this.limit) {
      const i = h.length;
      const entry = this.pool[i] ?? (this.pool[i] = { value, distance, order });
      entry.value = value; entry.distance = distance; entry.order = order;
      h.push(entry);
      let child = i;
      while (child > 0) {
        const parent = (child - 1) >>> 1;
        if (compare(h[parent], entry) >= 0) break;
        h[child] = h[parent]; child = parent;
      }
      h[child] = entry;
    } else {
      const entry = h[0];
      entry.value = value; entry.distance = distance; entry.order = order;
      let parent = 0;
      while (parent * 2 + 1 < h.length) {
        let child = parent * 2 + 1;
        if (child + 1 < h.length && compare(h[child + 1], h[child]) > 0) child++;
        if (compare(h[child], entry) <= 0) break;
        h[parent] = h[child]; parent = child;
      }
      h[parent] = entry;
    }
  }
  finish(): readonly Ranked<T>[] { return this.heap.sort(compare); }
}
