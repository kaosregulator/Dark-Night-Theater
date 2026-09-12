import Hls from 'hls.js';

// Video player wrapper. Plays local MP4/WebM (served with range support) and
// optionally HLS via hls.js, and keeps the local <video> aligned with the
// shared playback anchor coming from the sync server.
//
// Discord Activities run inside a sandboxed Chromium with a strict autoplay
// policy and a flaky media proxy — so we always start muted, never seek past
// what's buffered, and surface decode failures instead of a silent black screen.

const DRIFT_HARD = 2.0; // seconds -> hard seek
const DRIFT_SOFT = 0.4; // seconds -> speed nudge
const PAINT_WAIT_MS = 3200;

function withRevision(url, revision) {
  if (!url || revision == null) return url;
  const join = url.includes('?') ? '&' : '?';
  return `${url}${join}r=${encodeURIComponent(String(revision))}`;
}

function bufferedEnd(video) {
  try {
    const b = video.buffered;
    if (!b || b.length === 0) return 0;
    return b.end(b.length - 1);
  } catch {
    return 0;
  }
}

export class TheaterPlayer {
  constructor(videoEl) {
    this.video = videoEl;
    this.hls = null;
    this.currentUid = null;
    this.mediaRevision = null;
    this.suppressEvents = false;
    this.onLocalControl = () => {};
    this._paintTimer = null;
    this._wantUnmute = false;
    this._pendingSeek = null;
    this._started = false;
    // After MEDIA_ERR_SRC_NOT_SUPPORTED the element must be hard-reset before
    // the same /tmedia/:id (now serving converted H.264) can load again.
    this._hadMediaError = false;
    this._awaitingConversion = false;
    this._converting = false;

    // Critical for Discord iframe / mobile WebViews.
    this.video.playsInline = true;
    this.video.setAttribute('playsinline', '');
    this.video.setAttribute('webkit-playsinline', '');
    this.video.preload = 'auto';
    this.video.controls = false;
    this.video.disableRemotePlayback = true;

    this.video.addEventListener('error', () => this._onMediaError());
    this.video.addEventListener('playing', () => this._armPaintWatch());
    this.video.addEventListener('loadeddata', () => {
      this._armPaintWatch();
      this._flushPendingSeek();
      // Clear codec UI even when paused (media-ready often arrives while paused).
      if (!this.video.error && this.video.readyState >= 2) {
        this._hadMediaError = false;
        this.onLocalControl({ type: 'decode-ok' });
      }
    });
    this.video.addEventListener('canplay', () => this._flushPendingSeek());
    this.video.addEventListener('progress', () => this._flushPendingSeek());
    this.video.addEventListener('emptied', () => this._clearPaintWatch());
  }

  load({ uid, hls, dash, src, kind, revision, converting = false }) {
    const rev = revision ?? null;
    // Conversion finished or failed — must leave the awaiting guard even if
    // mediaRevision did not bump (failure path only updates meta).
    const leavingConversion = this._awaitingConversion && !converting;
    const same =
      !leavingConversion &&
      this.currentUid === uid &&
      this.mediaRevision === rev &&
      (this.hls || this.video.src || this._awaitingConversion);
    if (same) return;

    this.currentUid = uid;
    this.mediaRevision = rev;
    this._started = false;
    this._pendingSeek = null;
    this._converting = Boolean(converting);
    this._clearPaintWatch();

    // While the server re-encodes HEVC/AC-3, do not attach the incompatible
    // original — that causes MEDIA_ERR_SRC_NOT_SUPPORTED and a sticky fatal UI.
    if (converting && kind === 'file' && !hls && !dash) {
      this._awaitingConversion = true;
      this._hardResetMedia();
      this.onLocalControl({
        type: 'converting',
        detail: 'Converting video for Discord…',
      });
      return;
    }

    this._awaitingConversion = false;
    // Always hard-reset when leaving conversion or recovering from MEDIA_ERR so
    // Chromium re-fetches /tmedia/:id (same URL, new H.264 bytes).
    const needsHardReset =
      leavingConversion || this._hadMediaError || Boolean(this.video.error);
    if (needsHardReset) {
      this._hardResetMedia();
    } else {
      this._destroyHls();
    }

    // Local file (MP4/WebM) served with range support — just point <video> at it.
    if (kind === 'file' && src) {
      this.video.src = withRevision(src, this.mediaRevision);
      this.video.load?.();
      return;
    }
    // HLS (either a local .m3u8 or a remote manifest).
    const manifest = kind === 'hls' ? src : hls;
    if (Hls.isSupported() && manifest) {
      const h = new Hls({
        maxBufferLength: 30,
        maxMaxBufferLength: 120,
        enableWorker: true,
        startLevel: -1,
        // Discord's Activity proxy can stall on large segment bursts.
        fragLoadingTimeOut: 20000,
        manifestLoadingTimeOut: 20000,
      });
      h.loadSource(withRevision(manifest, this.mediaRevision));
      h.attachMedia(this.video);
      h.on(Hls.Events.ERROR, (_e, data) => {
        if (data?.fatal) {
          this._hadMediaError = true;
          this.onLocalControl({
            type: 'decode-fail',
            detail: 'Stream error — wait for the host convert to finish, or re-host as H.264 + AAC.',
          });
        }
      });
      this.hls = h;
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl') && manifest) {
      this.video.src = withRevision(manifest, this.mediaRevision); // Safari / iOS native HLS
    } else if (dash) {
      this.video.src = withRevision(dash, this.mediaRevision);
    }
  }

