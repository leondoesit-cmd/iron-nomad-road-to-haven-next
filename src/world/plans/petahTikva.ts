import type { CityPlan, PlanBlock, PlanLot, PlanStrip } from '../cityPlan';

/**
 * The centre of Petah Tikva, "Em HaMoshavot" (Mother of the Colonies), founded in 1878 beside the Yarkon.
 *
 * What comes from published descriptions and map data of the real place: the street names; that Founders' Square is
 * bounded by Haim Ozer, Stampfer, HaBaron Hirsch, Pinsker, Ussishkin and Hovevei Zion streets, on two levels (a raised
 * lawn and a paved street level), with a fountain where the first well was dug and five plaques for the founders; that the
 * Great Synagogue (Beit Yaacov, 1900, paid for by Rothschild) stands on Hovevei Zion Street; that City Hall is on Haim
 * Ozer Street a couple of hundred metres south of the square, with the shopping core of Rothschild, Stampfer and
 * HaHistadrut between; that the Central Bus Station is about half a kilometre north of the square on Ze'ev Orlov
 * Street and is the end of the Tel Aviv Red Line, which comes in along Jabotinsky Road past Krol and Pinsker; and that
 * HaMoshava Stadium (11,500 seats, two long stands and two low ends, Hapoel's and Maccabi's home) is out beside the
 * Kiryat Arye station on the same line. City Hall's shape and Shawarma Malabes's shopfront come from photographs.
 * The ordinary buildings are dressed as the real ones are: cream-and-sand rendered apartment blocks of three to eight
 * storeys with a balcony under every other window, roller shutters, air-conditioning condensers, solar water heaters on
 * the roof and a shop with a Hebrew sign on the ground floor.
 *
 * What is invented to suit the engine: which side of the spine things are on, every distance (the real ones are
 * stretched out to kilometres; here the walk from City Hall to the stadium is about seven hundred metres), block depth
 * and building height, and the straightening of the real street pattern onto a single spine with a rectilinear grid
 * either side. The light-rail line is shown by its last two hundred metres. It is a recreation in the spirit of a game
 * level, not a survey, and it is meant to be redrawn: edit the tables below.
 *
 * Coming into town from the south, the first thing on the left is Ofer Grand Mall (see `world/mall.ts`), with its
 * footbridge over the street to a plaza and the Prima Link tower on the right.
 *
 * Driving north up Haim Ozer Street you pass City Hall and Shawarma Malabes, the shopping lanes, Founders' Square with
 * the Great Synagogue across Hovevei Zion Street, Pinsker and Krol streets, then Jabotinsky Road with the Red Line
 * down it, and at the top the Central Bus Station with the stadium beyond the next street. "Left" and "right" below are
 * as seen heading north (+z), so side +1 is on the driver's left.
 */

// ------------------------------------------------------------------ blocks (south to north along Haim Ozer)

/** Indices the landmark lots below refer to. */
export const PT_BLOCK = {
  /** The mall fills the first two blocks on the left; there is no cross street between them. */
  mall: 0,
  herzl: 2,
  cityHall: 4,
  shops: 5,
  stampfer: 6,
  square: 7,
  pinsker: 8,
  krol: 11,
  jabotinsky: 13,
  station: 14,
} as const;

const blocks: PlanBlock[] = [
  { len: 76, cross: 0 }, // 0: Ofer Grand Mall, running on into the next block; across the street its plaza and Prima Link
  { len: 62, cross: 6 },
  { len: 56, cross: 12, street: 'herzl' }, // 2
  { len: 52, cross: 6 },
  { len: 58, cross: 10, street: 'ussishkin' }, // 4: City Hall and its car park, Shawarma Malabes across the street
  { len: 60, cross: 6 }, // 5: the shopping lanes
  { len: 56, cross: 12, street: 'stampfer' }, // 6
  { len: 62, cross: 12, street: 'baronHirsch' }, // 7: Founders' Square and the Great Synagogue
  { len: 46, cross: 8, street: 'pinsker' }, // 8
  { len: 54, cross: 6 },
  { len: 60, cross: 6 },
  { len: 50, cross: 12, street: 'krol' }, // 11
  { len: 58, cross: 6 },
  { len: 56, cross: 34, street: 'jabotinsky' }, // 13: Jabotinsky Road, with the Red Line down the middle of it
  { len: 118, cross: 12, street: 'orlov' }, // 14: the Central Bus Station, and HaMoshava Stadium
  { len: 58, cross: 6 },
  { len: 54, cross: 6 },
  { len: 60, cross: 12 },
  { len: 52, cross: 6 },
  { len: 56, cross: 6 },
  { len: 60, cross: 8 },
  { len: 50, cross: 6 },
  { len: 58, cross: 12 },
  { len: 54, cross: 6 },
  { len: 60, cross: 6 },
  { len: 52, cross: 6 },
  { len: 34, cross: 6 },
];

