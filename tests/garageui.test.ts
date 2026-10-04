import { describe, expect, it } from 'vitest';
import { GarageView, type GarageHost } from '../src/ui/garage';
import { Campaign } from '../src/game/campaign';
import { installPart, newBuild, statsOf, type VehicleBuild } from '../src/sim/garage';
import { newPart } from '../src/sim/parts';
import { forecastSwap } from '../src/sim/forecast';
import { SPRAY_CHARGES } from '../src/sim/paint';

/** A host with no DOM: buttons are strings, actions are kept so a test can "press" them. */
function host(mode: 'ledger' | 'field' = 'ledger', builds?: VehicleBuild[]) {
  const c = new Campaign(undefined, false);
  if (builds) {
    c.garage.push(...builds);
    c.players[0].vehicle = builds[0].uid;
    if (builds[1]) c.players[1].vehicle = builds[1].uid;
  }
  const acts = new Map<string, () => void>();
  const log: { msg: string; ok: boolean }[] = [];
  let refreshed = 0;
  const h: GarageHost = {
    c,
    mode,
    players: [0, 1],
    build: (i) => c.buildOf(i),
    btn: (id, label, act, enabled = true, title = '') => {
      acts.set(id, () => act(0));
      return `<button data-fid="${id}" ${enabled ? '' : 'disabled'} title="${title}">${label}</button>`;
    },
    refresh: () => void refreshed++,
    rerender: () => {},
    say: (msg, ok) => void log.push({ msg, ok }),
    takeCan: (i, color) => void log.push({ msg: `can ${i} ${color}`, ok: true }),
  };
  const view = new GarageView(h);
  const press = (id: string) => {
    const a = acts.get(id);
    if (!a) throw new Error(`no button ${id}`);
    a();
  };
  return { c, view, press, log, acts, refreshed: () => refreshed };
}

describe('the garage shows what is really in each mount', () => {
  it('a stock vehicle lists its factory engine and radiator by name, not "Stock"', () => {
    const { view } = host();
    const html = view.html();
    expect(html).toMatch(/50cc Scooter Motor/);
    expect(html).toMatch(/Scooter Cooling Fins/);
    expect(html).toMatch(/Fuel & cargo/);
  });

  it('a V8 in a hatchback is flagged as forced in and as a radiator problem', () => {
    const b = newBuild('hatch', { seed: 1 });
    installPart(b, newPart('eng_v8', 0.9));
    const { view } = host('ledger', [b]);
    const html = view.html();
    expect(html).toMatch(/5\.7 L V8/i);
    expect(html).toMatch(/CUT HOOD OR REMOVE/);
    expect(html).toMatch(/WILL OVERHEAT/);
  });

  it('a diesel van with a petrol engine says the engine burns petrol and offers to drain the tank', () => {
    const b = newBuild('van', { seed: 1, fuel: 0.8 });
    installPart(b, newPart('eng_i4', 0.9));
    const { view, press, c } = host('ledger', [b]);
    const html = view.html();
    expect(html).toMatch(/ENGINE BURNS PETROL/);
    expect(html).toMatch(/data-fid="drain0"/);
    const diesel0 = c.items.diesel;
    const had = b.fuel * statsOf(b).tank;
    press('drain0');
    expect(b.fuel).toBe(0);
    expect(b.tank).toBe('petrol');
    expect(c.items.diesel).toBeCloseTo(diesel0 + had, 5);
    // And the card no longer complains.
    expect(view.html()).not.toMatch(/ENGINE BURNS/);
    expect(view.html()).not.toMatch(/data-fid="drain0"/);
  });

  it('a tank holding the right fuel has no drain button', () => {
    const { view } = host();
    expect(view.html()).not.toMatch(/data-fid="drain0"/);
  });
});

