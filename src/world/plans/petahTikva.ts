import type { CityPlan, PlanBlock, PlanLot, PlanStrip } from '../cityPlan';

/**
 * The old centre of Petah Tikva, "Em HaMoshavot" (Mother of the Colonies), founded in 1878 beside the Yarkon.
 *
 * What comes from published descriptions of the city: the street names; that Founders' Square is bounded by Haim Ozer,
 * Stampfer, HaBaron Hirsch, Pinsker, Ussishkin and Hovevei Zion streets, on two levels (a raised lawn and a paved street
 * level), with a fountain where the first well was dug and five plaques for the founders; that the Great Synagogue
 * (Beit Yaacov, 1900, paid for by Rothschild) stands on Hovevei Zion Street; that City Hall is on Haim Ozer Street; and
 * that the shopping core lies among HaBaron Hirsch/Stampfer, Haim Ozer, HaHistadrut and Rothschild. City Hall's shape
 * (tower, two wings, car park) and Shawarma Malabes's shopfront come from photographs of the real places.
 *
 * What is invented to suit the engine: which side of the spine things are on, every distance, block depth and building
 * height, and the straightening of the real street pattern onto a single spine with a rectilinear grid either side.
 * It is a recreation in the spirit of a game level, not a survey, and it is meant to be redrawn: edit the tables below.
 *
 * Driving north up Haim Ozer Street from Jabotinsky Road you pass the shopping lanes, then Founders' Square with
 * the Great Synagogue across Hovevei Zion Street, then City Hall and its car park with Shawarma Malabes directly across
 * the street from it. "Left" and "right" below are
 * as seen heading north (+z), so side +1 is on the driver's left.
 */

// ------------------------------------------------------------------ blocks (south to north along Haim Ozer)

/** Indices the landmark lots below refer to. */
export const PT_BLOCK = {
  jabotinsky: 2,
  herzl: 7,
  stampfer: 9,
  square: 10,
  pinsker: 11,
  cityHall: 12,
} as const;

const blocks: PlanBlock[] = [
  { len: 70, cross: 6 },
  { len: 62, cross: 6 },
  { len: 58, cross: 16, street: 'jabotinsky' }, // 2
  { len: 48, cross: 6 },
  { len: 56, cross: 8 },
  { len: 44, cross: 6 },
  { len: 60, cross: 6 },
  { len: 50, cross: 12, street: 'herzl' }, // 7
  { len: 54, cross: 6 },
  { len: 56, cross: 12, street: 'stampfer' }, // 9
  { len: 62, cross: 12, street: 'baronHirsch' }, // 10: Founders' Square and the Great Synagogue
  { len: 46, cross: 8, street: 'pinsker' }, // 11
  { len: 58, cross: 10, street: 'ussishkin' }, // 12: City Hall and its car park
  { len: 52, cross: 6 },
  { len: 60, cross: 6 },
  { len: 48, cross: 8 },
  { len: 56, cross: 6 },
  { len: 50, cross: 12 },
  { len: 58, cross: 6 },
  { len: 54, cross: 6 },
  { len: 52, cross: 8 },
  { len: 60, cross: 6 },
  { len: 48, cross: 6 },
  { len: 56, cross: 6 },
  { len: 50, cross: 6 },
  { len: 60, cross: 6 },
  { len: 52, cross: 6 },
  { len: 58, cross: 6 },
  { len: 50, cross: 6 },
];

// ------------------------------------------------------------------ building columns either side

// Left of Haim Ozer (side +1): Founders' Square, then Hovevei Zion Street, then the Great Synagogue, then HaHistadrut Street.
const left: PlanStrip[] = [
  { w: 34, gap: 12, street: 'hovevei' },
  { w: 24, gap: 3.6 },
  { w: 22, gap: 14, street: 'histadrut' },
  { w: 28, gap: 0 },
];

// Right of Haim Ozer (side -1): the commercial core and City Hall, with Rothschild Street one column in.
const right: PlanStrip[] = [
  { w: 40, gap: 14, street: 'rothschild' },
  { w: 24, gap: 3.6 },
  { w: 22, gap: 5 },
  { w: 30, gap: 0 },
];

// ------------------------------------------------------------------ landmark and shopfront lots

const sq = PT_BLOCK.square;
const hall = PT_BLOCK.cityHall;

/** The old shopping streets: low, brick and stucco, two or three floors. */
const shopfront = (side: -1 | 1, strip: number, block: number, style: number, floors: number): PlanLot => ({ side, strip, block, kind: 'building', style, floors });

