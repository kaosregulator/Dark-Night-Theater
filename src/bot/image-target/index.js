/**
 * Image Target Watcher — public entry points.
 *
 * V2.1: adaptive deep scan for uncertain/edited media.
 * V2: multi-frame sampling → multi-variant normalization → multi-hash ensemble
 * → soft local ranking → optional Jina CLIP → score aggregation → action.
 * Guild-scoped targets, channel allow-list, configurable actions.
 */

export {
  imageTargetCommand,
  imageTrackCommand,
  handleImageTargetCommand,
} from './commands.js';

export {
  handleImageTargetHub,
  buildHubPayload,
  parseHubId,
  HUB_PREFIX,
} from './hub.js';

export { attachImageTargetWatcher, handleImageTargetMessage } from './watcher.js';

export {
  addTarget,
  listTargets,
  getGuildConfig,
  patchGuildConfig,
  isChannelWatched,
  listTargetFingerprints,
  replaceTargetFingerprints,
} from './store.js';

export {
  analyzeTargetBuffer,
  matchAgainstTargets,
  testAgainstTargets,
  persistTargetFingerprints,
  shouldEscalateToDeepScan,
  buildDeepScanDiagnostics,
} from './detector.js';

export { getJinaProvider } from './providers/jina.js';