// ------------------------------------------------------------------ building columns either side

// Left of Haim Ozer (side +1): Founders' Square, Hovevei Zion Street, the Great Synagogue, HaHistadrut Street, and at the
// far end a wide column for the stadium.
const left: PlanStrip[] = [
  { w: 34, gap: 10, street: 'hovevei' },
  { w: 24, gap: 3.6 },
  { w: 20, gap: 12, street: 'histadrut' },
  { w: 90, gap: 0 },
];

// Right of Haim Ozer (side -1): City Hall and the commercial core, with Rothschild Street one column in.
const right: PlanStrip[] = [
  { w: 40, gap: 14, street: 'rothschild' },
  { w: 24, gap: 3.6 },
  { w: 22, gap: 5 },
  { w: 30, gap: 0 },
];

// ------------------------------------------------------------------ landmark and shopfront lots

const sq = PT_BLOCK.square;
const hall = PT_BLOCK.cityHall;
const stn = PT_BLOCK.station;

/** The old shopping streets: low, rendered and three or four floors, a shop on every ground floor. */
const shopfront = (side: -1 | 1, strip: number, block: number, floors: number): PlanLot => ({ side, strip, block, kind: 'building', style: 2, floors });

const mall = PT_BLOCK.mall;

const lots: PlanLot[] = [
  // Ofer Grand Mall, the first thing on the left coming into town: the whole first column of the first two blocks. It is a
  // real building with floors, shops and stairs, raised by `dressLandmarks` from `world/mall.ts`, not a box on a lot.
  { side: 1, strip: 0, block: mall, kind: 'open', landmark: 'grandMall' },
  { side: 1, strip: 0, block: mall + 1, kind: 'open', fixed: true },
  // Across the street: the plaza the footbridge comes down into, and the Prima Link office tower at its back.
  {
    side: -1,
    strip: 0,
    block: mall,
    kind: 'open',
    landmark: 'mallPlaza',
    buildings: [{ role: 'officeTower', rect: [0, 18, 4, 30], floors: 16, style: 3, tint: 0x4f6774, front: 'e' }],
  },
  { side: -1, strip: 0, block: mall + 1, kind: 'open', fixed: true },
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
  // Shawarma Melabes, Haim Ozer 4, across from City Hall, facing its car park.
  // Address: https://wolt.com/en/isr/petah-tikva/restaurant/shawarma-melabes
  { side: 1, strip: 0, block: hall, kind: 'building', style: 2, floors: 3, shop: 'malabes' },
  // The shopping streets between City Hall and the square: three and four storeys of rendered apartments over shops.
  shopfront(-1, 0, PT_BLOCK.shops, 4),
  shopfront(-1, 0, PT_BLOCK.stampfer, 3),
  shopfront(-1, 0, sq, 4),
  shopfront(-1, 1, PT_BLOCK.shops, 3),
  shopfront(-1, 1, PT_BLOCK.stampfer, 4),
  shopfront(-1, 1, sq, 3),
  shopfront(1, 0, PT_BLOCK.shops, 4),
  shopfront(1, 0, PT_BLOCK.stampfer, 3),
  shopfront(1, 1, PT_BLOCK.shops, 3),
  shopfront(1, 1, PT_BLOCK.stampfer, 4),
  // The Central Bus Station: a five-storey terminal hall along Haim Ozer behind a forecourt of bus bays, and the glass
  // tower of the transport hub beside it, with the Red Line's terminus on Jabotinsky Road in front of both.
  {
    side: 1,
    strip: 0,
    block: stn,
    kind: 'open',
    landmark: 'busStation',
    buildings: [{ role: 'busTerminal', rect: [13, 34, 6, 112], floors: 5, style: 0, tint: 0xd6d0c0, front: 'w' }],
  },
  { side: 1, strip: 1, block: stn, kind: 'building', style: 3, floors: 15, fixed: true },
  // HaMoshava Stadium: a pitch between two long stands and two low ends, the whole of the wide far column.
  {
    side: 1,
    strip: 3,
    block: stn,
    kind: 'open',
    landmark: 'stadium',
    buildings: [
      { role: 'standSide', rect: [0, 17, 6, 112], floors: 4, style: 0, tint: 0xc8c4b8, front: 'e' },
      { role: 'standSide', rect: [73, 90, 6, 112], floors: 5, style: 0, tint: 0xc8c4b8, front: 'w' },
      { role: 'standEnd', rect: [22, 68, 0, 7], floors: 2, style: 0, tint: 0xbab6aa, front: 'n' },
      { role: 'standEnd', rect: [22, 68, 111, 118], floors: 2, style: 0, tint: 0xbab6aa, front: 's' },
    ],
  },
  // The lots beside the stadium and the hub are left open: forecourts, a car park.
  { side: 1, strip: 2, block: stn, kind: 'open' },
];

