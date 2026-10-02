import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { InputManager, TAP_SECONDS, defaultSettings, promptLabel } from '../src/input/input';
import {
  SHARED,
  assignBinding,
  clearBinding,
  defaultBindings,
  exportBindings,
  importBindings,
  keyLabel,
  padLabel,
  padPhysical,
  viewSharesVehicle,
} from '../src/input/bindings';
import { Btn } from '../src/input/intents';
import { initPhysics } from '../src/physics/physics';
import { legById } from '../src/data';
import { LegScene } from '../src/game/legScene';
import { fakeServices, run } from './helpers/sim';

beforeAll(async () => {
  await initPhysics();
});

const DT = 1 / 60;

/** A pad stand-in whose pressed buttons the test controls. */
function padInput() {
  const win = new EventTarget();
  const im = new InputManager(win as unknown as Window);
  const down = new Set<number>();
  const pad = {
    index: 0,
    connected: true,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    get buttons() {
      return Array.from({ length: 17 }, (_, i) => ({ pressed: down.has(i), value: down.has(i) ? 1 : 0 }));
    },
  } as unknown as Gamepad;
  im.mockPads = [pad];
  im.slots[0] = { kind: 'pad', index: 0 };
  return { im, down, win };
}

function kbInput() {
  const win = new EventTarget();
  const im = new InputManager(win as unknown as Window);
  im.autoJoinKeyboard();
  const key = (type: 'keydown' | 'keyup', code: string, repeat = false) => win.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { code, repeat }));
  return { im, win, key };
}

const sampleFor = (im: InputManager, seconds: number) => {
  const seen = { pressed: 0, held: 0 };
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    im.sample(DT);
    seen.pressed |= im.intents[0].pressed;
    seen.held |= im.intents[0].held;
  }
  return seen;
};

