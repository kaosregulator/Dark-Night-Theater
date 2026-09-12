/**
 * Proves TheaterPlayer convert → media-ready reload behavior without Discord.
 * Run: node scripts/test-media-reload.mjs
 */
import { TheaterPlayer } from '../client/src/player.js';

class FakeVideo extends EventTarget {
  constructor() {
    super();
    this._src = '';
    this.error = null;
    this.paused = true;
    this.muted = true;
    this.currentTime = 0;
    this.playbackRate = 1;
    this.readyState = 0;
    this.videoWidth = 0;
    this.buffered = { length: 0 };
    this.firstChild = null;
    this.playsInline = true;
    this.preload = 'auto';
    this.controls = false;
    this.disableRemotePlayback = true;
    this.srcObject = null;
  }
  get src() {
    return this._src;
  }
  set src(v) {
    this._src = v || '';
    this.error = null;
    this.readyState = 0;
  }
  setAttribute(k, v) {
    if (k === 'src') this.src = v;
  }
  removeAttribute(k) {
    if (k === 'src') this._src = '';
  }
  load() {
    if (!this._src) {
      this.readyState = 0;
      this.error = null;
      this.dispatchEvent(new Event('emptied'));
      return;
    }
    this.readyState = 2;
    this.videoWidth = 1920;
    this.dispatchEvent(new Event('loadeddata'));
    this.dispatchEvent(new Event('canplay'));
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  failUnsupported() {
    this.error = { code: 4 };
    this.dispatchEvent(new Event('error'));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error('FAIL: ' + msg);
}

const events = [];
const video = new FakeVideo();
const player = new TheaterPlayer(video);
player.onLocalControl = (e) => events.push(e.type);

const uid = 'temp-abc';
const src = '/tmedia/temp-abc?t=tok';

// 1) Converting: must NOT attach original src
player.applyState({
  videoUid: uid,
  src,
  kind: 'file',
  mediaRevision: 1,
  converting: true,
  codecTip: 'Converting…',
  playing: false,
  positionAtUpdate: 0,
  rate: 1,
});
assert(player._awaitingConversion === true, 'awaiting conversion');
assert(!video.src, 'no src while converting');
assert(events.includes('converting'), 'emitted converting');

// 2) Simulate prior MEDIA_ERR path: attach bad src then fail
player._awaitingConversion = false;
player._converting = false;
player.mediaRevision = 0;
player.currentUid = null;
video.src = src + '&r=0';
video.failUnsupported();
assert(events.includes('decode-fail') || player._hadMediaError, 'recorded media error');

player.applyState({
  videoUid: uid,
  src,
  kind: 'file',
  mediaRevision: 1,
  converting: true,
  playing: false,
  positionAtUpdate: 12,
  rate: 1,
});
assert(!video.src, 'cleared src while converting after error');
assert(events.filter((e) => e === 'converting').length >= 1, 'converting after error');

// 3) media-ready: new revision → hard reset + load converted URL
events.length = 0;
player.applyState({
  videoUid: uid,
  src,
  kind: 'file',
  mediaRevision: 2,
  converting: false,
  webPlayable: true,
  playing: true,
  positionAtUpdate: 12,
  updatedAt: Date.now(),
  rate: 1.25,
});
assert(player._awaitingConversion === false, 'left conversion');
assert(video.src.includes('r=2'), 'loaded with mediaRevision query');
assert(video.src.includes('/tmedia/temp-abc'), 'same /tmedia URL');
assert(events.includes('decode-ok'), 'cleared error UI on loadeddata');
assert(video.playbackRate === 1.25, 'preserved rate');
assert(video.paused === false, 'respected playing');

// 4) Same revision must not reload (no loop)
const srcBefore = video.src;
let loadCount = 0;
const origLoad = video.load.bind(video);
video.load = () => {
  loadCount++;
  return origLoad();
};
player.applyState({
  videoUid: uid,
  src,
  kind: 'file',
  mediaRevision: 2,
  converting: false,
  playing: true,
  positionAtUpdate: 12,
  updatedAt: Date.now(),
  rate: 1.25,
});
assert(loadCount === 0, 'no reload loop on same mediaRevision');
assert(video.src === srcBefore, 'src unchanged on same revision');

// 5) Paused media-ready still loads
player.applyState({
  videoUid: uid,
  src,
  kind: 'file',
  mediaRevision: 3,
  converting: false,
  playing: false,
  positionAtUpdate: 40,
  rate: 1,
});
assert(video.src.includes('r=3'), 'reload when paused on new revision');
assert(video.paused === true, 'stayed paused');

console.log('OK: media-reload pipeline checks passed');
