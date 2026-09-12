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

function amInside(snap) {
  if (!snap || !me) return false;
  // Nothing playing → no foyer gate.
  if (snap.mode !== 'clan' || !snap.playback?.videoUid) return true;
  if (snap.hostId && snap.hostId === me.id) return true;
  const p = (snap.participants || []).find((x) => x.id === me.id);
  return Boolean(p?.inside);
}

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
    if (mode === 'clan') {
      // Preserve the click gesture for autoplay: start/pause locally ASAP when
      // the host (or unlocked room) presses ▶, then let the server confirm.
      if (action === 'toggle' || action === 'play') {
        const snap = sync.snapshot;
        const isHost = snap?.hostId === me?.id;
        const canControl = isHost || !snap?.playback?.locked || !snap?.hostId;
        if (canControl && snap?.playback?.videoUid) {
          if (!snap.playback.playing) {
            player.video.muted = false;
            player.video.play().catch(() => {});
          } else if (action === 'toggle') {
            player.video.pause();
          }
        }
      }
      sync.control(action, value);
    } else applyPrivateControl(action, value);
  });
  ui.on('seat', ({ seat }) => sync.takeSeat(seat));
  ui.on('item', ({ item }) => sync.giveItem(item));
  ui.on('claim-host', () => sync.claimHost());
  ui.on('enter-theater', ({ seat, items }) => {
    // Gesture from Enter/Watch Movie — try play once the server marks us inside.
    sync.enter({ seat, items });
  });
  ui.on('pick-clan', async ({ uid }) => {
    mode = 'clan';
    await api.startMovie(dc.channelId, uid, dc.guildId).catch((e) => ui.toast('⚠️ ' + e.message));
  });
  ui.on('pick-private', async ({ uid }) => {
    mode = 'private';
    const [pb, prog] = await Promise.all([api.playback(uid), api.progress(uid).catch(() => ({}))]);
    const video = library.find((v) => v.uid === uid);
    ui.setMode('private', video);
    ui.hideFoyer();
    ui.showIntro(video);
    player.playPrivate(pb, prog?.progress?.position || 0);
    schedulePrivateSave(uid, player);
  });
  ui.on('leave-private', async () => {
    mode = 'clan';
    ui.setMode('clan');
    // Re-apply the shared state when returning to the clan room (if inside).
    if (sync.snapshot && amInside(sync.snapshot)) player.applyState(sync.snapshot.playback);
  });

  player.onLocalControl = (e) => {
    if (e.type === 'needs-gesture') ui.showTapToPlay(() => player.video.play().catch(() => {}));
  };

  // ---- Sync -> player + UI --------------------------------------------------
  sync.addEventListener('state', (e) => {
    const snap = e.detail;
    const inside = amInside(snap);
    ui.setState(snap, { me, inside });

    if (mode !== 'clan') return;

    if (snap.mode === 'idle' || !snap.playback?.videoUid) {
      player.clear();
      ui.setMode('lobby');
      ui.hideFoyer();
      return;
    }

    if (!inside) {
      // True idle screen for late joiners: foyer only — never load the movie.
      player.clear();
      ui.showFoyer(snap);
      return;
    }

    ui.hideFoyer();
    ui.setMode('clan');
    player.applyState(snap.playback);
  });
  sync.addEventListener('room-event', (e) => ui.handleRoomEvent(e.detail));
  sync.addEventListener('sync-error', (e) => ui.toast('⚠️ ' + e.detail));

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
  // Use the snapshot as-is — do NOT rewrite serverTime (that caused a hard
  // seek backward every 4s and made ▶ look like it "never played").
  setInterval(() => {
    if (mode !== 'clan') return;
    const snap = sync.snapshot;
    if (!snap?.playback?.videoUid || !amInside(snap)) return;
    if (!snap.playback.playing) return;
    player.applyState(snap.playback);
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