describe('fitting from the picker', () => {
  it('opening the engine slot lists spares with a forecast, and fitting one reports a wrong-fuel warning', () => {
    const b = newBuild('van', { seed: 1, fuel: 0.8 });
    const { view, press, c, log } = host('ledger', [b]);
    c.inventory.push(newPart('eng_i4', 0.9), newPart('rad_race_m', 0.9));
    view.html();
    press('slot0-engine');
    expect(view.sel).toEqual({ i: 0, slot: 'engine' });
    const html = view.html();
    expect(html).toMatch(/Rebuilt Inline-4/);
    expect(html).toMatch(/class="fcast"/);
    // Only engines are offered in the engine slot (the spares list further down shows everything).
    const radUid = c.inventory.find((p) => p.id === 'rad_race_m')!.uid;
    expect(html).not.toContain(`data-fid="fit0-${radUid}"`);
    const uid = c.inventory.find((p) => p.id === 'eng_i4')!.uid;
    expect(html).toContain(`data-fid="fit0-${uid}"`);
    press(`fit0-${uid}`);
    expect(b.fit.engine?.id).toBe('eng_i4');
    expect(c.inventory.some((p) => p.id === 'eng_d30')).toBe(true);
    expect(log.at(-1)!.msg).toMatch(/Wrong fuel/);
    expect(log.at(-1)!.ok).toBe(false);
  });

  it('the fabricate list never offers a factory fitting', () => {
    const { view } = host();
    view.sel = { i: 0, slot: 'engine' };
    const html = view.html();
    expect(html).toMatch(/Supercharged V8/);
    expect(html).toMatch(/Tuned V6/);
    expect(html).not.toMatch(/mk0-eng_50cc/);
    expect(html).not.toMatch(/data-fid="mk0-eng_none"/);
    view.sel = { i: 0, slot: 'cooling' };
    expect(view.html()).toMatch(/Large Race Radiator/);
    expect(view.html()).not.toMatch(/data-fid="mk0-rad_moped"/);
  });

  it('taking the engine off leaves an empty mount that is shown as one', () => {
    const { view, press, c } = host();
    view.sel = { i: 0, slot: 'engine' };
    view.html();
    press('rm0');
    expect(c.buildOf(0).fit.engine?.id).toBe('eng_none');
    expect(c.inventory.some((p) => p.id === 'eng_50cc')).toBe(true);
    const html = view.html();
    expect(html).toMatch(/NO ENGINE/);
    expect(html).toMatch(/emptymount/);
  });
});

describe('forecasting a swap', () => {
  it('says what a big engine in a small car costs', () => {
    const b = newBuild('hatch', { seed: 1, fuel: 1 });
    const f = forecastSwap(b, 'engine', newPart('eng_v8'));
    expect(f.powerKw).toBe(260);
    expect(f.powerBefore).toBe(50);
    expect(f.topKmh).toBeGreaterThan(f.topBefore);
    expect(f.rangeKm).toBeLessThan(f.rangeBefore);
    expect(f.bay).toBe('cut');
    expect(f.heat.verdict).toBe('overheats');
    expect(f.notes.join(' ')).toMatch(/radiator/i);
    expect(f.wrongFuel).toBe(false);
  });
  it('adding the radiator fixes the forecast', () => {
    const b = newBuild('hatch', { seed: 1, fuel: 1 });
    installPart(b, newPart('eng_v8'));
    const f = forecastSwap(b, 'cooling', newPart('rad_desert'));
    expect(f.heatBefore.verdict).toBe('overheats');
    expect(f.heat.verdict).toBe('cool');
  });
  it('a diesel into a petrol car is a wrong-fuel forecast while the tank holds petrol', () => {
    const b = newBuild('sedan', { seed: 1, fuel: 0.9 });
    const f = forecastSwap(b, 'engine', newPart('eng_d4'));
    expect(f.wrongFuel).toBe(true);
    expect(f.fuel).toBe('diesel');
    // With a dry tank there is nothing to be wrong.
    b.fuel = 0;
    expect(forecastSwap(b, 'engine', newPart('eng_d4')).wrongFuel).toBe(false);
  });
  it('pulling the engine forecasts no power', () => {
    const b = newBuild('sedan', { seed: 1 });
    const f = forecastSwap(b, 'engine', null);
    expect(f.powerKw).toBe(0);
    expect(f.notes.join(' ')).toMatch(/No engine/);
  });
});

