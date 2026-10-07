import type { Object3D } from 'three';

/** Cache an immutable LOCAL transform. Children, visibility, geometry and instance matrices can still change. */
export function staticTransform<T extends Object3D>(object: T): T {
  object.updateMatrix();
  object.matrixAutoUpdate = false;
  return object;
}
