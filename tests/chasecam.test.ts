import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ChaseCamera, type CamParams, type CamTarget } from '../src/render/camera';

const DT = 1 / 60;
const params = (motion = 1): CamParams => ({ dist: 6, height: 2.5, aimYaw: 0, aimPitch: 0, lookYaw: 0, lookPitch: 0, shoulder: 0, lookBack: false, zoom: 0, motion });

/** Drive a car along a path given as a function of time and return the camera after each frame. */
function drive(path: (t: number) => { x: number; y: number; z: number; yaw: number; speed: number }, seconds: number, motion = 1, probe?: (cam: ChaseCamera, t: number, at: CamTarget) => void) {
  const cam = new ChaseCamera();
  for (let i = 0; i <= seconds * 60; i++) {
    const t = i * DT;
    const at: CamTarget = { ...path(t), topSpeed: 30 };
    cam.update(DT, at, 'vehicle', params(motion));
    probe?.(cam, t, at);
  }
  return cam;
}

/** How far the camera sits behind the car along its nose. */
const behind = (cam: ChaseCamera, at: CamTarget) => -((cam.pos.x - at.x) * Math.sin(at.yaw) + (cam.pos.z - at.z) * Math.cos(at.yaw));

describe('driving chase camera', () => {
  it('falls back under hard acceleration and closes in under braking, more than with motion off', () => {
    // 6 m/s² for 2 s from 10 m/s, then 8 m/s² of braking.
    const pos = (t: number) => (t < 2 ? 10 * t + 3 * t * t : 32 + 22 * (t - 2) - 4 * (t - 2) ** 2);
    const spd = (t: number) => (t < 2 ? 10 + 6 * t : 22 - 8 * (t - 2));
    const path = (t: number) => ({ x: 0, y: 0, z: pos(t), yaw: 0, speed: spd(t) });
    const gap = (motion: number, at: number) => {
      let g = 0;
      drive(path, at, motion, (cam, t, tg) => {
        if (Math.abs(t - at) < DT / 2) g = behind(cam, tg);
      });
      return g;
    };
    // The camera's own speed pull-back is the same either way, so the difference is the ride.
    const launchOn = gap(1, 1.5) - gap(0, 1.5);
    const brakeOn = gap(1, 2.8) - gap(0, 2.8);
    expect(launchOn).toBeGreaterThan(0.4);
    expect(brakeOn).toBeLessThan(-0.5);
  });

  it('banks into a left turn, swings out to the right, and looks toward the corner exit', () => {
    // A steady left-hand circle: 15 m/s on a 30 m radius (7.5 m/s² of pull to the left).
    const R = 30;
    const w = 15 / R;
    const path = (t: number) => {
      const a = w * t;
      // yaw + is to the left; heading (sin yaw, cos yaw), centre of the circle on the left of the car.
      return { x: R * (1 - Math.cos(a)), y: 0, z: R * Math.sin(a), yaw: a, speed: 15 };
    };
    const cam = drive(path, 3);
    const c = new THREE.PerspectiveCamera();
    cam.apply(c);
    // Camera's local X up-component: tilted left means its right side has gone up.
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion);
    expect(right.y).toBeGreaterThan(0.02);
    expect(cam.ride.sway.x).toBeGreaterThan(0.3);
    expect(cam.ride.yawRate).toBeCloseTo(w, 1);
  });

  it('dips on a landing and bounces back, and widens in the air', () => {
    // Off a 2 m drop at 12 m/s: fall from t = 1 s, land at about 1.64 s, then roll on.
    const tl = Math.sqrt(4 / 9.81);
    const y = (t: number) => (t < 1 ? 2 : t < 1 + tl ? 2 - 0.5 * 9.81 * (t - 1) ** 2 : 0);
    const path = (t: number) => ({ x: 0, y: y(t), z: 12 * t, yaw: 0, speed: 12 });
    let minHeave = 0;
    let airFov = 0;
    let groundFov = 0;
    let finalHeave = 1;
    drive(path, 4, 1, (cam, t) => {
      if (t > 1 + tl && t < 2.4) minHeave = Math.min(minHeave, cam.ride.heave.x);
      if (t > 1.5 && t < 1 + tl) airFov = Math.max(airFov, cam.fovKick);
      if (t > 0.8 && t < 0.99) groundFov = cam.fovKick;
      finalHeave = cam.ride.heave.x;
    });
    expect(minHeave).toBeLessThan(-0.25);
    expect(airFov).toBeGreaterThan(groundFov + 1);
    expect(Math.abs(finalHeave)).toBeLessThan(0.05);
  });

  it('stays still and finite with motion off, and survives a teleport', () => {
    const path = (t: number) => ({ x: t < 1 ? 0 : 500, y: 0, z: t < 1 ? 20 * t : 900 + 20 * t, yaw: 0, speed: 20 });
    const cam = drive(path, 2, 1);
    expect(Number.isFinite(cam.pos.x + cam.pos.y + cam.pos.z)).toBe(true);
    expect(Math.abs(cam.ride.surge.x)).toBeLessThan(0.05);
    const off = drive((t) => ({ x: 0, y: 0, z: 10 * t + 3 * t * t, yaw: 0, speed: 10 + 6 * t }), 1.5, 0);
    expect(off.ride.surge.x).toBe(0);
    expect(off.ride.bank.x).toBe(0);
  });
});