describe('painting from the garage', () => {
  it('a swatch paints the whole vehicle by default, or one panel once a panel is chosen', () => {
    const b = newBuild('sedan', { seed: 1, paint: 0x336699 });
    const { view, press, c } = host('ledger', [b]);
    void c;
    expect(view.html()).toMatch(/data-fid="ptgt0-doorL"/);
    press('paint0-hazard');
    expect(b.paint).toBe(14728730);
    expect(b.panels).toBeUndefined();
    press('ptgt0-doorL');
    press('paint0-rust');
    expect(b.panels).toEqual({ doorL: 12083246 });
    expect(b.paint).toBe(14728730);
    // The whole-vehicle swatch starts again from one colour.
    press('ptgt0-all');
    press('paint0-sand');
    expect(b.panels).toBeUndefined();
    expect(b.paint).toBe(13218180);
  });
  it('washing removes the panel jobs; a moped only has a front and a rear', () => {
    const b = newBuild('sedan', { seed: 1 });
    b.panels = { hood: 1 };
    const { view, press } = host('ledger', [b]);
    expect(view.html()).toMatch(/data-fid="wash0"/);
    press('wash0');
    expect(b.panels).toBeUndefined();
    const html = host().view.html();
    expect(html).toMatch(/data-fid="ptgt0-front"/);
    expect(html).not.toMatch(/data-fid="ptgt0-roof"/);
  });
  it('the workbench offers a spray can in the last colour picked', () => {
    const b = newBuild('sedan', { seed: 1, paint: 0x336699 });
    const { view, press, log } = host('field', [b]);
    expect(view.html()).toMatch(/Take a spray can/);
    press('paint0-teal');
    // The host re-renders after a change; the can is filled with the colour just picked.
    view.html();
    press('can0');
    expect(log.at(-1)!.msg).toBe('can 0 4164228');
    expect(SPRAY_CHARGES).toBe(6);
    // The ledger has no hands to hold one.
    expect(host('ledger', [newBuild('sedan', { seed: 1 })]).view.html()).not.toMatch(/Take a spray can/);
  });
});

