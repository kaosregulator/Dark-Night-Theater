#!/usr/bin/env node
/**
 * Regression: PR #16 skew + main.js's 4s cached-snapshot tick froze the
 * playhead target and hard-seeked viewers backward (segment loop).
 *
 * Mirrors TheaterPlayer.applyState target math without a DOM <video>.
 */

function computeTarget(playback, { now, skewMs, acceptStaleServerTime }) {
  let nextSkew = skewMs;
  if (playback.serverTime != null) {
    const ageMs = now - playback.serverTime;
    if (acceptStaleServerTime || ageMs < 1500) {
      nextSkew = playback.serverTime - now;
    }
  }

  let target;
  if (playback.playing && playback.updatedAt) {
    const nowApprox = now + nextSkew;
    const elapsed = (nowApprox - playback.updatedAt) / 1000;
    target = (playback.positionAtUpdate ?? 0) + elapsed * (playback.rate || 1);
  } else if (playback.playing && playback.serverTime != null) {
    const elapsed = (now + nextSkew - playback.serverTime) / 1000;
    target = (playback.livePosition ?? playback.positionAtUpdate ?? 0) + elapsed * (playback.rate || 1);
  } else {
    target = playback.livePosition ?? playback.positionAtUpdate ?? 0;
  }
  return { target, skewMs: nextSkew };
}

function assertClose(name, got, want, tol = 0.05) {
  if (Math.abs(got - want) > tol) {
    console.error(`FAIL ${name}: got ${got}, want ~${want}`);
    process.exitCode = 1;
  } else {
    console.log(`ok  ${name}`);
  }
}

const t0 = 1_000_000;
const anchor = {
  playing: true,
  rate: 1,
  positionAtUpdate: 10,
  updatedAt: t0,
  livePosition: 10,
  serverTime: t0,
};

// Fresh WS packet at t0+100ms — tiny skew, target ~10.1
{
  const pb = { ...anchor, livePosition: 10.1, serverTime: t0 + 100 };
  const { target, skewMs } = computeTarget(pb, { now: t0 + 100, skewMs: 0, acceptStaleServerTime: false });
  assertClose('fresh packet advances', target, 10.1);
  assertClose('fresh skew near 0', skewMs, 0, 1);
}

// Cached snapshot re-applied 4s later (main.js interval) — must KEEP advancing.
{
  const cached = { ...anchor, livePosition: 10, serverTime: t0 }; // frozen at join
  // Bug path: accepting stale serverTime as skew freezes target at ~10
  const buggy = computeTarget(cached, { now: t0 + 4000, skewMs: 0, acceptStaleServerTime: true });
  assertClose('buggy stale skew freezes (~10)', buggy.target, 10, 0.2);

  // Fix path: ignore stale serverTime, wall-clock from updatedAt → ~14
  const fixed = computeTarget(cached, { now: t0 + 4000, skewMs: 0, acceptStaleServerTime: false });
  assertClose('fixed stale snapshot advances (~14)', fixed.target, 14, 0.2);
  assertClose('fixed keeps prior skew', fixed.skewMs, 0, 0.01);
}

// Drift that would hard-seek backward if target froze while playhead moved
{
  const playhead = 13.5;
  const fixed = computeTarget(
    { ...anchor, livePosition: 10, serverTime: t0 },
    { now: t0 + 4000, skewMs: 0, acceptStaleServerTime: false }
  );
  const drift = playhead - fixed.target; // ~13.5 - 14 = -0.5 (behind, OK)
  if (Math.abs(drift) > 6) {
    console.error(`FAIL would hard-seek: drift=${drift}`);
    process.exitCode = 1;
  } else {
    console.log('ok  fixed drift stays under progressive hard-seek');
  }

  const buggy = computeTarget(
    { ...anchor, livePosition: 10, serverTime: t0 },
    { now: t0 + 4000, skewMs: 0, acceptStaleServerTime: true }
  );
  const badDrift = playhead - buggy.target; // ~13.5 - 10 = 3.5… with longer lag exceeds hard
  const playheadLater = 17;
  const badDrift2 = playheadLater - buggy.target; // 7s ahead of frozen target → hard seek BACK
  if (badDrift2 <= 6) {
    console.error(`FAIL expected buggy path to exceed hard seek, drift=${badDrift2}`);
    process.exitCode = 1;
  } else {
    console.log('ok  buggy path would hard-seek backward (regression signature)');
  }
  void badDrift;
}

if (process.exitCode) {
  console.error('\nplayback sync target tests FAILED');
  process.exit(1);
}
console.log('\nplayback sync target tests passed');
