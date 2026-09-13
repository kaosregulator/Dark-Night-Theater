import { initDiscord, dc } from './discord.js';
import { SyncClient } from './sync.js';
import { TheaterPlayer } from './player.js';
import { api } from './api.js';
import { TheaterUI } from './theater.js';
import { renderMainMenu } from './menu.js';

// Orchestrates the Activity: Discord handshake -> sync -> player -> theater UI.
// First surface is always the main menu (join / host / enter code).

const bootStatus = (t) => {
  const el = document.getElementById('boot-status');
  if (el) el.textContent = t;
};

let mode = 'clan'; // 'clan' | 'private'
let me = null;
let library = [];
let saveTimer = null;
let menuOpen = true;

function amInside(snap) {
  if (!snap || !me) return false;
  if (snap.mode !== 'clan' || !snap.playback?.videoUid) return true;
  if (snap.hostId && snap.hostId === me.id) return true;
  const p = (snap.participants || []).find((x) => x.id === me.id);
  return Boolean(p?.inside);
}

function enterWatching(ui, player, sync) {
  menuOpen = false;
  ui.hideMainMenu();
  ui.hideFoyer();
  ui.setMode('clan');
  const snap = sync.snapshot;
  if (snap?.playback) player.applyState(snap.playback);
}

function openMenu(ui, sync, player) {
  menuOpen = true;
  ui.showMainMenu({
    renderMainMenu,
    onJoinParty: () => {
      const snap = sync.snapshot;
      if (!snap) return;
      if (snap.codeLocked) {
        ui.toast('🔒 This party needs the 4-letter code — use Enter Room Code.');
        return;
      }
      menuOpen = false;
      ui.hideMainMenu();
      if (!amInside(snap)) ui.showFoyer(snap);
      else enterWatching(ui, player, sync);
    },
    onHost: async () => {
      try {
        const { url } = await api.hostLink(dc.channelId, dc.guildId, null);
        ui.toast('📤 Opening host upload… keep Discord open, then come back.');
        window.open(url, '_blank', 'noopener');
      } catch (e) {
        ui.toast('⚠️ Could not open host page: ' + e.message);
      }
    },
    onEnterCode: (code) => {
      const cleaned = String(code || '')
        .trim()
        .toUpperCase();
      if (cleaned.length !== 4) {
        ui.toast('Enter a 4-letter party code.');
        return;
      }
      sync.unlockCode(cleaned);
      ui.toast('🔑 Checking code…');
    },
    onExit: () => {
      ui.toast('🛋️ Lobby chill mode. Hit 🏠 anytime to come back.');
      menuOpen = false;
      ui.hideMainMenu();
    },
  });
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
  const menu = () => openMenu(ui, sync, player);

  ui.on('control', ({ action, value }) => {
    if (mode === 'clan') {
      if (action === 'toggle' || action === 'play') {
        const snap = sync.snapshot;
        const isHost = snap?.hostId === me?.id;
        const canControl = isHost || !snap?.playback?.locked || !snap?.hostId;
        if (canControl && snap?.playback?.videoUid) {
          if (!snap.playback.playing) {
            player.markUnmuted();
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
  ui.on('react', ({ kind }) => sync.react(kind));
  ui.on('open-menu', () => menu());
  ui.on('enter-theater', ({ seat, items }) => {
    sync.enter({ seat, items });
    enterWatching(ui, player, sync);
  });
  ui.on('pick-clan', async ({ uid }) => {
    mode = 'clan';
    menuOpen = false;
    ui.hideMainMenu();
    await api.startMovie(dc.channelId, uid, dc.guildId).catch((e) => ui.toast('⚠️ ' + e.message));
  });
  ui.on('marquee-add', async ({ uid }) => {
    await api.addToMarquee(dc.channelId, uid).catch((e) => ui.toast('⚠️ ' + e.message));
    ui.toast('🎟️ Added to marquee');
    ui.toggleLobby(true);
  });
  ui.on('marquee-vote', async ({ uid }) => {
    await api.voteMarquee(dc.channelId, uid).catch((e) => ui.toast('⚠️ ' + e.message));
  });
  ui.on('marquee-remove', async ({ uid }) => {
    await api.removeFromMarquee(dc.channelId, uid).catch((e) => ui.toast('⚠️ ' + e.message));
  });
  ui.on('marquee-start', async ({ uid }) => {
    mode = 'clan';
    menuOpen = false;
    ui.hideMainMenu();
    await api.startMarquee(dc.channelId, uid, dc.guildId).catch((e) => ui.toast('⚠️ ' + e.message));
  });
  ui.on('marquee-booth', async ({ uid }) => {
    try {
      const result = await api.openBooth(dc.channelId, uid, dc.guildId);
      ui.toast(`🚪 New screen open · code ${result.roomCode || '????'}`);
      if (result.theaterId) {
        // Host who opened the booth can hop into it.
        sync.switchTheater(result.theaterId);
      }
    } catch (e) {
      ui.toast('⚠️ ' + e.message);
    }
  });
  ui.on('join-booth', ({ theaterId }) => {
    if (!theaterId) return;
    ui.toast('🚪 Entering that theater screen…');
    sync.switchTheater(theaterId);
  });
  ui.on('pick-private', async ({ uid }) => {
    mode = 'private';
    menuOpen = false;
    ui.hideMainMenu();
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
    if (sync.snapshot && amInside(sync.snapshot)) player.applyState(sync.snapshot.playback);
    menu();
  });

  const tryStartPlayback = async () => {
    const pb = sync.snapshot?.playback;
    if (pb?.converting) {
      ui.hideTapToPlay();
      ui.showCodecBanner(pb.codecTip || 'Converting video for Discord…');
      return false;
    }
    if (pb) player.applyState(pb);
    return player.unlockAndPlay({ unmute: true });
  };

  player.onLocalControl = (e) => {
    if (e.type === 'needs-gesture') {
      ui.showTapToPlay(() => tryStartPlayback());
    } else if (e.type === 'needs-unmute') {
      ui.showTapToUnmute(() => {
        player.markUnmuted();
      });
    } else if (e.type === 'decode-fail') {
      // Never treat codec errors as fatal while the server is still converting.
      if (sync.snapshot?.playback?.converting) {
        ui.hideTapToPlay();
        ui.showCodecBanner(
          sync.snapshot.playback.codecTip || 'Converting video for Discord…'
        );
        return;
      }
      ui.showDecodeFail(e.detail);
      ui.showTapToPlay(() => tryStartPlayback());
    } else if (e.type === 'converting') {
      ui.hideTapToPlay();
      ui.showCodecBanner(e.detail || 'Converting video for Discord…');
    } else if (e.type === 'decode-ok') {
      ui.hideTapToPlay();
      if (!sync.snapshot?.playback?.codecTip && !sync.snapshot?.playback?.converting) {
        ui.hideCodecBanner();
      }
    }
  };

  sync.addEventListener('state', (e) => {
    const snap = e.detail;
    const inside = amInside(snap);
    ui.setState(snap, { me, inside });

    if (mode === 'clan' && (snap.mode === 'idle' || !snap.playback?.videoUid)) {
      player.clear();
      ui.setMode('lobby');
      ui.hideFoyer();
      menu();
      return;
    }

    if (menuOpen && mode === 'clan') {
      menu();
      return;
    }

    if (mode !== 'clan') return;

    if (!inside) {
      player.clear();
      ui.showFoyer(snap);
      return;
    }

    ui.hideMainMenu();
    ui.hideFoyer();
    ui.setMode('clan');
    player.applyState(snap.playback);
  });

  sync.addEventListener('room-event', (e) => {
    const ev = e.detail;
    ui.handleRoomEvent(ev);
    if (ev?.type === 'react') ui.floatReact(ev.kind);
    if (ev?.type === 'snack-break') ui.toast('🍿 Snack break! Go grab something.');
    if (ev?.type === 'snack-done') ui.toast('🎬 Snack break over — lights down.');
    if (ev?.type === 'code-ok') {
      ui.toast(`🔑 Code accepted · ${ev.roomCode || ''}`);
      const snap = sync.snapshot;
      menuOpen = false;
      ui.hideMainMenu();
      if (snap?.playback?.videoUid && !amInside(snap)) ui.showFoyer(snap);
      else if (amInside(snap)) enterWatching(ui, player, sync);
    }
    if (ev?.type === 'enter') {
      menuOpen = false;
      ui.hideMainMenu();
    }
    if (ev?.type === 'movie') {
      ui.toast(`🎬 Now playing · code ${ev.roomCode || sync.snapshot?.roomCode || '????'}`);
      if (amInside(sync.snapshot)) enterWatching(ui, player, sync);
    }
    if (ev?.type === 'booth') {
      ui.toast(
        `🚪 ${ev.label || 'New screen'} ready${ev.roomCode ? ' · code ' + ev.roomCode : ''}${
          ev.video?.name ? ' · ' + ev.video.name : ''
        }`
      );
    }
    if (ev?.type === 'marquee') {
      ui.renderMarquee?.();
    }
    if (ev?.type === 'media-ready') {
      const pb = sync.snapshot?.playback;
      // Converted MP4 is behind the same /tmedia URL — clear sticky codec UI and
      // force TheaterPlayer to honor the new mediaRevision (hard-resets if needed).
      if (pb && !pb.converting) {
        ui.hideCodecBanner();
        ui.toast('✅ Discord-safe stream ready — tap ▶ to play');
      }
      if (!menuOpen && amInside(sync.snapshot) && pb) {
        player.applyState(pb);
        // Discord blocks unmuted autoplay — always offer a fresh gesture after convert.
        if (!pb.converting) {
          ui.showTapToPlay(() => tryStartPlayback());
        }
      }
    }
  });
  sync.addEventListener('sync-error', (e) => ui.toast('⚠️ ' + e.detail));

  sync.connect();
  menu();

  try {
    const data = await api.library();
    library = data.videos;
    ui.setLibrary(data.videos, data.categories);
  } catch {
    ui.toast('Could not load the library yet.');
  }

  setInterval(() => {
    if (mode !== 'clan' || menuOpen) return;
    const snap = sync.snapshot;
    if (!snap?.playback?.videoUid || !amInside(snap)) return;
    if (!snap.playback.playing) return;
    player.applyState(snap.playback);
  }, 4000);

  document.getElementById('boot')?.remove();
}

function applyPrivateControl(action, value) {
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
