import path from 'node:path';
import { EventEmitter } from 'node:events';
import { startLiveHls } from './transcode.js';
import { log } from '../logger.js';

// ============================================================================
//  Conversion-first media queue.
//
//  Every watch-party / library movie enters this manager. Playback is never
//  gated on filename, size, or source codec. Workers run live HLS (H.264 + AAC)
//  via startLiveHls(); the Activity becomes PLAYABLE as soon as the first
//  segments exist, while the rest of the encode continues in the background.
//
//  Priority (lower number = sooner):
//    1 = active watch-party
//    2 = other watch-parties
//    3 = background / library
// ============================================================================

export const PRIORITY = Object.freeze({
  ACTIVE_PARTY: 1,
  WATCH_PARTY: 2,
  LIBRARY: 3,
});

const DEFAULT_WORKERS = 3;

function envWorkers() {
  const n = Number(process.env.MEDIA_CONVERSION_WORKERS);
  if (Number.isFinite(n) && n >= 1 && n <= 16) return Math.floor(n);
  return DEFAULT_WORKERS;
}

/**
 * @typedef {'queued'|'running'|'playable'|'complete'|'failed'|'cancelled'} JobState
 *
 * @typedef {object} ConversionJob
 * @property {string} id
 * @property {string} filePath
 * @property {string} outDir
 * @property {number} priority
 * @property {number} maxHeight
 * @property {JobState} state
 * @property {number} createdAt
 * @property {number|null} startedAt
 * @property {number|null} playableAt
 * @property {number|null} finishedAt
 * @property {string|null} error
 * @property {string|null} playlist
 * @property {number} segments
 * @property {(() => void)|null} stop
 * @property {import('node:child_process').ChildProcess|null} child
 * @property {(info: { playlist: string, segments: number }) => void} [onPlayable]
 * @property {(info: { playlist: string }) => void} [onComplete]
 * @property {(err: Error) => void} [onFailed]
 */

class ConversionManager extends EventEmitter {
  constructor({ concurrency } = {}) {
    super();
    this.concurrency = concurrency ?? envWorkers();
    /** @type {Map<string, ConversionJob>} */
    this.jobs = new Map();
    /** @type {string[]} */
    this.waiting = [];
    /** @type {Set<string>} */
    this.active = new Set();
    log.info(`conversion-manager: ${this.concurrency} worker(s)`);
  }

  setConcurrency(n) {
    this.concurrency = Math.max(1, Math.min(16, Number(n) || DEFAULT_WORKERS));
    this._pump();
  }

  /**
   * Enqueue (or return) a live-HLS conversion for `id`.
   * Duplicate ids are coalesced — one ffmpeg per session.
   */
  enqueue({
    id,
    filePath,
    outDir,
    priority = PRIORITY.WATCH_PARTY,
    maxHeight = 720,
    onPlayable,
    onComplete,
    onFailed,
  }) {
    if (!id) throw new Error('conversion job requires id');
    const existing = this.jobs.get(id);
    if (existing) {
      // Allow a fresh attempt after failure/cancel (e.g. host re-uploads).
      if (existing.state === 'failed' || existing.state === 'cancelled') {
        this.jobs.delete(id);
        this.waiting = this.waiting.filter((x) => x !== id);
        this.active.delete(id);
      } else {
        if (onPlayable) existing.onPlayable = onPlayable;
        if (onComplete) existing.onComplete = onComplete;
        if (onFailed) existing.onFailed = onFailed;
        if (priority < existing.priority && existing.state === 'queued') {
          existing.priority = priority;
          this.waiting.sort((a, b) => this.jobs.get(a).priority - this.jobs.get(b).priority);
        }
        if (existing.state === 'playable' || existing.state === 'complete') {
          queueMicrotask(() =>
            existing.onPlayable?.({ playlist: existing.playlist, segments: existing.segments })
          );
        }
        this._pump();
        return existing;
      }
    }

    /** @type {ConversionJob} */
    const job = {
      id,
      filePath,
      outDir: outDir || path.join(path.dirname(filePath), `${id}.hls`),
      priority,
      maxHeight,
      state: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      playableAt: null,
      finishedAt: null,
      error: null,
      playlist: null,
      segments: 0,
      stop: null,
      child: null,
      onPlayable,
      onComplete,
      onFailed,
    };
    this.jobs.set(id, job);
    this.waiting.push(id);
    this.waiting.sort((a, b) => this.jobs.get(a).priority - this.jobs.get(b).priority);
    log.info(`conversion queued ${id} (priority ${priority}, waiting=${this.waiting.length})`);
    this.emit('queued', job);
    this._pump();
    return job;
  }

