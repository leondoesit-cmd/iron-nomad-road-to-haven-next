import * as THREE from 'three';

/** Roots stay fixed while plants bend. Beyond fadeEnd the shader collapses every triangle to a point. */
export class FadedBatch {
  enabled = true;
  private roots = new THREE.Box3();
  private worldRoots = new THREE.Box3();
  private worldMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(readonly mesh: THREE.InstancedMesh, readonly fadeEnd: number) {
    const a = mesh.instanceMatrix.array, point = new THREE.Vector3();
    for (let i = 0; i < mesh.count; i++) this.roots.expandByPoint(point.set(a[i * 16 + 12], a[i * 16 + 13], a[i * 16 + 14]));
  }

  updateView(camera: THREE.Vector3, updateParents = true) {
    const mesh = this.mesh;
    // A shadow caster can still affect the view after its colour shader has faded. Moving roots disable this bound.
    if (!this.enabled || mesh.castShadow || !mesh.frustumCulled) { mesh.visible = this.enabled; return; }
    mesh.updateWorldMatrix(updateParents, false);
    if (!this.worldMatrix.equals(mesh.matrixWorld)) {
      this.worldMatrix.copy(mesh.matrixWorld);
      this.worldRoots.copy(this.roots).applyMatrix4(mesh.matrixWorld);
    }
    const b = this.worldRoots;
    const dx = Math.max(b.min.x - camera.x, 0, camera.x - b.max.x);
    const dy = Math.max(b.min.y - camera.y, 0, camera.y - b.max.y);
    const dz = Math.max(b.min.z - camera.z, 0, camera.z - b.max.z);
    // Margin protects the shader's Float32 distance arithmetic at the fully faded boundary.
    mesh.visible = dx * dx + dy * dy + dz * dz <= (this.fadeEnd + 0.05) ** 2;
  }
}