  // Fully reset a failed <video> so the next src (same /tmedia path, new bytes) fetches.
  _hardResetMedia() {
    try {
      this.video.pause();
    } catch {
      /* ignore */
    }
    this._destroyHls();
    try {
      this.video.removeAttribute('src');
      this.video.srcObject = null;
      while (this.video.firstChild) this.video.removeChild(this.video.firstChild);
      this.video.load?.();
    } catch {
      /* ignore */
    }
    this._hadMediaError = false;
  }

  _destroyHls() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.video.removeAttribute('src');
  }

  _clearPaintWatch() {
    if (this._paintTimer) {
      clearTimeout(this._paintTimer);
      this._paintTimer = null;
    }
  }

  _armPaintWatch() {
    this._clearPaintWatch();
    this._paintTimer = setTimeout(() => this._checkPaint(), PAINT_WAIT_MS);
  }

  // Discord Chromium often "plays" HEVC / broken MP4s with the clock advancing
  // but videoWidth stays 0 → solid black screen. Surface that clearly.
  _checkPaint() {
    this._paintTimer = null;
    if (!this.currentUid || this.video.paused) return;
    const noFrames = !this.video.videoWidth || this.video.readyState < 2;
    if (noFrames) {
      this.onLocalControl({
        type: 'decode-fail',
        detail:
          'Video is not painting frames. Discord Activities need MP4 H.264 + AAC (even resolution like 1920×1080). MovieBox / rip files are often H.265 — wait for server convert, or re-export.',
      });
    } else {
      this.onLocalControl({ type: 'decode-ok' });
    }
  }

  _onMediaError() {
    this._hadMediaError = true;
    // Soft-fail while the server is still converting — not a permanent codec error.
    if (this._converting || this._awaitingConversion) {
      this.onLocalControl({
        type: 'converting',
        detail: 'Converting video for Discord…',
      });
      return;
    }
    const err = this.video.error;
    const code = err?.code;
    let detail = 'Could not decode this movie in Discord’s browser.';
    // Prefer numeric codes — MediaError globals are missing in some embeds/tests.
    if (code === 4 /* MEDIA_ERR_SRC_NOT_SUPPORTED */) {
      detail =
        'This file’s codecs aren’t supported here. Re-export as MP4 H.264 video + AAC audio (HandBrake “Fast 1080p30”), or wait for the server convert to finish.';
    } else if (code === 2 /* MEDIA_ERR_NETWORK */) {
      detail = 'Network error loading the stream — keep the host tab open and tap Play again.';
    } else if (code === 3 /* MEDIA_ERR_DECODE */) {
      detail =
        'Decode failed (often H.265/HEVC or AC-3 in an .mp4 wrapper). Re-encode to H.264 + AAC, or wait for auto-convert.';
    }
    this.onLocalControl({ type: 'decode-fail', detail });
  }

  // Safe seek: never jump past buffered media (progressive uploads / proxy).
  _safeSeek(target) {
    const t = Math.max(0, Number(target) || 0);
    const end = bufferedEnd(this.video);
    const ready = this.video.readyState >= 1;
    if (!ready || (end > 0 && t > end + 0.5)) {
      this._pendingSeek = t;
      // Seek to the furthest safe point so playback can start.
      if (end > 1) {
        try {
          this.video.currentTime = Math.max(0, end - 0.5);
        } catch {
          /* ignore */
        }
      }
      return false;
    }
    try {
      this.video.currentTime = t;
      this._pendingSeek = null;
      return true;
    } catch {
      this._pendingSeek = t;
      return false;
    }
  }

  _flushPendingSeek() {
    if (this._pendingSeek == null) return;
    const t = this._pendingSeek;
    const end = bufferedEnd(this.video);
    if (this.video.readyState < 1) return;
    if (end > 0 && t > end + 1) {
      // Still not buffered that far — nudge forward as data arrives.
      try {
        this.video.currentTime = Math.max(0, end - 0.25);
      } catch {
        /* ignore */
      }
      return;
    }
    this._safeSeek(t);
  }

  _tryPlay() {
    const v = this.video;
    // Always attempt muted first inside Discord — unmuted autoplay is blocked.
    if (!this._started) {
      v.muted = true;
      this._wantUnmute = true;
    }
    const play = v.play();
    if (!play || typeof play.then !== 'function') return;
    play
      .then(() => {
        this._started = true;
        if (this._wantUnmute) this.onLocalControl({ type: 'needs-unmute' });
      })
      .catch(() => {
        v.muted = true;
        this._wantUnmute = true;
        v.play()
          .then(() => {
            this._started = true;
            this.onLocalControl({ type: 'needs-unmute' });
          })
          .catch(() => this.onLocalControl({ type: 'needs-gesture' }));
      });
  }

  // User tapped ▶ — must be called from a click handler.
  async unlockAndPlay({ unmute = true } = {}) {
    const v = this.video;
    if (unmute) {
      v.muted = false;
      this._wantUnmute = false;
    } else {
      v.muted = true;
    }
    try {
      await v.play();
      this._started = true;
      this._armPaintWatch();
      return true;
    } catch {
      // Fall back to muted play so something paints, then ask for sound.
      try {
        v.muted = true;
        this._wantUnmute = true;
        await v.play();
        this._started = true;
        this._armPaintWatch();
        this.onLocalControl({ type: 'needs-unmute' });
        return true;
      } catch (err) {
        this.onLocalControl({
          type: 'decode-fail',
          detail: 'Could not start playback. If the file is still converting, wait a bit and tap again.',
        });
        return false;
      }
    }
  }

  // Apply the authoritative shared state to this player.
  applyState(playback) {
    if (!playback?.videoUid) return;

    this._converting = Boolean(playback.converting);

    // Show converting tip early (before media is ready).
    if (playback.converting) {
      this.onLocalControl({
        type: 'converting',
        detail: playback.codecTip || 'Converting video for Discord…',
      });
    }

    if (playback.src || playback.hls || playback.dash || playback.converting) {
      this.load({
        uid: playback.videoUid,
        hls: playback.hls,
        dash: playback.dash,
        src: playback.src,
        kind: playback.kind,
        revision: playback.mediaRevision ?? 0,
        converting: Boolean(playback.converting),
      });
    }

    // While awaiting conversion there is no media clock yet — skip seek/play.
    if (this._awaitingConversion) {
      return;
    }

    // Prefer the true anchor (positionAtUpdate + updatedAt). Falling back to
    // livePosition + serverTime keeps older snapshots working.
    let target;
    if (playback.playing && playback.updatedAt) {
      const elapsed = (Date.now() - playback.updatedAt) / 1000;
      target = (playback.positionAtUpdate ?? 0) + elapsed * (playback.rate || 1);
    } else if (playback.playing && playback.serverTime != null) {
      const elapsed = (Date.now() - playback.serverTime) / 1000;
      target = (playback.livePosition ?? playback.positionAtUpdate ?? 0) + elapsed * (playback.rate || 1);
    } else {
      target = playback.livePosition ?? playback.positionAtUpdate ?? 0;
    }
    const drift = this.video.currentTime - target;

    this.suppressEvents = true;
    if (Math.abs(drift) > DRIFT_HARD || Number.isNaN(this.video.currentTime)) {
      this._safeSeek(target);
      this.video.playbackRate = playback.rate || 1;
    } else if (playback.playing && Math.abs(drift) > DRIFT_SOFT) {
      this.video.playbackRate = (playback.rate || 1) * (drift > 0 ? 0.96 : 1.04);
    } else {
      this.video.playbackRate = playback.rate || 1;
    }

    if (playback.playing && this.video.paused) {
      this._tryPlay();
    } else if (!playback.playing && !this.video.paused) {
      this.video.pause();
    }
    setTimeout(() => (this.suppressEvents = false), 50);
  }

  // Stop and unload — used when the party ends or the viewer is still in the foyer.
  clear() {
    this._destroyHls();
    this._clearPaintWatch();
    this.currentUid = null;
    this.mediaRevision = null;
    this._pendingSeek = null;
    this._started = false;
    this._hadMediaError = false;
    this._awaitingConversion = false;
    this._converting = false;
    try {
      this.video.pause();
    } catch {
      /* ignore */
    }
    this.video.removeAttribute('src');
    this.video.load?.();
  }

  // For PRIVATE viewing: free local control, no server sync.
  playPrivate({ uid, hls, dash, src, kind }, resumeAt = 0) {
    this.load({ uid, hls, dash, src, kind, revision: 0 });
    const seek = () => {
      if (resumeAt > 0) this._safeSeek(resumeAt);
      this._tryPlay();
      this.video.removeEventListener('loadedmetadata', seek);
    };
    this.video.addEventListener('loadedmetadata', seek);
  }

  get position() {
    return this.video.currentTime || 0;
  }
}
