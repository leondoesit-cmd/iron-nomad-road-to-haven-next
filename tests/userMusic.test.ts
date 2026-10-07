import { describe, it, expect, vi } from 'vitest';
import { AudioEngine } from '../src/audio/audio';
import { UserMusic, MUSIC_FILE } from '../src/audio/userMusic';

function setup() {
  const media = {
    src: '', volume: 1, currentTime: 37, preload: '',
    play: vi.fn(() => Promise.resolve()), pause: vi.fn(), load: vi.fn(),
    removeAttribute: vi.fn(), onended: null as (() => void) | null, onerror: null as (() => void) | null,
  };
  const music = new UserMusic(() => media as unknown as HTMLAudioElement);
  music.replace([{ name: 'first.mp3', url: '/first.mp3' }, { name: 'second.ogg', url: '/second.ogg' }], 'Test');
  return { music, media };
}

describe('vehicle user music', () => {
  it('plays in a vehicle, pauses for radio and resumes the same track and position', () => {
    const { music, media } = setup();
    music.update(false, false, .4, false);
    expect(media.play).not.toHaveBeenCalled();
    music.update(true, false, .4, false);
    expect(media.play).toHaveBeenCalledTimes(1);
    music.update(true, false, .4, false);
    expect(media.play).toHaveBeenCalledTimes(1);
    music.update(true, true, .4, false);
    expect(media.pause).toHaveBeenCalledTimes(1);
    music.update(true, false, .4, false);
    expect(media.play).toHaveBeenCalledTimes(2);
    expect(media.src).toBe('/first.mp3');
    expect(media.currentTime).toBe(37);
    music.update(false, false, .4, false);
    expect(media.pause).toHaveBeenCalledTimes(2);
  });

  it('loops the playlist and obeys volume and mute without restarting playback', () => {
    const { music, media } = setup();
    music.update(true, false, .3, false);
    expect(media.volume).toBe(.3);
    media.onended!();
    expect(media.src).toBe('/second.ogg');
    media.onended!();
    expect(media.src).toBe('/first.mp3');
    music.update(true, false, .3, true);
    expect(media.volume).toBe(0);
    expect(media.pause).not.toHaveBeenCalled();
  });

  it('skips unreadable tracks and stops after trying the whole playlist', () => {
    const { music, media } = setup();
    music.update(true, false, 1, false);
    media.onerror!();
    expect(media.src).toBe('/second.ogg');
    media.onerror!();
    expect(music.available).toBe(false);
    const count = media.play.mock.calls.length;
    music.update(true, false, 1, false);
    expect(media.play).toHaveBeenCalledTimes(count);
    expect(music.status).toContain('could not be played');
  });

  it('retains the playlist when the selected folder contains no audio', async () => {
    const { music } = setup();
    await music.selectFiles([{ name: 'notes.txt' } as File], 'Empty');
    expect(music.tracks).toHaveLength(2);
    expect(music.status).toContain('No supported audio');
    expect(MUSIC_FILE.test('Song.MP3')).toBe(true);
  });
});


describe('independent music settings', () => {
  it('defaults the game soundtrack off while user music remains enabled', () => {
    const audio = new AudioEngine();
    expect(audio.gameMusicEnabled).toBe(false);
    expect(audio.userMusicEnabled).toBe(true);
    const update = vi.spyOn(audio.userMusic, 'update');
    audio.setMusicVolume(0);
    audio.setUserMusicVolume(.8);
    audio.updateUserMusic(true);
    expect(update).toHaveBeenLastCalledWith(true, false, audio.volume * .8, false);
  });

  it('toggles each source independently and silences the soundtrack by default', () => {
    const audio = new AudioEngine();
    const gain = { value: 1 };
    audio.musicBus = { gain } as unknown as GainNode;
    audio.setMusicVolume(.6);
    expect(gain.value).toBe(0);
    audio.setGameMusicEnabled(true);
    expect(gain.value).toBe(.3);
    const update = vi.spyOn(audio.userMusic, 'update');
    audio.setUserMusicEnabled(false);
    audio.updateUserMusic(true);
    expect(update).toHaveBeenLastCalledWith(false, false, audio.volume * audio.userMusicVolume, false);
    expect(audio.gameMusicEnabled).toBe(true);
    audio.setGameMusicEnabled(false);
    expect(gain.value).toBe(0);
  });
});