describe('the whole machine in the garage', () => {
  it('groups the mounts, and a sedan shows every one it has', () => {
    const { view } = host('ledger', [newBuild('sedan', { seed: 1 })]);
    const html = view.html();
    for (const g of ['Powertrain', 'Running gear', 'Body', 'Fittings']) expect(html).toContain(g);
    for (const id of ['gearbox', 'exhaust', 'suspension', 'brakes', 'hood', 'doorL', 'doorR']) expect(html).toContain(`data-fid="slot0-${id}"`);
    // A moped has no doors or bonnet to list.
    const moped = host('ledger', [newBuild('moped', { seed: 1 })]).view.html();
    expect(moped).not.toContain('data-fid="slot0-hood"');
    expect(moped).not.toContain('data-fid="slot0-doorL"');
    expect(moped).toContain('data-fid="slot0-gearbox"');
  });

  it('shows one button per wheel, and a spare tyre goes on the wheel picked, not all four', () => {
    const b = newBuild('sedan', { seed: 1 });
    const { view, press, c } = host('ledger', [b]);
    c.inventory.push(newPart('whl_bl', 0.8));
    const html = view.html();
    for (let n = 0; n < 4; n++) expect(html).toContain(`data-fid="slot0-wheels${n}"`);
    press('slot0-wheels2');
    expect(view.sel).toEqual({ i: 0, slot: 'wheels', wheel: 2 });
    view.html();
    const uid = c.inventory.find((p) => p.id === 'whl_bl')!.uid;
    press(`fit0-${uid}`);
    expect(b.tyres[2]?.id).toBe('whl_bl');
    expect(b.tyres[0]).toBeNull();
    expect(b.tyres[1]).toBeNull();
    expect(b.tyres[3]).toBeNull();
    // The sedan's own tyre came off that wheel as a real part.
    expect(c.inventory.some((p) => p.id === 'tyre_sedan')).toBe(true);
    // Taking it off leaves a bare rim that is shown as one.
    view.html();
    press('rm0');
    expect(b.tyres[2]?.id).toBe('tyre_none');
    expect(view.html()).toMatch(/Bare rim/);
  });

  it('pulling the bonnet and a door leaves empty mounts, and a door fitted to the other side stays there', () => {
    const b = newBuild('sedan', { seed: 1 });
    const { view, press, c } = host('ledger', [b]);
    view.sel = { i: 0, slot: 'hood' };
    view.html();
    press('rm0');
    expect(b.fit.hood?.id).toBe('hood_none');
    view.sel = { i: 0, slot: 'doorR' };
    view.html();
    press('rm0');
    expect(b.fit.doorR?.id).toBe('door_none');
    expect(view.html()).toMatch(/NO BONNET/);
    expect(view.html()).toMatch(/1 DOOR OFF/);
    c.inventory.push(newPart('door_armor', 1));
    view.html();
    const uid = c.inventory.find((p) => p.id === 'door_armor')!.uid;
    press(`fit0-${uid}`);
    expect(b.fit.doorR?.id).toBe('door_armor');
    expect(b.fit.doorL?.id).toBeUndefined();
  });

  it('warns about a V8 on a moped gearbox and springs, and the gearbox picker shows the fix', () => {
    const b = newBuild('moped', { seed: 1 });
    installPart(b, newPart('eng_v8', 1));
    const { view } = host('ledger', [b]);
    const html = view.html();
    expect(html).toMatch(/OVERSTRAINED/);
    expect(html).toMatch(/SAGGING/);
    const f = forecastSwap(b, 'engine', newPart('eng_v8', 1));
    void f;
    const g = forecastSwap(newBuild('moped', { seed: 1 }), 'engine', newPart('eng_v8', 1));
    expect(g.notes.join(' ')).toMatch(/gearbox is overstrained/);
    expect(g.notes.join(' ')).toMatch(/springs are overloaded/);
    expect(g.sumpL).toBeGreaterThan(g.sumpBefore);
    expect(g.coolantL).toBeGreaterThan(g.coolantBefore);
    const fix = forecastSwap(b, 'gearbox', newPart('gbx_transfer', 1));
    expect(fix.strain).toBeLessThan(fix.strainBefore);
    view.sel = { i: 0, slot: 'gearbox' };
    expect(view.html()).toMatch(/strain/);
  });

  it('tops up the radiator in litres from the water reserve', () => {
    const b = newBuild('hatch', { seed: 1 });
    b.comp.coolant = 0.2;
    const { view, press, c } = host('ledger', [b]);
    c.items.water = 12;
    expect(view.html()).toMatch(/data-fid="water0"/);
    press('water0');
    expect(b.comp.coolant).toBeGreaterThan(0.9);
    expect(c.items.water).toBeLessThan(12);
    // A water level bar is on the card.
    expect(view.html()).toMatch(/WATER/);
  });

  it('oil from the reserve fills a big sump slower than a small one', () => {
    const small = newBuild('moped', { seed: 1 });
    const big = newBuild('moped', { seed: 1 });
    installPart(big, newPart('eng_v8', 1));
    small.comp.oil = 0.2;
    big.comp.oil = 0.2;
    const a = host('ledger', [small]);
    a.c.items.oil = 0.5;
    a.view.html();
    a.press('oil0');
    const z = host('ledger', [big]);
    z.c.items.oil = 0.5;
    z.view.html();
    z.press('oil0');
    expect(small.comp.oil).toBeGreaterThan(big.comp.oil);
  });
});