describe('binding tables', () => {
  it('start from the layouts the game always had, plus the new view keys', () => {
    const b = defaultBindings();
    expect(b.kb[0].fire).toBe('KeyF');
    expect(b.kb[1].interact).toBe('Slash');
    expect(b.kb[0].view).toBe('KeyB');
    expect(b.pad.vehicle).toBe(Btn.Y);
    expect(b.pad.view).toBe(SHARED);
    expect(viewSharesVehicle(b.pad)).toBe(true);
    expect(padPhysical(b.pad, 'view')).toBe(Btn.Y);
    expect(b.mouse).toEqual({ fire: 0, aim: 2, view: 1 });
  });

  it('no two actions share a key within a layout, and the layouts do not overlap each other', () => {
    const b = defaultBindings();
    for (const m of b.kb) {
      const codes = Object.values(m);
      expect(new Set(codes).size).toBe(codes.length);
    }
    const both = [...Object.values(b.kb[0]), ...Object.values(b.kb[1])];
    expect(new Set(both).size).toBe(both.length);
  });

  it('assigning a key that another action holds swaps the two', () => {
    const b = defaultBindings();
    const moved = assignBinding('kb', b.kb[0], 'interact', 'KeyR'); // R is vehicle
    expect(moved).toBe('vehicle');
    expect(b.kb[0].interact).toBe('KeyR');
    expect(b.kb[0].vehicle).toBe('KeyG');
  });

  it('on a pad, binding view to the vehicle button is the tap / hold share; elsewhere it unshares', () => {
    const b = defaultBindings();
    assignBinding('pad', b.pad, 'view', Btn.R3); // R3 is camera; view leaves the share, camera gets a free button
    expect(b.pad.view).toBe(Btn.R3);
    expect(b.pad.camera).toBeDefined();
    expect(b.pad.camera).not.toBe(Btn.R3);
    expect(b.pad.camera).not.toBe(b.pad.vehicle);
    expect(viewSharesVehicle(b.pad)).toBe(false);
    assignBinding('pad', b.pad, 'view', Btn.Y);
    expect(b.pad.view).toBe(SHARED);
    expect(viewSharesVehicle(b.pad)).toBe(true);
  });

  it('a pad swap keeps every pad button bound at most once', () => {
    const b = defaultBindings();
    assignBinding('pad', b.pad, 'interact', Btn.B);
    assignBinding('pad', b.pad, 'swap', Btn.RT);
    assignBinding('pad', b.pad, 'vehicle', Btn.A); // vehicle takes A from crouch, crouch takes Y, and the shared view follows vehicle
    // Jump rides on interact on purpose, so it is not counted.
    const used = Object.entries(b.pad)
      .filter(([a, v]) => v !== SHARED && a !== 'jump')
      .map(([, v]) => v);
    expect(new Set(used).size).toBe(used.length);
    expect(b.pad.interact).toBe(Btn.B);
    expect(b.pad.fire).toBe(Btn.LB);
    expect(b.pad.swap).toBe(Btn.RT);
    expect(b.pad.vehicle).toBe(Btn.A);
    expect(b.pad.crouch).toBe(Btn.Y);
    expect(padPhysical(b.pad, 'view')).toBe(Btn.A);
  });

  it('only optional keyboard and mouse actions can be unbound', () => {
    const b = defaultBindings();
    expect(clearBinding('kb', b.kb[0], 'fire')).toBe(false);
    expect(b.kb[0].fire).toBe('KeyF');
    expect(clearBinding('kb', b.kb[0], 'view')).toBe(true);
    expect(b.kb[0].view).toBeUndefined();
    expect(clearBinding('pad', b.pad, 'view')).toBe(false);
  });

  it('saves and restores, keeping an unbound action unbound', () => {
    const b = defaultBindings();
    assignBinding('kb', b.kb[1], 'fire', 'KeyJ');
    clearBinding('kb', b.kb[0], 'camera');
    const back = importBindings(JSON.parse(JSON.stringify(exportBindings(b))));
    expect(back).toEqual(b);
    expect(back.kb[0].camera).toBeUndefined();
  });

  it('ignores junk in a saved file instead of loading it', () => {
    const d = defaultBindings();
    expect(importBindings(null)).toEqual(d);
    expect(importBindings('nope')).toEqual(d);
    const bad = importBindings({ pad: { fire: 99, interact: 'x', view: 9 }, kb: [{ fire: 'Escape', interact: 'KeyW' }, 5], mouse: { fire: 9 } });
    expect(bad.pad.fire).toBe(d.pad.fire); // out of range
    expect(bad.pad.interact).toBe(d.pad.interact); // wrong type
    expect(bad.kb[0].fire).toBe('KeyF'); // Escape is reserved
    expect(bad.kb[0].interact).toBe('KeyG'); // KeyW is already moveUp, so the duplicate is refused
    expect(bad.mouse.fire).toBe(0);
  });

  it('names keys and buttons for humans', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('ArrowUp')).toBe('↑');
    expect(keyLabel('ShiftRight')).toBe('R-Shift');
    expect(keyLabel('Digit3')).toBe('3');
    expect(keyLabel(undefined)).toBe('Unbound');
    expect(padLabel(Btn.Y)).toBe('Y');
    expect(padLabel(Btn.Up)).toBe('D-pad ↑');
  });
});