export const PETAH_TIKVA: CityPlan = {
  id: 'petahTikva',
  startZ: -220,
  spine: 'haimOzer',
  streets: [
    { id: 'haimOzer', name: 'HAIM OZER STREET', sub: 'רחוב חיים עוזר · the main drag, and City Hall\u2019s street' },
    { id: 'jabotinsky', name: 'JABOTINSKY ROAD', sub: 'דרך ז׳בוטינסקי · the Red Line runs down the middle of it' },
    { id: 'herzl', name: 'HERZL STREET', sub: 'רחוב הרצל' },
    { id: 'stampfer', name: 'STAMPFER STREET', sub: 'רחוב שטמפפר · named for Yehoshua Stampfer, one of the founders' },
    { id: 'baronHirsch', name: 'HABARON HIRSCH STREET', sub: 'רחוב הברון הירש' },
    { id: 'pinsker', name: 'PINSKER STREET', sub: 'רחוב פינסקר' },
    { id: 'krol', name: 'KROL STREET', sub: 'רחוב קרול' },
    { id: 'orlov', name: 'ZE’EV ORLOV STREET', sub: 'רחוב זאב אורלוב · the Central Bus Station’s street' },
    { id: 'ussishkin', name: 'USSISHKIN STREET', sub: 'רחוב אוסישקין' },
    { id: 'hovevei', name: 'HOVEVEI ZION STREET', sub: 'רחוב חובבי ציון · Founders’ Square and the Great Synagogue stand on it' },
    { id: 'rothschild', name: 'ROTHSCHILD STREET', sub: 'רחוב רוטשילד · named for the Baron whose money kept the moshava alive' },
    { id: 'histadrut', name: 'HAHISTADRUT STREET', sub: 'רחוב ההסתדרות' },
  ],
  blocks,
  sides: { '-1': right, '1': left },
  lots,
  places: [
    { id: 'grandMall', name: 'OFER GRAND MALL', sub: 'עופר הקניון הגדול פתח תקווה · Jabotinsky Road, the way into town', side: 1, strip: 0, block: mall, r: 70 },
    { id: 'foundersSquare', name: 'FOUNDERS’ SQUARE', sub: 'כיכר המייסדים · where the first well was dug, 1878', side: 1, strip: 0, block: sq, r: 34 },
    { id: 'greatSynagogue', name: 'THE GREAT SYNAGOGUE', sub: 'בית הכנסת הגדול · Beit Yaacov, finished in 1900 with Rothschild’s money', side: 1, strip: 1, block: sq, r: 30 },
    { id: 'cityHall', name: 'CITY HALL', sub: 'עיריית פתח תקווה · Haim Ozer Street', side: -1, strip: 0, block: hall, r: 36 },
    { id: 'malabes', name: 'SHAWARMA MELABES', sub: 'שווארמה מלאבס · Haim Ozer 4 · opposite Petah Tikva City Hall', side: 1, strip: 0, block: hall, r: 32 },
    { id: 'busStation', name: 'CENTRAL BUS STATION', sub: 'התחנה המרכזית פתח תקווה · Ze’ev Orlov Street, the end of the Red Line', side: 1, strip: 0, block: stn, r: 62 },
    { id: 'stadium', name: 'HAMOSHAVA STADIUM', sub: 'אצטדיון המושבה · eleven and a half thousand seats, Hapoel’s and Maccabi’s', side: 1, strip: 3, block: stn, r: 66 },
  ],
  // The Red Line on Jabotinsky Road: the end of the line at the bus station, Pinsker, and Kiryat Arye by the stadium.
  rail: {
    block: PT_BLOCK.jabotinsky,
    side: 1,
    from: 4,
    to: 238,
    centre: 17,
    width: 11,
    trams: [
      { track: -1, at: 24, dir: -1 },
      { track: 1, at: 160, dir: 1 },
    ],
    stations: [
      { id: 'railCentral', name: 'PETAH TIKVA CENTRAL STATION', he: 'תחנה מרכזית פתח תקווה', sub: 'תחנה מרכזית פתח תקווה · Red Line, end of the line', from: 6, to: 46 },
      { id: 'railPinsker', name: 'PINSKER STATION', he: 'פינסקר', sub: 'פינסקר · Red Line', from: 70, to: 110 },
      { id: 'railKiryatArye', name: 'KIRYAT ARYE STATION', he: 'קריית אריה', sub: 'קריית אריה · Red Line, for HaMoshava Stadium', from: 140, to: 180 },
    ],
  },
  vernacular: 'israeli',
  buildingShare: 0.86,
  floors: { near: [3, 6], far: [4, 9] },
};
