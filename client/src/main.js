import { initDiscord, dc } from './discord.js';
import { SyncClient } from './sync.js';
import { TheaterPlayer } from './player.js';
import { api } from './api.js';
import { TheaterUI } from './theater.js';

// Orchestrates the Activity: Discord handshake -> sync -> player -> theater UI.

const bootStatus = (t) => {
  const el = document.getElementById('boot-status');
  if (el) el.textContent = t;
};

let mode = 'clan'; // 'clan' | 'private'
let me = null;
let library = [];
let saveTimer = null;

async function boot() {
  try {
    await initDiscord(bootStatus);
    me = dc.auth.user;
  } catch (err) {
    bootStatus('Could not connect to Discord: ' + err.message);
    return;
  }

  const ui = new TheaterUI(document.getElementById('app'));
  ui.mount();
  const player = new TheaterPlayer(ui.videoEl);
  const sync = new SyncClient();

  // ---- Wire UI callbacks ----------------------------------------------------
  ui.on('control', ({ action, value }) => {
    if (mode === 'clan') sync.control(action, value);
    else applyPrivateControl(action, value);
  });
  ui.on('seat', ({ seat }) => sync.takeSeat(seat));
  ui.on('item', ({ item }) => sync.giveItem(item));
  ui.on('claim-host', () => sync.claimHost());
  ui.on('pick-clan', async ({ uid }) => {
    mode = 'clan';
    await api.startMovie(dc.channelId, uid, dc.guildId).catch((e) => ui.toast('⚠️ ' + e.message));
  });
  ui.on('pick-private', async ({ uid }) => {
    mode = 'private';
    const [pb, prog] = await Promise.all([api.playback(uid), api.progress(uid).catch(() => ({}))]);
    ui.setMode('private', library.find((v) => v.uid === uid));
    player.playPrivate(pb, prog?.progress?.position || 0);
    schedulePrivateSave(uid, player);
  });
  ui.on('leave-private', async () => {
    mode = 'clan';
    ui.setMode('clan');
    // Re-apply the shared state when returning to the clan room.
    if (sync.snapshot) player.applyState(sync.snapshot.playback);
  });

  player.onLocalControl = (e) => {
    if (e.type === 'needs-gesture') ui.showTapToPlay(() => player.video.play().catch(() => {}));
  };

  // ---- Sync -> player + UI --------------------------------------------------
  sync.addEventListener('state', (e) => {
    const snap = e.detail;
    ui.setState(snap, { me });
    if (mode === 'clan' && snap.playback?.videoUid) player.applyState(snap.playback);
    if (mode === 'clan' && snap.mode === 'idle') ui.setMode('lobby');
  });
  sync.addEventListener('room-event', (e) => ui.handleRoomEvent(e.detail));
  sync.addEventListener('sync-error', (e) => ui.toast('Sync error: ' + e.detail));

  sync.connect();

  // ---- Load library for the lobby ------------------------------------------
  try {
    const data = await api.library();
    library = data.videos;
    ui.setLibrary(data.videos, data.categories);
  } catch {
    ui.toast('Could not load the library yet.');
  }

  // Keep clan playback anchored even without new server messages (re-nudge).
  setInterval(() => {
    if (mode === 'clan' && sync.snapshot?.playback?.videoUid) {
      player.applyState({ ...sync.snapshot.playback, serverTime: Date.now() - (sync.snapshot.playback.serverTime ? 0 : 0) });
    }
  }, 4000);

  document.getElementById('boot')?.remove();
}

function applyPrivateControl(action, value) {
  // Private mode drives the local <video> directly.
  const v = document.querySelector('#theater-video');
  if (!v) return;
  switch (action) {
    case 'toggle':
      v.paused ? v.play() : v.pause();
      break;
    case 'seekBy':
      v.currentTime = Math.max(0, v.currentTime + Number(value || 0));
      break;
    case 'seek':
      v.currentTime = Math.max(0, Number(value || 0));
      break;
  }
}

function schedulePrivateSave(uid, player) {
  clearInterval(saveTimer);
  saveTimer = setInterval(() => {
    if (player.position > 0) api.saveProgress(uid, player.position).catch(() => {});
  }, 10000);
}

boot();