describe('gamepad: Y taps the view and holds the vehicle', () => {
  it('a quick tap pulses View once and never Y', () => {
    const { im, down } = padInput();
    down.add(Btn.Y);
    sampleFor(im, 0.1);
    down.delete(Btn.Y);
    const seen = sampleFor(im, 0.2);
    expect(seen.pressed & (1 << Btn.View)).not.toBe(0);
    expect((seen.pressed | seen.held) & (1 << Btn.Y)).toBe(0);
  });

  it('holding past the tap time presses Y (once) and never switches the view', () => {
    const { im, down } = padInput();
    down.add(Btn.Y);
    const held = sampleFor(im, TAP_SECONDS + 0.2);
    expect(held.pressed & (1 << Btn.Y)).not.toBe(0);
    down.delete(Btn.Y);
    const after = sampleFor(im, 0.2);
    expect((held.pressed | after.pressed) & (1 << Btn.View)).toBe(0);
  });

  it('a held Y asserts the hold from the moment it crosses the threshold', () => {
    const { im, down } = padInput();
    down.add(Btn.Y);
    sampleFor(im, TAP_SECONDS - 0.1);
    expect(im.intents[0].held & (1 << Btn.Y)).toBe(0);
    sampleFor(im, 0.2);
    expect(im.intents[0].held & (1 << Btn.Y)).not.toBe(0);
  });

  it('unshared, Y is an immediate vehicle press and the view goes to its own button', () => {
    const { im, down } = padInput();
    assignBinding('pad', im.settings.bindings.pad, 'view', Btn.R3);
    im.bindingsChanged();
    expect(im.vehicleIsHold(0)).toBe(false);
    down.add(Btn.Y);
    im.sample(DT);
    expect(im.intents[0].pressed & (1 << Btn.Y)).not.toBe(0);
    down.delete(Btn.Y);
    down.add(Btn.R3);
    im.sample(DT);
    expect(im.intents[0].pressed & (1 << Btn.View)).not.toBe(0);
  });

  it('prompts say hold while shared, and name the button the player actually bound', () => {
    const { im } = padInput();
    expect(im.vehicleIsHold(0)).toBe(true);
    assignBinding('pad', im.settings.bindings.pad, 'interact', Btn.X); // interact takes X, reload takes A
    im.bindingsChanged();
    expect(promptLabel({ kind: 'pad', index: 0 }, 'A')).toBe('X');
    expect(promptLabel({ kind: 'pad', index: 0 }, 'X')).toBe('A');
  });
});

describe('gamepad remapping', () => {
  it('swapping interact and crouch moves the logical A and B', () => {
    const { im, down } = padInput();
    assignBinding('pad', im.settings.bindings.pad, 'interact', Btn.B);
    im.bindingsChanged();
    down.add(Btn.B);
    im.sample(DT);
    expect(im.intents[0].pressed & (1 << Btn.A)).not.toBe(0);
    expect(im.intents[0].pressed & (1 << Btn.B)).toBe(0);
    expect(im.intents[0].handbrake).toBe(true);
  });

  it('fire follows its binding, analog trigger included', () => {
    const { im, down } = padInput();
    assignBinding('pad', im.settings.bindings.pad, 'fire', Btn.RB);
    im.bindingsChanged();
    down.add(Btn.RB);
    im.sample(DT);
    expect(im.intents[0].rt).toBe(1);
    expect(im.intents[0].pressed & (1 << Btn.RT)).not.toBe(0);
  });

  it('menus still navigate on the physical D-pad even if the wheel moved off it', () => {
    const { im, down } = padInput();
    assignBinding('pad', im.settings.bindings.pad, 'wheel', Btn.Back);
    im.bindingsChanged();
    down.add(Btn.Up);
    im.sample(DT);
    expect(im.intents[0].nav & 1).toBe(1);
    expect(im.intents[0].held & (1 << Btn.Up)).toBe(0);
  });
});

