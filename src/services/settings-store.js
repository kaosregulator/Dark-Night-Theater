import { JsonStore } from './json-store.js';

// Per-guild settings. EVERY server has its own config (never global), matching
// the spec. Unknown guilds fall back to defaults until an admin changes them.

export const DEFAULT_SETTINGS = {
  homeTheaterEnabled: true,
  privateViewingEnabled: true,
  clanMovieEnabled: true,
  publicViewingEnabled: false, // let normal members join the clan movie
  currentClanMovieUid: null,
  hostRoleId: null, // custom "Theater Host" role; owner+admins always allowed
  managerRoleId: null, // custom "Theater Manager" role for changing movies
  maxViewers: 50,
  allowSocialInteractions: true,
  showAvatars: true,
};

const store = new JsonStore('settings.json', { guilds: {} });

export function getSettings(guildId) {
  const saved = store.data.guilds[guildId] || {};
  return { ...DEFAULT_SETTINGS, ...saved };
}

export function setSettings(guildId, patch) {
  const next = { ...getSettings(guildId), ...patch };
  store.data.guilds[guildId] = next;
  store.save();
  return next;
}

export function toggleSetting(guildId, key) {
  const cur = getSettings(guildId);
  return setSettings(guildId, { [key]: !cur[key] });
}
