import Hls from 'hls.js';

// Video player wrapper. Plays local MP4/WebM (served with range support) and
// optionally HLS via hls.js, and keeps the local <video> aligned with the
// shared playback anchor coming from the sync server. Drift beyond a threshold
// triggers a seek; small drift is corrected with playbackRate nudging.

const DRIFT_HARD = 2.0; // seconds -> hard seek
const DRIFT_SOFT = 0.4; // seconds -> speed nudge
const PAINT_WAIT_MS = 2800;

function withRevision(url, revision) {
  if (!url || revision == null) return url;
  const join = url.includes('?') ? '&' : '?';
  return `${url}${join}r=${encodeURIComponent(String(revision))}`;
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

    this.video.addEventListener('error', () => this._onMediaError());
    this.video.addEventListener('playing', () => this._armPaintWatch());
    this.video.addEventListener('loadeddata', () => this._armPaintWatch());
    this.video.addEventListener('emptied', () => this._clearPaintWatch());
  }

  load({ uid, hls, dash, src, kind, revision }) {
    const same =
      this.currentUid === uid &&
      this.mediaRevision === (revision ?? null) &&
      (this.hls || this.video.src);
    if (same) return;
    this.currentUid = uid;
    this.mediaRevision = revision ?? null;
    this._destroyHls();
    this._clearPaintWatch();

    // Local file (MP4/WebM) served with range support — just point <video> at it.
    if (kind === 'file' && src) {
      this.video.src = withRevision(src, this.mediaRevision);
      this.video.load?.();
      return;
    }
    // HLS (either a local .m3u8 or a remote manifest).
    const manifest = kind === 'hls' ? src : hls;
    if (Hls.isSupported() && manifest) {
      const h = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 120, enableWorker: true });
      h.loadSource(withRevision(manifest, this.mediaRevision));
      h.attachMedia(this.video);
      this.hls = h;
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl') && manifest) {
      this.video.src = withRevision(manifest, this.mediaRevision); // Safari / iOS native HLS
    } else if (dash) {
      this.video.src = withRevision(dash, this.mediaRevision);
    }
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

  // Discord Chromium often "plays" HEVC / broken MP4s with audio clock advancing
  // but videoWidth stays 0 → solid black screen. Surface that clearly.
  _checkPaint() {
    this._paintTimer = null;
    if (!this.currentUid || this.video.paused) return;
    const noFrames = !this.video.videoWidth || this.video.readyState < 2;
    if (noFrames) {
      this.onLocalControl({
        type: 'decode-fail',
        detail:
          'Video is not painting frames. Discord Activities need MP4 H.264 + AAC (even resolution like 1920×1080). MovieBox / rip files are often H.265.',
      });
    } else {
      this.onLocalControl({ type: 'decode-ok' });
    }
  }

  _onMediaError() {
    const err = this.video.error;
    const code = err?.code;
    let detail = 'Could not decode this movie in Discord’s browser.';
    if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || code === 4) {
      detail =
        'This file’s codecs aren’t supported here. Re-export as MP4 H.264 video + AAC audio (HandBrake “Fast 1080p30”).';
    } else if (code === MediaError.MEDIA_ERR_NETWORK || code === 2) {
      detail = 'Network error loading the stream — keep the host tab open and try Play again.';
    } else if (code === MediaError.MEDIA_ERR_DECODE || code === 3) {
      detail =
        'Decode failed (often H.265/HEVC or AC-3 in an .mp4 wrapper). Re-encode to H.264 + AAC.';
    }
    this.onLocalControl({ type: 'decode-fail', detail });
  }

  _tryPlay() {
    const v = this.video;
    const play = v.play();
    if (!play || typeof play.then !== 'function') return;
    play.catch(() => {
      // Autoplay policies: try muted, then ask for a tap.
      v.muted = true;
      this._wantUnmute = true;
      v.play()
        .then(() => this.onLocalControl({ type: 'needs-unmute' }))
        .catch(() => this.onLocalControl({ type: 'needs-gesture' }));
    });
  }

  // Apply the authoritative shared state to this player.
  applyState(playback) {
    if (!playback?.videoUid) return;
    if (playback.src || playback.hls || playback.dash) {
      this.load({
        uid: playback.videoUid,
        hls: playback.hls,
        dash: playback.dash,
        src: playback.src,
        kind: playback.kind,
        revision: playback.mediaRevision ?? 0,
      });
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
      try {
        this.video.currentTime = Math.max(0, target);
      } catch {
        /* not seekable yet */
      }
      this.video.playbackRate = playback.rate || 1;
    } else if (playback.playing && Math.abs(drift) > DRIFT_SOFT) {
      // Nudge speed slightly to converge without a visible jump.
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
      if (resumeAt > 0) {
        try {
          this.video.currentTime = resumeAt;
        } catch {
          /* ignore */
        }
      }
      this._tryPlay();
      this.video.removeEventListener('loadedmetadata', seek);
    };
    this.video.addEventListener('loadedmetadata', seek);
  }

  get position() {
    return this.video.currentTime || 0;
  }
}
