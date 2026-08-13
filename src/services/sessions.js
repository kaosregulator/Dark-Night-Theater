import { EventEmitter } from 'node:events';
import { JsonStore } from './json-store.js';

// ============================================================================
//  Session / room state — the heart of "Watch Together".
//
//  A ROOM is keyed by a Discord *voice channel id*. Both surfaces share it:
//    - the in-Discord Activity player (Embedded App SDK) reports channelId
//    - the text-channel control buttons carry the same channelId
//  so pressing ▶ in the channel and pressing ▶ in the theater drive one state.
//
//  Playback state is stored as an "anchor": (positionAtUpdate, updatedAt,
//  playing, rate). Any client computes the live position as
//      playing ? positionAtUpdate + (now - updatedAt) * rate : positionAtUpdate
//  which keeps everyone in sync without a constant stream of timestamps and is
//  robust for 1hr+ videos.
// ============================================================================

export const bus = new EventEmitter();
bus.setMaxListeners(0);

const rooms = new Map(); // channelId -> room

function emptyPlayback() {
  return {
    videoUid: null,
    videoName: null,
    hls: null,
    dash: null,
    playing: false,
    positionAtUpdate: 0, // seconds
    updatedAt: Date.now(),
    rate: 1,
    locked: true, // controls locked to host by default
  };
}

function createRoom(channelId) {
  const room = {
    channelId,
    guildId: null,
    hostId: null,
    mode: 'idle', // 'idle' | 'clan'
    playback: emptyPlayback(),
    participants: new Map(), // userId -> { id, name, avatar, seat, items[] }
    controlMessage: null, // { channelId, messageId } of the text-channel control embed
  };
  rooms.set(channelId, room);
  return room;
}

export function getRoom(channelId) {
  return rooms.get(channelId) || createRoom(channelId);
}

// Live position at "now", accounting for elapsed time while playing.
export function livePosition(room, now = Date.now()) {
  const p = room.playback;
  if (!p.playing) return p.positionAtUpdate;
  return p.positionAtUpdate + ((now - p.updatedAt) / 1000) * p.rate;
}

// A serialisable snapshot for clients.
export function snapshot(room) {
  return {
    channelId: room.channelId,
    guildId: room.guildId,
    hostId: room.hostId,
    mode: room.mode,
    playback: {
      ...room.playback,
      // include a computed live position so late joiners seek correctly
      livePosition: livePosition(room),
      serverTime: Date.now(),
    },
    participants: [...room.participants.values()],
  };
}

function broadcast(room, extra = {}) {
  bus.emit('update', { channelId: room.channelId, snapshot: snapshot(room), ...extra });
}

// ---- presence ---------------------------------------------------------------

export function join(channelId, user) {
  const room = getRoom(channelId);
  if (user.guildId) room.guildId = user.guildId;
  const existing = room.participants.get(user.id);
  room.participants.set(user.id, {
    id: user.id,
    name: user.name,
    avatar: user.avatar || null,
    seat: existing?.seat ?? null,
    items: existing?.items ?? [],
  });
  broadcast(room, { event: { type: 'join', user: { id: user.id, name: user.name } } });
  return room;
}

export function leave(channelId, userId) {
  const room = rooms.get(channelId);
  if (!room) return;
  const p = room.participants.get(userId);
  room.participants.delete(userId);
  broadcast(room, { event: { type: 'leave', user: p ? { id: p.id, name: p.name } : { id: userId } } });
  // Tidy up empty rooms after a while (keep for reconnects).
  if (room.participants.size === 0 && room.mode === 'idle') rooms.delete(channelId);
}

export function takeSeat(channelId, userId, seat) {
  const room = getRoom(channelId);
  const p = room.participants.get(userId);
  if (!p) return;
  // one person per seat
  for (const other of room.participants.values()) {
    if (other.seat === seat && other.id !== userId) return;
  }
  p.seat = seat;
  broadcast(room);
}

export function giveItem(channelId, userId, item) {
  const room = getRoom(channelId);
  const p = room.participants.get(userId);
  if (!p) return;
  p.items = [...new Set([...(p.items || []), item])];
  broadcast(room, { event: { type: 'item', user: { id: userId, name: p.name }, item } });
}

// ---- host / clan playback control ------------------------------------------

export function setHost(channelId, userId) {
  const room = getRoom(channelId);
  room.hostId = userId;
  broadcast(room);
}

export function isHost(channelId, userId) {
  const room = rooms.get(channelId);
  return room ? room.hostId === userId : false;
}

export function setControlMessage(channelId, ref) {
  getRoom(channelId).controlMessage = ref;
}

// Load a movie into the clan session and start it.
export function startClanMovie(channelId, { hostId, guildId, video, playback }) {
  const room = getRoom(channelId);
  room.mode = 'clan';
  room.hostId = hostId;
  if (guildId) room.guildId = guildId;
  room.playback = {
    ...emptyPlayback(),
    videoUid: video.uid,
    videoName: video.name,
    hls: playback.hls,
    dash: playback.dash,
    playing: false,
    positionAtUpdate: 0,
    updatedAt: Date.now(),
    locked: true,
  };
  broadcast(room, { event: { type: 'movie', video: { uid: video.uid, name: video.name } } });
  return room;
}

// Apply a control action. `by` is the user id; enforced against host unless the
// room is unlocked. Returns { ok, reason }.
export function control(channelId, by, action, value) {
  const room = getRoom(channelId);
  const p = room.playback;
  const allowed = !p.locked || room.hostId === by || room.hostId == null;
  if (!allowed) return { ok: false, reason: 'Only the host can control playback right now.' };

  const now = Date.now();
  // snapshot current live position before mutating
  const cur = livePosition(room, now);

  switch (action) {
    case 'play':
      p.positionAtUpdate = cur;
      p.playing = true;
      break;
    case 'pause':
      p.positionAtUpdate = cur;
      p.playing = false;
      break;
    case 'toggle':
      p.positionAtUpdate = cur;
      p.playing = !p.playing;
      break;
    case 'seek':
      p.positionAtUpdate = Math.max(0, Number(value) || 0);
      break;
    case 'seekBy':
      p.positionAtUpdate = Math.max(0, cur + (Number(value) || 0));
      break;
    case 'rate':
      p.rate = Number(value) || 1;
      break;
    case 'lock':
      p.locked = true;
      break;
    case 'unlock':
      p.locked = false;
      break;
    case 'end':
      room.mode = 'idle';
      room.playback = emptyPlayback();
      broadcast(room, { event: { type: 'ended' } });
      return { ok: true };
    default:
      return { ok: false, reason: `Unknown action: ${action}` };
  }
  p.updatedAt = now;
  broadcast(room);
  return { ok: true };
}

// ============================================================================
//  Private viewing — independent per-user sessions + watch history.
// ============================================================================
const historyStore = new JsonStore('history.json', { users: {} });

export function savePrivateProgress(userId, video, positionSeconds) {
  const u = (historyStore.data.users[userId] ||= { items: {} });
  u.items[video.uid] = {
    uid: video.uid,
    name: video.name,
    thumbnail: video.thumbnail,
    durationSeconds: video.durationSeconds,
    position: Math.max(0, Math.round(positionSeconds)),
    updatedAt: new Date().toISOString(),
  };
  historyStore.save();
}

export function getPrivateProgress(userId, uid) {
  return historyStore.data.users[userId]?.items?.[uid] || null;
}

export function getHistory(userId) {
  const items = historyStore.data.users[userId]?.items || {};
  return Object.values(items).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
