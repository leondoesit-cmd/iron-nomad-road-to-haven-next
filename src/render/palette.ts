import * as THREE from 'three';

/** Player 1 is orange and Player 2 is blue: a colour-blind-safe pair used on HUD, vehicle decals and cursors. */
export const PLAYER_COLORS = [0xff8a1f, 0x2f9bff] as const;
export const PLAYER_CSS = ['#ff8a1f', '#2f9bff'] as const;

export const C = {
  metal: 0x6b6f73,
  darkMetal: 0x34383b,
  steel: 0x8a9096,
  rust: 0x8a4b2d,
  rust2: 0x6e3a22,
  rubber: 0x1b1b1d,
  tire: 0x262626,
  hub: 0x9a9a9a,
  seat: 0x2a2623,
  glass: 0x1d2c3a,
  light: 0xfff0b8,
  tarp: 0x2c6a9a,
  signYellow: 0xe8c030,
  wood: 0x8a6a42,
  woodDark: 0x5c4529,
  bone: 0xe8e0cc,
  sand: 0xb99a6a,
  skin: 0xd0a07c,
  cloth: 0x4a4f3a,
  raiderRed: 0xd9482a,
  raiderFlag: 0xff5a1f,
  concrete: 0x8c8f8c,
  concreteDark: 0x5c605e,
  cairn: 0xf4f0e6,
  zombieSkin: 0x7f9a6e,
  zombieSkin2: 0x8d8a6a,
  zombieCloth: 0x5b5547,
  brute: 0x6b4a40,
  bloater: 0x93a05a,
  screamer: 0xa59ab8,
  stalker: 0x5c6b78,
  fuel: 0xc83a28,
  diesel: 0xd2a818,
  gold: 0xffc14a,
  tech: 0x3adc9c,
  medicine: 0xf2f2f2,
  fragment: 0x3ad0ff,
  chassis: 0x2c88d8,
};

export const col = (hex: number) => new THREE.Color(hex);

export const BIOME_GROUND = {
  wasteland: {
    hardpan: [0.62, 0.5, 0.36],
    sand: [0.8, 0.67, 0.44],
    mud: [0.34, 0.27, 0.21],
    asphalt: [0.2, 0.2, 0.215],
    cliff: [0.52, 0.29, 0.2],
    cliff2: [0.7, 0.46, 0.3],
  },
  city: {
    hardpan: [0.3, 0.31, 0.3],
    sand: [0.3, 0.31, 0.3],
    mud: [0.25, 0.26, 0.25],
    asphalt: [0.18, 0.19, 0.2],
    cliff: [0.3, 0.32, 0.31],
    cliff2: [0.4, 0.4, 0.38],
  },
} as const;
