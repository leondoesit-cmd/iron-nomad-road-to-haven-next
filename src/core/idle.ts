/**
 * Scheduling helpers for work that must not land on a frame the player is waiting for: background loading on the title,
 * and the moment between a menu press and the heavy work it starts.
 */

const hasIdle = typeof requestIdleCallback === 'function';

/** Resolve at the next idle moment of the main thread (`requestIdleCallback`; a short timeout where there is none). */
export function idleSlot(timeout = 250): Promise<void> {
  return new Promise((resolve) => {
    if (hasIdle) requestIdleCallback(() => resolve(), { timeout });
    else setTimeout(resolve, 16);
  });
}

export const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Resolve once the next frame has been painted, so whatever the DOM shows now (a pressed button, a loading veil) is on
 * screen before the main thread goes busy. Frames do not run in a hidden tab, so it gives up waiting after `max` ms.
 */
export function nextPaint(max = 150): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(finish, 0));
    setTimeout(finish, max);
  });
}

/**
 * Wait until nobody has touched a control for `quietMs` (and the main thread is idle), or until `urgent()` says the work
 * is wanted now. Polls a few times a second, so a press that makes the work urgent is seen at once.
 */
export async function quietSlot(lastInputAt: () => number, quietMs: number, urgent: () => boolean): Promise<void> {
  for (;;) {
    if (urgent()) return;
    const wait = lastInputAt() + quietMs - performance.now();
    if (wait <= 0) {
      await idleSlot();
      if (urgent() || performance.now() - lastInputAt() >= quietMs) return;
      continue;
    }
    await delay(Math.min(120, wait));
  }
}
