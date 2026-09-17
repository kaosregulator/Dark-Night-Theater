// Local Activity preferences (per device / Discord client).

const KEY = 'dnTheaterPrefs';

const defaults = {
  /** Floating reacts, foyer twinkles, ghost FX on the screen */
  fxEnabled: true,
  /** Last concession high score (local) */
  concessionBest: 0,
  /** Screen fit: cover (fill) | adapt (letterbox) | stretch | cinema43 */
  aspectMode: 'cover',
};

function read() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
}

function write(patch) {
  const next = { ...read(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  return next;
}

export const prefs = {
  get: read,
  set: write,
  get fxEnabled() {
    return read().fxEnabled !== false;
  },
  setFxEnabled(on) {
    return write({ fxEnabled: Boolean(on) });
  },
  get concessionBest() {
    return Number(read().concessionBest) || 0;
  },
  setConcessionBest(n) {
    const best = Math.max(prefs.concessionBest, Number(n) || 0);
    write({ concessionBest: best });
    return best;
  },
  get aspectMode() {
    const raw = read();
    // One-shot: old default "adapt" letterboxed over the theater house.
    if (!raw.aspectMigratedV2) {
      const next =
        raw.aspectMode === 'stretch' || raw.aspectMode === 'cinema43' ? raw.aspectMode : 'cover';
      write({ aspectMode: next, aspectMigratedV2: true });
      return next;
    }
    const m = raw.aspectMode;
    if (m === 'stretch' || m === 'cinema43' || m === 'adapt' || m === 'cover') return m;
    return 'cover';
  },
  setAspectMode(mode) {
    const allowed = new Set(['cover', 'adapt', 'stretch', 'cinema43']);
    return write({ aspectMode: allowed.has(mode) ? mode : 'cover', aspectMigratedV2: true });
  },
};
