// Local Activity preferences (per device / Discord client).

const KEY = 'dnTheaterPrefs';

const defaults = {
  /** Floating reacts, foyer twinkles, ghost FX on the screen */
  fxEnabled: true,
  /** Last concession high score (local) */
  concessionBest: 0,
  /** Screen fit: adapt | stretch | cinema43 */
  aspectMode: 'adapt',
  /** Immersive seat POV when watching */
  seatPov: true,
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
    const m = read().aspectMode;
    return m === 'stretch' || m === 'cinema43' ? m : 'adapt';
  },
  setAspectMode(mode) {
    const m = mode === 'stretch' || mode === 'cinema43' ? mode : 'adapt';
    return write({ aspectMode: m });
  },
  get seatPov() {
    return read().seatPov !== false;
  },
  setSeatPov(on) {
    return write({ seatPov: Boolean(on) });
  },
};
