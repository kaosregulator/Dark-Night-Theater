import Hls from 'hls.js';

// Video player wrapper around hls.js. Plays Cloudflare Stream HLS (adaptive
// bitrate — ideal for 1hr+ movies) and keeps the local <video> aligned with the
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

  load({ uid, hls, dash }) {
    if (this.currentUid === uid && this.hls) return;
    this.currentUid = uid;
    this._destroyHls();

    if (Hls.isSupported() && hls) {
      const h = new Hls({
        // Big buffers keep long movies smooth; low latency off (VOD).
        maxBufferLength: 30,
        maxMaxBufferLength: 120,
        enableWorker: true,
      });
      h.loadSource(hls);
      h.attachMedia(this.video);
      this.hls = h;
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl') && hls) {
      // Safari / iOS play HLS natively.
      this.video.src = hls;
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
    if (playback.hls || playback.dash) {
      this.load({ uid: playback.videoUid, hls: playback.hls, dash: playback.dash });
    }

    // Target position accounting for time elapsed since the server snapshot.
    const elapsed = playback.playing ? (Date.now() - playback.serverTime) / 1000 : 0;
    const target = (playback.livePosition ?? playback.positionAtUpdate) + elapsed * (playback.rate || 1);
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

  // For PRIVATE viewing: free local control, no server sync.
  playPrivate({ uid, hls, dash }, resumeAt = 0) {
    this.load({ uid, hls, dash });
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