const lots: PlanLot[] = [
  // Founders' Square: the open ground between Haim Ozer, Stampfer, HaBaron Hirsch and Hovevei Zion.
  { side: 1, strip: 0, block: sq, kind: 'open', landmark: 'foundersSquare' },
  // The Great Synagogue stands across Hovevei Zion Street from the square, its front towards the square.
  {
    side: 1,
    strip: 1,
    block: sq,
    kind: 'open',
    landmark: 'greatSynagogue',
    buildings: [{ role: 'synagogue', rect: [8, 24, 12, 50], floors: 3, style: 2, tint: 0xdccfae, front: 'w' }],
  },
  // City Hall, drawn from a photograph of the real one: a tall square tower at one end of a four-storey wing, a long
  // six-storey wing at right angles with a colonnade under it, and the car park they enclose open to Haim Ozer Street.
  {
    side: -1,
    strip: 0,
    block: hall,
    kind: 'open',
    landmark: 'cityHall',
    buildings: [
      { role: 'hallWing', rect: [0, 11, 0, 46], floors: 4, style: 0, tint: 0xe2d8bd, front: 'e' },
      { role: 'hallTower', rect: [0, 11, 46, 57], floors: 9, style: 0, tint: 0xd8c9a6, front: 'e' },
      { role: 'hallSide', rect: [11, 40, 0, 11], floors: 6, style: 0, tint: 0xcdbb94, front: 'n' },
    ],
  },
  // The shopping streets round Stampfer: two and three storeys, brick and stucco.
  shopfront(-1, 0, 8, 1, 3),
  shopfront(-1, 0, 9, 2, 3),
  shopfront(-1, 0, sq, 1, 3),
  shopfront(-1, 1, 8, 2, 2),
  shopfront(-1, 1, 9, 1, 3),
  shopfront(-1, 1, sq, 2, 3),
  shopfront(1, 0, 8, 2, 3),
  shopfront(1, 0, 9, 1, 2),
  // Shawarma Malabes, on the other side of Haim Ozer Street from City Hall, facing its car park.
  { side: 1, strip: 0, block: hall, kind: 'building', style: 2, floors: 3, shop: 'malabes' },
  shopfront(1, 1, 8, 1, 3),
  shopfront(1, 1, 9, 2, 3),
];

export const PETAH_TIKVA: CityPlan = {
  id: 'petahTikva',
  startZ: -220,
  spine: 'haimOzer',
  streets: [
    { id: 'haimOzer', name: 'HAIM OZER STREET', sub: 'רחוב חיים עוזר · the main drag, and City Hall\u2019s street' },
    { id: 'jabotinsky', name: 'JABOTINSKY ROAD', sub: 'דרך ז׳בוטינסקי' },
    { id: 'herzl', name: 'HERZL STREET', sub: 'רחוב הרצל' },
    { id: 'stampfer', name: 'STAMPFER STREET', sub: 'רחוב שטמפפר · named for Yehoshua Stampfer, one of the founders' },
    { id: 'baronHirsch', name: 'HABARON HIRSCH STREET', sub: 'רחוב הברון הירש' },
    { id: 'pinsker', name: 'PINSKER STREET', sub: 'רחוב פינסקר' },
    { id: 'ussishkin', name: 'USSISHKIN STREET', sub: 'רחוב אוסישקין' },
    { id: 'hovevei', name: 'HOVEVEI ZION STREET', sub: 'רחוב חובבי ציון · Founders’ Square and the Great Synagogue stand on it' },
    { id: 'rothschild', name: 'ROTHSCHILD STREET', sub: 'רחוב רוטשילד · named for the Baron whose money kept the moshava alive' },
    { id: 'histadrut', name: 'HAHISTADRUT STREET', sub: 'רחוב ההסתדרות' },
  ],
  blocks,
  sides: { '-1': right, '1': left },
  lots,
  places: [
    { id: 'foundersSquare', name: 'FOUNDERS’ SQUARE', sub: 'כיכר המייסדים · where the first well was dug, 1878', side: 1, strip: 0, block: sq, r: 34 },
    { id: 'greatSynagogue', name: 'THE GREAT SYNAGOGUE', sub: 'בית הכנסת הגדול · Beit Yaacov, finished in 1900 with Rothschild’s money', side: 1, strip: 1, block: sq, r: 30 },
    { id: 'cityHall', name: 'CITY HALL', sub: 'עיריית פתח תקווה · Haim Ozer Street', side: -1, strip: 0, block: hall, r: 36 },
    { id: 'malabes', name: 'SHAWARMA MALABES', sub: 'שווארמה מלאבס · across the street from City Hall', side: 1, strip: 0, block: hall, r: 32 },
  ],
  buildingShare: 0.84,
  floors: { near: [2, 5], far: [3, 9] },
};
