import Hls from 'hls.js';

// Video player wrapper. Plays local MP4/WebM (served with range support) and
// optionally HLS via hls.js, and keeps the local <video> aligned with the
// shared playback anchor coming from the sync server.
//
// Discord Activities run inside a sandboxed Chromium with a strict autoplay
// policy and a flaky media proxy — so we always start muted, never seek past
// what's buffered, and surface decode failures instead of a silent black screen.

const DRIFT_HARD = 2.0; // seconds -> hard seek (HLS / well-buffered)
const DRIFT_HARD_PROGRESSIVE = 6.0; // progressive uploads: avoid scrub-chasing
const DRIFT_SOFT = 0.4; // seconds -> speed nudge
const SEEK_EDGE_PAD = 0.35; // keep this much behind buffered end
const PAINT_WAIT_MS = 4500;
const PAINT_MAX_TRIES = 4;
const UNLOCK_FRAME_WAIT_MS = 8000;

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
    this._userUnmuted = false; // once the viewer taps unmute, never remute
    this._skewMs = 0; // serverTime - Date.now() estimate
    this._lastHardSeekAt = 0;
    this._started = false;
    // After MEDIA_ERR_SRC_NOT_SUPPORTED the element must be hard-reset before
    // the same /tmedia/:id (now serving converted H.264) can load again.
    this._hadMediaError = false;
    this._awaitingConversion = false;
    this._converting = false;
    this._lastPlayback = null;
    this._paintTries = 0;

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
    this._userUnmuted = false;
    this._converting = Boolean(converting);
    this._clearPaintWatch();

    // While the server re-encodes HEVC/AC-3, do not attach the incompatible
    // original — that causes MEDIA_ERR_SRC_NOT_SUPPORTED and a sticky fatal UI.
    if (converting && kind === 'file' && !hls && !dash) {
      this._awaitingConversion = true;
      this._hardResetMedia();
      this.onLocalControl({
        type: 'converting',
        detail: 'Building Discord stream… first minutes unlock shortly',
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
        // Live/EVENT playlists grow while ffmpeg is still encoding the movie.
        liveDurationInfinity: true,
        liveSyncDurationCount: 3,
        // Discord's Activity proxy can stall on large segment bursts.
        fragLoadingTimeOut: 20000,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 8,
        fragLoadingMaxRetry: 6,
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
    this._paintTries = 0;
  }

  _armPaintWatch() {
    this._clearPaintWatch();
    this._paintTries = 0;
    this._paintTimer = setTimeout(() => this._checkPaint(), PAINT_WAIT_MS);
  }

  // Discord Chromium often "plays" HEVC / broken MP4s with the clock advancing
  // but videoWidth stays 0 → solid black screen. Surface that clearly.
  // Also: Discord's media proxy is slow — do NOT treat "still buffering" as a
  // fatal decode failure (that looped users back to the yellow ▶ button).
  _checkPaint() {
    this._paintTimer = null;
    if (!this.currentUid || this.video.paused) return;
    if (this._converting || this._awaitingConversion) return;

    const v = this.video;
    if (v.error) {
      this._onMediaError();
      return;
    }

    const hasFrames = v.videoWidth > 0 && v.readyState >= 2;
    if (hasFrames) {
      this._paintTries = 0;
      this.onLocalControl({ type: 'decode-ok' });
      return;
    }

    const stillLoading =
      v.networkState === 2 /* NETWORK_LOADING */ ||
      v.readyState < 2 ||
      bufferedEnd(v) < 0.5;

    this._paintTries += 1;
    if (stillLoading && this._paintTries < PAINT_MAX_TRIES) {
      this._paintTimer = setTimeout(() => this._checkPaint(), PAINT_WAIT_MS);
      this.onLocalControl({
        type: 'converting',
        detail: 'Buffering movie through Discord…',
      });
      return;
    }

    this.onLocalControl({
      type: 'decode-fail',
      detail:
        'Video is not painting frames. Discord Activities need MP4 H.264 + AAC (even resolution like 1920×1080). MovieBox / rip files are often H.265 — wait for server convert, or re-export.',
    });
  }

  _waitForEvent(eventName, timeoutMs) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.video.removeEventListener(eventName, onEvt);
        resolve(ok);
      };
      const onEvt = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.video.addEventListener(eventName, onEvt, { once: true });
    });
  }

  _onMediaError() {
    this._hadMediaError = true;
    // Soft-fail while the server is still converting — not a permanent codec error.
    if (this._converting || this._awaitingConversion) {
      this.onLocalControl({
        type: 'converting',
        detail: 'Building Discord stream… first minutes unlock shortly',
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
  // Important: do NOT scrub-chase the live edge while under-buffered — that
  // causes visible fast-forward and often stalls Discord's audio pipeline.
  _safeSeek(target) {
    const t = Math.max(0, Number(target) || 0);
    const end = bufferedEnd(this.video);
    const ready = this.video.readyState >= 1;
    if (!ready || (end > 0 && t > end + 0.5)) {
      this._pendingSeek = t;
      // Hold at the current playhead (or start of buffer). Do not keep assigning
      // currentTime to bufferedEnd — that is the scrubbing/FF bug.
      return false;
    }
    try {
      this.video.currentTime = t;
      this._pendingSeek = null;
      this._lastHardSeekAt = Date.now();
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
    // Wait until the target is actually buffered, then seek once.
    if (end > 0 && t > end + SEEK_EDGE_PAD) return;
    this._safeSeek(t);
  }

  markUnmuted() {
    this._userUnmuted = true;
    this._wantUnmute = false;
    try {
      this.video.muted = false;
    } catch {
      /* ignore */
    }
  }

  _tryPlay() {
    const v = this.video;
    // Always attempt muted first inside Discord — unmuted autoplay is blocked.
    // Once the viewer has unmuted, never force mute again (fixes mute-until-pause).
    if (!this._started && !this._userUnmuted) {
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

  _withTimeout(promise, ms, label = 'timeout') {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  async unlockAndPlay({ unmute = true } = {}) {
    const v = this.video;

    // Convert still running: do not pretend play() can succeed on an empty src.
    if (this._converting || this._awaitingConversion) {
      this.onLocalControl({
        type: 'converting',
        detail: 'Converting video for Discord… hang tight, then tap again.',
      });
      return false;
    }

    // After MEDIA_ERR / convert, the element may have no src — reload latest snapshot.
    const needsReload =
      !v.src ||
      Boolean(v.error) ||
      this._hadMediaError ||
      (this._lastPlayback && this.mediaRevision !== (this._lastPlayback.mediaRevision ?? 0));
    if (needsReload && this._lastPlayback) {
      const pb = { ...this._lastPlayback, converting: false };
      // Force leave same-media guard by clearing revision identity first.
      this.mediaRevision = null;
      this.currentUid = null;
      this.applyState(pb);
      await this._waitForEvent('loadeddata', 5000);
    }

    if (!v.src && !this.hls) {
      this.onLocalControl({
        type: 'decode-fail',
        detail: 'No movie loaded yet. If the host just uploaded, wait for convert to finish, then tap again.',
      });
      return false;
    }

    // Discord: try muted first so play() is allowed, then unmute on gesture.
    const tryPlay = async (wantUnmute) => {
      v.muted = !wantUnmute;
      this._wantUnmute = !wantUnmute;
      // Discord's proxy can hang play() forever on a bad progressive MP4 — never
      // leave the yellow "Starting…" overlay wedged with no way out.
      await this._withTimeout(v.play(), 6000, 'play-timeout');
      this._started = true;
      if (wantUnmute) {
        try {
          v.muted = false;
          this._wantUnmute = false;
          this._userUnmuted = true;
        } catch {
          /* ignore */
        }
      } else {
        this.onLocalControl({ type: 'needs-unmute' });
      }
    };

    try {
      await tryPlay(Boolean(unmute));
    } catch {
      try {
        await tryPlay(false);
      } catch {
        this.onLocalControl({
          type: 'decode-fail',
          detail: 'Could not start playback. If the file is still converting, wait a bit and tap again.',
        });
        return false;
      }
    }

    // Wait for real frames — play() can resolve while Discord's proxy still
    // buffers, which previously hid the yellow button over a black screen.
    const start = Date.now();
    while (Date.now() - start < UNLOCK_FRAME_WAIT_MS) {
      if (v.error) {
        this._onMediaError();
        return false;
      }
      if (v.videoWidth > 0 && v.readyState >= 2) {
        this._hadMediaError = false;
        this.onLocalControl({ type: 'decode-ok' });
        this._armPaintWatch();
        return true;
      }
      await this._waitForEvent('loadeddata', 500);
    }

    // Still no frames — keep overlay up so the user can retry; arm a patient paint watch.
    this._armPaintWatch();
    if (v.error) {
      this._onMediaError();
      return false;
    }
    this.onLocalControl({
      type: 'converting',
      detail: 'Still buffering through Discord… tap again in a moment if the screen stays black.',
    });
    // Return true only if the element is actually playing; otherwise keep the ▶ button.
    return !v.paused && v.readyState >= 2;
  }

  // Apply the authoritative shared state to this player.
  applyState(playback) {
    if (!playback?.videoUid) return;
    this._lastPlayback = playback;

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

    // Prefer the true anchor with server-clock skew correction when available.
    if (playback.serverTime != null) {
      this._skewMs = playback.serverTime - Date.now();
    }
    let target;
    if (playback.playing && playback.updatedAt) {
      const nowApprox = Date.now() + this._skewMs;
      const elapsed = (nowApprox - playback.updatedAt) / 1000;
      target = (playback.positionAtUpdate ?? 0) + elapsed * (playback.rate || 1);
    } else if (playback.playing && playback.serverTime != null) {
      const elapsed = (Date.now() + this._skewMs - playback.serverTime) / 1000;
      target = (playback.livePosition ?? playback.positionAtUpdate ?? 0) + elapsed * (playback.rate || 1);
    } else {
      target = playback.livePosition ?? playback.positionAtUpdate ?? 0;
    }
    const drift = this.video.currentTime - target;
    const progressive = playback.kind === 'file' || (!playback.hls && !playback.dash);
    const hard = progressive ? DRIFT_HARD_PROGRESSIVE : DRIFT_HARD;
    const bufferingAhead =
      this._pendingSeek != null ||
      (bufferedEnd(this.video) > 0 && target > bufferedEnd(this.video) + SEEK_EDGE_PAD);

    this.suppressEvents = true;
    // While under-buffered, play naturally at 1x — do not scrub or rate-chase.
    if (bufferingAhead && playback.playing) {
      this.video.playbackRate = 1;
      if (this._pendingSeek == null || Math.abs(this._pendingSeek - target) > 0.5) {
        this._pendingSeek = target;
      }
    } else if (
      (Math.abs(drift) > hard || Number.isNaN(this.video.currentTime)) &&
      Date.now() - this._lastHardSeekAt > 1500
    ) {
      this._safeSeek(target);
      this.video.playbackRate = playback.rate || 1;
    } else if (playback.playing && Math.abs(drift) > DRIFT_SOFT && !bufferingAhead) {
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
    this._lastPlayback = null;
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
