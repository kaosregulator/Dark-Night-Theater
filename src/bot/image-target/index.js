/**
 * Image Target Watcher — public entry points.
 *
 * Two-stage detection: local pHash → optional Jina CLIP embeddings.
 * Guild-scoped targets, channel allow-list, configurable actions.
 */

export {
  imageTargetCommand,
  imageTrackCommand,
  handleImageTargetCommand,
} from './commands.js';

export { attachImageTargetWatcher, handleImageTargetMessage } from './watcher.js';

export {
  addTarget,
  listTargets,
  getGuildConfig,
  patchGuildConfig,
  isChannelWatched,
} from './store.js';

export {
  analyzeTargetBuffer,
  matchAgainstTargets,
  testAgainstTargets,
} from './detector.js';

export { getJinaProvider } from './providers/jina.js';