  bumpPriority(id, priority = PRIORITY.ACTIVE_PARTY) {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (job.state !== 'queued') return job;
    job.priority = priority;
    this.waiting.sort((a, b) => this.jobs.get(a).priority - this.jobs.get(b).priority);
    this._pump();
    return job;
  }

  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.state === 'complete' || job.state === 'failed' || job.state === 'cancelled') return false;

    this.waiting = this.waiting.filter((x) => x !== id);
    try {
      job.stop?.();
    } catch {
      /* ignore */
    }
    job.child = null;
    job.stop = null;
    job.state = 'cancelled';
    job.finishedAt = Date.now();
    this.active.delete(id);
    log.info(`conversion cancelled ${id}`);
    this.emit('cancelled', job);
    this._pump();
    return true;
  }

  cleanup(id) {
    this.cancel(id);
    this.jobs.delete(id);
    this.waiting = this.waiting.filter((x) => x !== id);
    this.active.delete(id);
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  status(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    const queueIndex = this.waiting.indexOf(id);
    return {
      id: job.id,
      state: job.state,
      priority: job.priority,
      queuePosition: queueIndex >= 0 ? queueIndex + 1 : null,
      active: this.active.has(id),
      playable: job.state === 'playable' || job.state === 'complete',
      complete: job.state === 'complete',
      failed: job.state === 'failed',
      error: job.error,
      playlist: job.playlist,
      segments: job.segments,
      workers: this.concurrency,
      activeCount: this.active.size,
      waitingCount: this.waiting.length,
    };
  }

  snapshot() {
    return {
      workers: this.concurrency,
      active: [...this.active],
      waiting: [...this.waiting],
      jobs: [...this.jobs.values()].map((j) => ({
        id: j.id,
        state: j.state,
        priority: j.priority,
        error: j.error,
      })),
    };
  }

  _pump() {
    while (this.active.size < this.concurrency && this.waiting.length) {
      const id = this.waiting.shift();
      const job = this.jobs.get(id);
      if (!job || job.state !== 'queued') continue;
      this._start(job);
    }
  }

  _start(job) {
    job.state = 'running';
    job.startedAt = Date.now();
    this.active.add(job.id);
    log.info(`conversion start ${job.id} (active=${this.active.size}/${this.concurrency})`);
    this.emit('running', job);

    const handle = startLiveHls(job.filePath, job.outDir, {
      maxHeight: job.maxHeight,
      onReady: ({ playlist, segments } = {}) => {
        if (job.state === 'cancelled') return;
        job.playlist = playlist || path.join(job.outDir, 'index.m3u8');
        job.segments = segments || job.segments;
        if (job.state !== 'playable' && job.state !== 'complete') {
          job.state = 'playable';
          job.playableAt = Date.now();
          log.info(`conversion playable ${job.id} (${job.segments} segments)`);
          this.emit('playable', job);
          try {
            job.onPlayable?.({ playlist: job.playlist, segments: job.segments });
          } catch (err) {
            log.warn(`conversion onPlayable ${job.id}:`, err.message);
          }
        }
      },
      onDone: ({ playlist } = {}) => {
        if (job.state === 'cancelled') {
          this.active.delete(job.id);
          this._pump();
          return;
        }
        job.playlist = playlist || job.playlist || path.join(job.outDir, 'index.m3u8');
        job.state = 'complete';
        job.finishedAt = Date.now();
        this.active.delete(job.id);
        log.info(`conversion complete ${job.id}`);
        this.emit('complete', job);
        try {
          job.onComplete?.({ playlist: job.playlist });
        } catch (err) {
          log.warn(`conversion onComplete ${job.id}:`, err.message);
        }
        this._pump();
      },
      onError: (err) => {
        if (job.state === 'cancelled') {
          this.active.delete(job.id);
          this._pump();
          return;
        }
        // Already unlocked playback — treat late encode errors as soft.
        if (job.state === 'playable' || job.state === 'complete') {
          log.warn(`conversion late error ${job.id} (already playable):`, err?.message || err);
          job.state = 'complete';
          job.finishedAt = Date.now();
          this.active.delete(job.id);
          this._pump();
          return;
        }
        job.state = 'failed';
        job.error = err?.message || String(err) || 'ffmpeg failed';
        job.finishedAt = Date.now();
        this.active.delete(job.id);
        log.warn(`conversion failed ${job.id}: ${job.error}`);
        this.emit('failed', job);
        try {
          job.onFailed?.(err instanceof Error ? err : new Error(job.error));
        } catch (e) {
          log.warn(`conversion onFailed ${job.id}:`, e.message);
        }
        this._pump();
      },
    });

    job.child = handle.child;
    job.stop = handle.stop;
    job.playlist = handle.playlist;

    if (!handle.child) {
      // startLiveHls already invoked onError for missing source.
      this.active.delete(job.id);
      this._pump();
    }
  }
}

export const conversionManager = new ConversionManager();

export function enqueueLiveHls(opts) {
  return conversionManager.enqueue(opts);
}

export function cancelConversion(id) {
  return conversionManager.cancel(id);
}

export function cleanupConversion(id) {
  return conversionManager.cleanup(id);
}

export function conversionStatus(id) {
  return conversionManager.status(id);
}
