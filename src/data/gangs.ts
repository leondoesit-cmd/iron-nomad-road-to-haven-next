/** The raider gangs of the open world. Each holds a stretch of country and hangs its colours over every camp in it. */
export type GangId = 'jackals' | 'ashchoir' | 'saltkings';

export interface GangDef {
  id: GangId;
  name: string;
  /** Banner colour index (see `TAG_COL` in render/props.ts). */
  tag: number;
  jacket: number;
  trim: number;
  helmet: number;
  /** A line the radio gives when you first come in sight of one of their camps. */
  warning: string;
}

export const GANGS: Record<GangId, GangDef> = {
  jackals: {
    id: 'jackals',
    name: 'Rust Jackals',
    tag: 7,
    jacket: 0xd9482a,
    trim: 0x151515,
    helmet: 0x111111,
    warning: 'Red rags on poles. That is a Rust Jackals camp: they shoot first and strip what is left.',
  },
  ashchoir: {
    id: 'ashchoir',
    name: 'Ash Choir',
    tag: 5,
    jacket: 0x6a5a4c,
    trim: 0xe0832a,
    helmet: 0x2a2420,
    warning: 'Orange banners and a column of smoke. The Ash Choir burn what they cannot carry. Keep your distance.',
  },
  saltkings: {
    id: 'saltkings',
    name: 'Salt Kings',
    tag: 6,
    jacket: 0xcfcab8,
    trim: 0x3fbf6a,
    helmet: 0x39422f,
    warning: 'Green flags, white coats. Salt Kings: well fed, well armed and they count every round.',
  },
};

export const GANG_IDS = Object.keys(GANGS) as GangId[];