describe('keyboard and mouse bindings', () => {
  it('movement and actions follow the rebound keys, and the old key stops working', () => {
    const { im, key } = kbInput();
    assignBinding('kb', im.settings.bindings.kb[0], 'moveUp', 'KeyI');
    im.bindingsChanged();
    key('keydown', 'KeyW');
    for (let i = 0; i < 30; i++) im.sample(DT);
    // KeyI was free, so moveUp simply moved there and W does nothing now.
    expect(im.intents[0].move[1]).toBeLessThanOrEqual(0);
    key('keyup', 'KeyW');
    key('keydown', 'KeyI');
    for (let i = 0; i < 30; i++) im.sample(DT);
    expect(im.intents[0].move[1]).toBeGreaterThan(0.9);
  });

  it('the view key presses the View button once', () => {
    const { im, key } = kbInput();
    key('keydown', 'KeyB');
    im.sample(DT);
    expect(im.intents[0].pressed & (1 << Btn.View)).not.toBe(0);
    im.sample(DT);
    expect(im.intents[0].pressed & (1 << Btn.View)).toBe(0);
  });

  it('an unbound key does nothing', () => {
    const { im, key } = kbInput();
    clearBinding('kb', im.settings.bindings.kb[0], 'view');
    im.bindingsChanged();
    key('keydown', 'KeyB');
    im.sample(DT);
    expect(im.intents[0].held & (1 << Btn.View)).toBe(0);
  });

  it('the join key and the convoy-sheet key follow the bindings', () => {
    const win = new EventTarget();
    const im = new InputManager(win as unknown as Window);
    assignBinding('kb', im.settings.bindings.kb[0], 'fire', 'KeyJ');
    im.bindingsChanged();
    win.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code: 'KeyJ' }));
    im.pollJoin();
    expect(im.slots[0]).toEqual({ kind: 'kb', set: 1 });
    win.dispatchEvent(Object.assign(new Event('keydown', { cancelable: true }), { code: 'Space' }));
    im.sample(DT);
    expect(im.intents[0].held & (1 << Btn.Back)).not.toBe(0);
  });

  it('mouse buttons are rebindable: the middle button switches view, and moving fire to the right button works', () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { pointerLockElement: null as unknown });
    const canvas = { ownerDocument: doc, requestPointerLock: () => {} };
    const im = new InputManager(win as unknown as Window);
    im.autoJoinKeyboard();
    im.attachMouse(canvas as unknown as HTMLElement);
    doc.pointerLockElement = canvas;
    doc.dispatchEvent(new Event('pointerlockchange'));
    const ev = (type: string, button: number) => win.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), { button }));
    ev('mousedown', 1);
    im.sample(DT);
    expect(im.intents[0].pressed & (1 << Btn.View)).not.toBe(0);
    ev('mouseup', 1);
    assignBinding('mouse', im.settings.bindings.mouse, 'fire', 2); // right takes fire, aim takes left
    im.bindingsChanged();
    ev('mousedown', 2);
    im.sample(DT);
    expect(im.intents[0].rt).toBe(1);
    expect(im.intents[0].lt).toBe(0);
  });

  it('prompts name the key bound on each layout, and follow a rebinding', () => {
    const { im } = kbInput();
    expect(promptLabel({ kind: 'kb', set: 1 }, 'RT')).toBe('F');
    expect(promptLabel({ kind: 'kb', set: 1 }, 'A')).toBe('G');
    expect(promptLabel({ kind: 'kb', set: 2 }, 'Y')).toBe('Enter');
    assignBinding('kb', im.settings.bindings.kb[0], 'interact', 'KeyJ');
    im.bindingsChanged();
    expect(promptLabel({ kind: 'kb', set: 1 }, 'A')).toBe('J');
  });
});

describe('rebinding capture', () => {
  it('takes the next key, and the game sees no input meanwhile or just after', () => {
    const { im, key } = kbInput();
    let got: unknown = null;
    im.captureNext('kb', (r) => (got = r));
    expect(im.capturing).toBe(true);
    key('keydown', 'KeyG'); // would be Interact
    expect(got).toEqual({ value: 'KeyG' });
    expect(im.capturing).toBe(false);
    im.sample(DT);
    expect(im.intents[0].held).toBe(0);
    for (let i = 0; i < 30; i++) im.sample(DT);
    key('keyup', 'KeyG');
    key('keydown', 'KeyG');
    im.sample(DT);
    expect(im.intents[0].held & (1 << Btn.A)).not.toBe(0);
  });

  it('Esc cancels, Delete unbinds, and held-key repeats do not count', () => {
    const { im, key } = kbInput();
    let got: unknown = null;
    im.captureNext('kb', (r) => (got = r));
    key('keydown', 'KeyQ', true);
    expect(got).toBeNull();
    key('keydown', 'Escape');
    expect(got).toBe('cancel');
    im.captureNext('kb', (r) => (got = r));
    key('keydown', 'Delete');
    expect(got).toBe('clear');
  });

  it('takes the next pad button, ignoring one already down when it started, and Start cancels', () => {
    const { im, down } = padInput();
    down.add(Btn.A); // the press that opened the menu row
    let got: unknown = null;
    im.captureNext('pad', (r) => (got = r));
    im.sample(DT);
    expect(got).toBeNull();
    down.add(Btn.X);
    im.sample(DT);
    expect(got).toEqual({ value: Btn.X });
    im.captureNext('pad', (r) => (got = r));
    down.add(Btn.Start);
    im.sample(DT);
    expect(got).toBe('cancel');
  });

  it('takes a mouse button', () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { pointerLockElement: null as unknown });
    const im = new InputManager(win as unknown as Window);
    im.attachMouse({ ownerDocument: doc, requestPointerLock: () => {} } as unknown as HTMLElement);
    let got: unknown = null;
    im.captureNext('mouse', (r) => (got = r));
    win.dispatchEvent(Object.assign(new Event('mousedown', { cancelable: true }), { button: 3 }));
    expect(got).toEqual({ value: 3 });
  });
});

