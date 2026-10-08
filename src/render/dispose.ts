import * as THREE from 'three';

/** Mark a geometry or material as shared across scenes so scene teardown leaves it alone. */
export function shared<T extends THREE.BufferGeometry | THREE.Material | THREE.Texture>(r: T): T {
  r.userData.shared = true;
  return r;
}

function disposeMaterial(m: THREE.Material) {
  if (m.userData.shared) return;
  for (const k of Object.keys(m)) {
    const v = (m as unknown as Record<string, unknown>)[k];
    if (v && (v as THREE.Texture).isTexture && !(v as THREE.Texture).userData.shared) (v as THREE.Texture).dispose();
  }
  m.dispose();
}

/** Free GPU resources for everything under `root` that is not marked shared. */
export function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach(disposeMaterial);
    else if (mat) disposeMaterial(mat);
    // Shadow-pass materials (a bending zombie's depth material) belong to the mesh just as much as its colour one.
    if (m.customDepthMaterial) disposeMaterial(m.customDepthMaterial);
    if (m.customDistanceMaterial) disposeMaterial(m.customDistanceMaterial);
  });
}
