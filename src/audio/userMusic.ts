export const MUSIC_FILE = /\.(mp3|wav|ogg|m4a|aac|flac|opus|webm)$/i;
export interface MusicTrack { name: string; url: string }
interface SavedMusic { label: string; files: File[] }

/** Browser-owned copies: no persistent permission to the player's filesystem is needed. */
async function musicStore(value?: SavedMusic): Promise<SavedMusic | undefined> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('ironnomad.music', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('playlist');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('playlist', value ? 'readwrite' : 'readonly');
      const request = value ? tx.objectStore('playlist').put(value, 'selected') : tx.objectStore('playlist').get('selected');
      tx.oncomplete = () => resolve(value ?? request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export class UserMusic {
  tracks: MusicTrack[] = [];
  label = 'Game music folder';
  status = 'Loading music…';
  private media: HTMLAudioElement | null = null;
  private index = 0;
  private wanted = false;
  private blocked = false;
  private playing = false;
  private failures = 0;
  private generation = 0;
  private objectUrls: string[] = [];

  constructor(private createMedia = () => new Audio()) {}

  async load() {
    const generation = this.generation;
    try {
      const saved = await musicStore();
      if (generation !== this.generation) return;
      if (saved?.files.length) { this.useFiles(saved.files, saved.label); return; }
    } catch { /* Storage may be disabled; the game folder still works. */ }
    await this.loadGameFolder(generation);
  }

  private async loadGameFolder(generation = this.generation) {
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}music/playlist.json`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Music list unavailable');
      const paths: string[] = await response.json();
      if (generation !== this.generation) return;
      this.replace(paths.filter(p => MUSIC_FILE.test(p)).map(path => ({
        name: path.split('/').pop()!,
        url: `${import.meta.env.BASE_URL}music/${path.split('/').map(encodeURIComponent).join('/')}`,
      })), 'Game music folder');
    } catch { if (generation === this.generation) this.status = 'No game tracks. Choose a music folder.'; }
  }

  async selectFiles(files: File[], label: string) {
    const supported = files.filter(f => MUSIC_FILE.test(f.name)).sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name));
    if (!supported.length) { this.status = 'No supported audio files in that folder.'; return; }
    this.generation++;
    this.useFiles(supported, label);
    try { await musicStore({ files: supported, label }); }
    catch { this.status = 'Loaded for this session; browser storage is unavailable or full.'; }
  }

  async useGameFolder() {
    const generation = ++this.generation;
    await this.loadGameFolder(generation);
    try { await musicStore({ files: [], label: 'Game music folder' }); }
    catch { this.status = 'Game folder selected for this session; browser storage is unavailable.'; }
  }

  private useFiles(files: File[], label: string) {
    // Revoke previous URLs before allocating the next playlist.
    this.replace([], label);
    this.objectUrls = files.map(f => URL.createObjectURL(f));
    this.replace(files.map((f, i) => ({ name: f.name, url: this.objectUrls[i] })), label, false);
  }

  replace(tracks: MusicTrack[], label: string, revoke = true) {
    this.media?.pause();
    if (this.media) { this.media.removeAttribute('src'); this.media.load(); }
    if (revoke) { this.objectUrls.forEach(url => URL.revokeObjectURL(url)); this.objectUrls = []; }
    this.tracks = tracks;
    this.label = label;
    this.index = 0;
    this.failures = 0;
    this.playing = false;
    this.status = tracks.length ? `${tracks.length} tracks ready` : 'No tracks. Choose a music folder.';
    if (tracks.length) this.setTrack();
  }

  get available() { return this.tracks.length > 0 && this.failures < this.tracks.length; }
  private setTrack() {
    if (!this.media) {
      this.media = this.createMedia();
      this.media.preload = 'metadata';
      this.media.onended = () => { this.failures = 0; this.advance(); };
      this.media.onerror = () => {
        this.failures++;
        if (this.available) this.advance();
        else { this.playing = false; this.status = 'These tracks could not be played. Choose another folder.'; }
      };
    }
    this.media.src = this.tracks[this.index].url;
    this.playing = false;
  }
  private advance() { this.index = (this.index + 1) % this.tracks.length; this.setTrack(); this.sync(); }

  update(inVehicle: boolean, radioSpeaking: boolean, volume: number, muted: boolean) {
    this.wanted = inVehicle;
    this.blocked = radioSpeaking;
    if (this.media) this.media.volume = muted ? 0 : Math.max(0, Math.min(1, volume));
    this.sync();
  }
  /** Retry autoplay only on an actual user gesture, not every simulation frame. */
  unlock() { this.playing = false; this.sync(); }
  private sync() {
    if (!this.media || !this.available) return;
    if (!this.wanted || this.blocked) {
      if (this.playing) this.media.pause();
      this.playing = false;
    } else if (!this.playing) {
      this.playing = true;
      const media = this.media;
      const src = media.src;
      void media.play().catch(error => {
        if (media.src !== src || !this.wanted || this.blocked) return;
        this.status = error?.name === 'NotAllowedError' ? 'Click or press a key to enable music.' : 'Unable to play this track.';
      });
    }
  }
}