describe('saved control settings', () => {
  it('round-trips and clamps what a hand-edited file could break', () => {
    const a = new InputManager(new EventTarget() as unknown as Window);
    a.settings.lookSens = [1.7, 0.6];
    a.settings.invertLookY = [true, false];
    a.settings.toggleCrouch = [false, true];
    a.settings.firstPerson = [true, false];
    a.settings.fpFov = 90;
    assignBinding('kb', a.settings.bindings.kb[0], 'fire', 'KeyJ');
    const saved = JSON.parse(JSON.stringify(a.exportSettings()));
    const b = new InputManager(new EventTarget() as unknown as Window);
    b.importSettings(saved);
    expect(b.settings).toEqual(a.settings);
    const c = new InputManager(new EventTarget() as unknown as Window);
    c.importSettings({ lookSens: [99, -4], fpFov: 5, deadzone: 'x', toggleCrouch: 'no' });
    expect(c.settings.lookSens).toEqual([2.5, 0.4]);
    expect(c.settings.fpFov).toBe(70);
    expect(c.settings.deadzone).toBe(defaultSettings().deadzone);
    expect(c.settings.toggleCrouch).toEqual([true, true]);
  });
});

// ----------------------------------------------------------------------------------------- the camera

function leg() {
  const h = fakeServices();
  const sc = new LegScene(h.svc, legById('L1'));
  for (const p of sc.players) p.exitVehicle(false);
  run(sc, 0.5);
  return { sc, ...h };
}

const tap = (h: ReturnType<typeof leg>, i: 0 | 1, btn: number) => {
  h.intents[i].pressed |= 1 << btn;
  h.intents[i].held |= 1 << btn;
  run(h.sc, DT);
  h.intents[i].pressed &= ~(1 << btn);
  h.intents[i].held &= ~(1 << btn);
  run(h.sc, DT);
};

