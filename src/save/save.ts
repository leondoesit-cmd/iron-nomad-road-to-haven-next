import { Campaign } from '../game/campaign';

const KEY = 'ironnomad.save.v1';
const DB = 'ironnomad';
const STORE = 'saves';
export const SAVE_VERSION = 2;

type Blob = ReturnType<Campaign['serialize']> & { v: number };

let mem: Blob | null = null;

/**
 * Versioned JSON; migrations hook in here when the schema changes.
 * v1 stored a tier and module levels per player; Campaign.deserialize turns those into garage builds.
 */
function migrate(d: Blob): Blob | null {
  if (!d || typeof d !== 'object') return null;
  if (d.v === SAVE_VERSION || d.v === 1) return d;
  return null; // unknown versions are ignored rather than half-loaded
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((res) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);
    } catch {
      res(null);
    }
  });
}

let reading: Promise<void> | null = null;

/** Load whatever save exists into memory so Continue can be a synchronous call. Reads once per page. */
export function initSave(): Promise<void> {
  return (reading ??= readSave());
}

async function readSave(): Promise<void> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) mem = migrate(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((res) => {
    try {
      const r = db.transaction(STORE).objectStore(STORE).get('latest');
      r.onsuccess = () => {
        const m = r.result ? migrate(r.result as Blob) : null;
        if (m) mem = m;
        res();
      };
      r.onerror = () => res();
    } catch {
      res();
    }
  });
}

/** Written at every Dawn Ledger. */
export function saveCampaign(c: Campaign) {
  // `serialize` hands back the live campaign's own objects: keep a frozen-in-time copy (what a reload would read), or
  // every change made after the save would leak into "Retry from the last Ledger".
  const json = JSON.stringify({ ...c.serialize(), v: SAVE_VERSION });
  const blob: Blob = JSON.parse(json);
  mem = blob;
  try {
    localStorage.setItem(KEY, json);
  } catch {
    /* quota or private mode */
  }
  void openDb().then((db) => {
    if (!db) return;
    try {
      db.transaction(STORE, 'readwrite').objectStore(STORE).put(blob, 'latest');
    } catch {
      /* ignore */
    }
  });
}

export function hasSave() {
  return !!mem;
}

/** Whether the stored campaign is a solo run, without building the whole campaign. */
export function savedSolo(): boolean {
  return !!mem?.solo;
}

export function loadCampaign(): Campaign | null {
  if (!mem) return null;
  try {
    // A fresh copy each time: the campaign that comes back must never share objects with the stored snapshot.
    return Campaign.deserialize(JSON.parse(JSON.stringify(mem)) as Parameters<typeof Campaign.deserialize>[0]);
  } catch {
    return null;
  }
}

export function clearSave() {
  mem = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  void openDb().then((db) => db?.transaction(STORE, 'readwrite').objectStore(STORE).delete('latest'));
}
