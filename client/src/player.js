import Hls from 'hls.js';

// Video player wrapper. Plays local MP4/WebM (served with range support) and
// optionally HLS via hls.js, and keeps the local <video> aligned with the
// shared playback anchor coming from the sync server. Drift beyond a threshold
// triggers a seek; small drift is corrected with playbackRate nudging.

const DRIFT_HARD = 2.0; // seconds -> hard seek
const DRIFT_SOFT = 0.4; // seconds -> speed nudge

export class TheaterPlayer {
  constructor(videoEl) {
    this.video = videoEl;
    this.hls = null;
    this.currentUid = null;
    this.suppressEvents = false;
    this.onLocalControl = () => {};
  }

  load({ uid, hls, dash, src, kind }) {
    if (this.currentUid === uid && (this.hls || this.video.src)) return;
    this.currentUid = uid;
    this._destroyHls();

    // Local file (MP4/WebM) served with range support — just point <video> at it.
    if (kind === 'file' && src) {
      this.video.src = src;
      return;
    }
    // HLS (either a local .m3u8 or a remote manifest).
    const manifest = kind === 'hls' ? src : hls;
    if (Hls.isSupported() && manifest) {
      const h = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 120, enableWorker: true });
      h.loadSource(manifest);
      h.attachMedia(this.video);
      this.hls = h;
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl') && manifest) {
      this.video.src = manifest; // Safari / iOS native HLS
    } else if (dash) {
      this.video.src = dash;
    }
  }

  _destroyHls() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.video.removeAttribute('src');
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
      this.video.play().catch(() => {
        // Autoplay may be blocked until a user gesture; surface a tap-to-play.
        this.onLocalControl({ type: 'needs-gesture' });
      });
    } else if (!playback.playing && !this.video.paused) {
      this.video.pause();
    }
    setTimeout(() => (this.suppressEvents = false), 50);
  }

  // Stop and unload — used when the party ends or the viewer is still in the foyer.
  clear() {
    this._destroyHls();
    this.currentUid = null;
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
    this.load({ uid, hls, dash, src, kind });
    const seek = () => {
      if (resumeAt > 0) {
        try {
          this.video.currentTime = resumeAt;
        } catch {
          /* ignore */
        }
      }
      this.video.play().catch(() => {});
      this.video.removeEventListener('loadedmetadata', seek);
    };
    this.video.addEventListener('loadedmetadata', seek);
  }

  get position() {
    return this.video.currentTime || 0;
  }
}