describe('first and third person', () => {
  it('the View button switches a seat on foot, remembers it, and switches back', () => {
    const h = leg();
    const p = h.sc.players[0];
    expect(p.firstPerson).toBe(false);
    tap(h, 0, Btn.View);
    expect(p.firstPerson).toBe(true);
    expect(h.input.settings.firstPerson[0]).toBe(true);
    expect(h.input.settings.firstPerson[1]).toBe(false);
    tap(h, 0, Btn.View);
    expect(p.firstPerson).toBe(false);
    expect(h.input.settings.firstPerson[0]).toBe(false);
    h.sc.dispose();
  }, 60000);

  it('the camera sits at the eyes and looks along the aim', () => {
    const h = leg();
    const p = h.sc.players[0];
    tap(h, 0, Btn.View);
    p.aimYaw = 0.6;
    p.aimPitch = 0.2;
    h.sc.renderFrame(1, DT);
    h.sc.renderFrame(1, DT);
    const cam = h.R.views[0].camera;
    expect(cam.position.y - p.pos.y).toBeGreaterThan(1.4);
    expect(cam.position.y - p.pos.y).toBeLessThan(1.8);
    expect(Math.hypot(cam.position.x - p.pos.x, cam.position.z - p.pos.z)).toBeLessThan(0.3);
    const d = new THREE.Vector3();
    cam.getWorldDirection(d);
    expect(Math.atan2(d.x, d.z)).toBeCloseTo(0.6, 1);
    expect(Math.asin(d.y)).toBeCloseTo(0.2, 1);
    // The renderer is told this view is first person.
    expect((h.R.views[0] as { first?: boolean }).first).toBe(true);
    expect((h.R.views[1] as { first?: boolean }).first).toBeFalsy();
    h.sc.dispose();
  }, 60000);

  it('crouching lowers the eyes', () => {
    const h = leg();
    const p = h.sc.players[0];
    tap(h, 0, Btn.View);
    h.sc.renderFrame(1, DT);
    const stand = h.R.views[0].camera.position.y - p.pos.y;
    tap(h, 0, Btn.B);
    for (let i = 0; i < 30; i++) h.sc.renderFrame(1, DT);
    expect(h.R.views[0].camera.position.y - p.pos.y).toBeLessThan(stand - 0.3);
    h.sc.dispose();
  }, 60000);

  it('hides the owner from their own view only, and puts them back after', () => {
    const h = leg();
    const p = h.sc.players[0];
    const body = (p.human as unknown as { bodyMeshes: THREE.Mesh[] }).bodyMeshes;
    expect(body.length).toBeGreaterThan(5);
    tap(h, 0, Btn.View);
    (h.R.onBeforeView[2] as (i: number) => void)(0);
    expect(body.every((m) => !m.visible)).toBe(true);
    (h.R.onAfterView[0] as (i: number) => void)(0);
    expect(body.every((m) => m.visible)).toBe(true);
    // The partner's view is drawn with the body showing.
    (h.R.onBeforeView[2] as (i: number) => void)(1);
    expect(body.every((m) => m.visible)).toBe(true);
    (h.R.onAfterView[0] as (i: number) => void)(1);
    h.sc.dispose();
  }, 60000);

  it('leaving a seat in third person never hides anyone', () => {
    const h = leg();
    const p = h.sc.players[0];
    const body = (p.human as unknown as { bodyMeshes: THREE.Mesh[] }).bodyMeshes;
    (h.R.onBeforeView[2] as (i: number) => void)(0);
    expect(body.every((m) => m.visible)).toBe(true);
    h.sc.dispose();
  }, 60000);

  it('driving in first person puts the eyes at the driver and hides the driver; look springs back', () => {
    const h = leg();
    const p = h.sc.players[0];
    const v = p.ownVehicle!;
    const [x, , z] = v.doorPos(1);
    p.placeAt(x, z, 0);
    run(h.sc, 0.3);
    expect(p.tryEnter()).toBe(true);
    run(h.sc, 2);
    expect(p.state).toBe('driving');
    tap(h, 0, Btn.View);
    expect(p.firstPerson).toBe(true);
    h.sc.renderFrame(1, DT);
    h.sc.renderFrame(1, DT);
    const cam = h.R.views[0].camera;
    const car = v.position;
    expect(Math.hypot(cam.position.x - car.x, cam.position.z - car.z)).toBeLessThan(2.2);
    expect(cam.position.y).toBeGreaterThan(car.y);
    const driver = v.visual.driver!;
    (h.R.onBeforeView[2] as (i: number) => void)(0);
    expect(driver.root.visible).toBe(false);
    (h.R.onAfterView[0] as (i: number) => void)(0);
    expect(driver.root.visible).toBe(true);
    // Stick right looks right, and lets go to the heading again.
    h.intents[0].look[0] = 1;
    run(h.sc, 0.5);
    for (let i = 0; i < 40; i++) h.sc.renderFrame(1, DT);
    const d = new THREE.Vector3();
    cam.getWorldDirection(d);
    const heading = new THREE.Vector3(Math.sin(v.yaw), 0, Math.cos(v.yaw));
    expect(d.x * heading.z - d.z * heading.x).toBeLessThan(-0.3); // looked right of the heading
    h.intents[0].look[0] = 0;
    run(h.sc, 1.5);
    for (let i = 0; i < 40; i++) h.sc.renderFrame(1, DT); // the camera filters toward the heading over a few frames
    cam.getWorldDirection(d);
    expect(d.dot(heading)).toBeGreaterThan(0.97);
    h.sc.dispose();
  }, 60000);

  it('hold-to-crouch follows the control setting', () => {
    const h = leg();
    const p = h.sc.players[0];
    h.input.settings.toggleCrouch[0] = false;
    h.intents[0].held |= 1 << Btn.B;
    run(h.sc, 0.2);
    expect(p.crouch).toBe(true);
    h.intents[0].held &= ~(1 << Btn.B);
    run(h.sc, 0.2);
    expect(p.crouch).toBe(false);
    h.sc.dispose();
  }, 60000);
});
