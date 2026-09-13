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
const codesToChannel = new Map(); // 4-letter code -> channelId

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O (easy to misread)

function mintRoomCode() {
  for (let attempt = 0; attempt < 40; attempt++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
    if (!codesToChannel.has(code)) return code;
  }
  return `Z${Date.now().toString(36).slice(-3).toUpperCase()}`;
}

function emptyPlayback() {
  return {
    videoUid: null,
    videoName: null,
    src: null, // local /media URL (or HLS manifest)
    kind: null, // 'file' | 'hls'
    feedStatus: null, // temp-session upload feed: 'streaming' | 'stalled' | 'complete'
    hls: null,
    dash: null,
    playing: false,
    positionAtUpdate: 0, // seconds
    updatedAt: Date.now(),
    rate: 1,
    locked: true, // controls locked to host by default
    webPlayable: true,
    codecTip: null,
    videoCodec: null,
    audioCodec: null,
    converting: false, // server is re-encoding to H.264 for Discord
    // Bumped after temp-file remux/probe so Activity players reload the stream.
    mediaRevision: 0,
  };
}

function createRoom(channelId, { parentChannelId = null, boothLabel = null } = {}) {
  const room = {
    channelId, // room key (voice channel id OR booth:<channel>:<n>)
    parentChannelId, // voice channel this booth belongs to (null = primary room)
    boothLabel, // short label for UI ("Screen 2")
    guildId: null,
    hostId: null,
    mode: 'idle', // 'idle' | 'clan'
    roomCode: null, // 4-letter party code (set when a movie starts)
    codeLocked: false, // if true, joiners must enter the code before the foyer ritual
    snackBreak: false, // funny intermission overlay while the movie stays paused
    // Up to 3 staged titles — vote/pick, not a play queue.
    marquee: [], // [{ uid, name, category, thumbnail, durationSeconds, votes: {userId:true} }]
    booths: [], // child theater ids spawned from this voice channel
    playback: emptyPlayback(),
    participants: new Map(), // userId -> { id, name, avatar, seat, items[], inside, codeOk }
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
    parentChannelId: room.parentChannelId || null,
    boothLabel: room.boothLabel || null,
    guildId: room.guildId,
    hostId: room.hostId,
    mode: room.mode,
    roomCode: room.roomCode,
    codeLocked: Boolean(room.codeLocked),
    snackBreak: Boolean(room.snackBreak),
    marquee: (room.marquee || []).map((m) => ({
      uid: m.uid,
      name: m.name,
      category: m.category || '',
      thumbnail: m.thumbnail || '',
      durationSeconds: m.durationSeconds || 0,
      voteCount: Object.keys(m.votes || {}).length,
      voters: Object.keys(m.votes || {}),
    })),
    booths: (room.booths || []).map((b) => {
      const child = rooms.get(b.theaterId);
      return {
        theaterId: b.theaterId,
        label: b.label,
        roomCode: child?.roomCode || null,
        videoName: child?.playback?.videoName || b.videoName || null,
        mode: child?.mode || 'idle',
      };
    }),
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

// A seat a viewer picked in the /join pre-show, applied when they open the
// Activity (so their choice carries over). Cosmetic; falls back to null if taken.
const preferredSeats = new Map(); // channelId -> Map(userId -> seat)
export function setPreferredSeat(channelId, userId, seat) {
  let m = preferredSeats.get(channelId);
  if (!m) preferredSeats.set(channelId, (m = new Map()));
  m.set(userId, seat);
}

export function join(channelId, user) {
  const room = getRoom(channelId);
  if (user.guildId) room.guildId = user.guildId;
  const existing = room.participants.get(user.id);
  let seat = existing?.seat ?? null;
  if (seat == null) {
    const pref = preferredSeats.get(channelId)?.get(user.id);
    const free = pref != null && ![...room.participants.values()].some((p) => p.seat === pref);
    if (free) seat = pref;
  }
  // Host (or anyone already inside) stays inside across reconnects. Everyone
  // else starts in the foyer so they don't see the movie until they Enter.
  const isHost = room.hostId === user.id;
  const inside = existing?.inside === true || (isHost && room.mode === 'clan');
  room.participants.set(user.id, {
    id: user.id,
    name: user.name,
    avatar: user.avatar || null,
    seat,
    items: existing?.items ?? [],
    inside,
    codeOk: existing?.codeOk === true || isHost || !room.codeLocked,
  });
  broadcast(room, { event: { type: 'join', user: { id: user.id, name: user.name, inside } } });
  return room;
}

export function findChannelByCode(code) {
  const c = String(code || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 4);
  if (c.length !== 4) return null;
  return codesToChannel.get(c) || null;
}

export function unlockWithCode(channelId, userId, code) {
  const room = rooms.get(channelId);
  if (!room) return { ok: false, reason: 'No theater here.' };
  if (!room.roomCode) return { ok: false, reason: 'No party code yet — wait for a host to start a movie.' };
  if (String(code || '').trim().toUpperCase() !== room.roomCode) {
    return { ok: false, reason: 'Wrong code — ask the host for the 4-letter room code.' };
  }
  const p = room.participants.get(userId);
  if (p) p.codeOk = true;
  broadcast(room);
  return { ok: true, roomCode: room.roomCode };
}

export function setCodeLocked(channelId, by, locked) {
  const room = getRoom(channelId);
  if (room.hostId && room.hostId !== by) return { ok: false, reason: 'Only the host can lock the door.' };
  room.codeLocked = Boolean(locked);
  broadcast(room);
  return { ok: true };
}

export function setSnackBreak(channelId, by, on) {
  const room = getRoom(channelId);
  if (room.hostId && room.hostId !== by) return { ok: false, reason: 'Only the host can call snack break.' };
  room.snackBreak = Boolean(on);
  if (on && room.playback.playing) {
    // Pause on snack break so nobody misses a scene.
    const now = Date.now();
    room.playback.positionAtUpdate = livePosition(room, now);
    room.playback.playing = false;
    room.playback.updatedAt = now;
  }
  broadcast(room, { event: { type: on ? 'snack-break' : 'snack-done' } });
  return { ok: true };
}

// Audience finished the foyer / join ritual — seat them and let the movie through.
export function enterTheater(channelId, userId, { seat, items } = {}) {
  const room = getRoom(channelId);
  const p = room.participants.get(userId);
  if (!p) return { ok: false, reason: 'Not in this theater yet.' };
  if (room.mode !== 'clan' || !room.playback.videoUid) {
    return { ok: false, reason: 'No movie is playing right now.' };
  }
  if (room.codeLocked && !p.codeOk && room.hostId !== userId) {
    return { ok: false, reason: 'This party is code-locked. Enter the 4-letter room code first.' };
  }
  p.inside = true;
  if (Array.isArray(items) && items.length) {
    p.items = [...new Set([...(p.items || []), ...items.filter(Boolean)])];
  }
  if (seat != null && Number.isFinite(Number(seat))) {
    const want = Number(seat);
    const taken = [...room.participants.values()].some((o) => o.seat === want && o.id !== userId);
    if (!taken) p.seat = want;
  }
  broadcast(room, { event: { type: 'enter', user: { id: userId, name: p.name } } });
  return { ok: true };
}

// Active watch parties (clan movie loaded) — the /join audience board reads this.
export function listActiveRooms(guildId) {
  const out = [];
  for (const room of rooms.values()) {
    if (room.mode !== 'clan' || !room.playback.videoUid) continue;
    if (guildId && room.guildId !== guildId) continue;
    const inside = [...room.participants.values()].filter((x) => x.inside).length;
    out.push({
      channelId: room.channelId,
      guildId: room.guildId,
      hostId: room.hostId,
      roomCode: room.roomCode,
      codeLocked: Boolean(room.codeLocked),
      videoUid: room.playback.videoUid,
      videoName: room.playback.videoName,
      viewers: inside || room.participants.size,
      playing: room.playback.playing,
    });
  }
  return out;
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
  const p = room.participants.get(userId);
  if (p && room.mode === 'clan') p.inside = true;
  broadcast(room);
}

export function isHost(channelId, userId) {
  const room = rooms.get(channelId);
  return room ? room.hostId === userId : false;
}

export function setControlMessage(channelId, ref) {
  getRoom(channelId).controlMessage = ref;
}

// Update the temp-session upload feed status ('streaming'|'stalled'|'complete')
// so the Theater can tell viewers when it's waiting on the host's upload.
export function setFeedStatus(channelId, status) {
  const room = rooms.get(channelId);
  if (!room || room.playback.feedStatus === status) return;
  room.playback.feedStatus = status;
  broadcast(room);
}

// Attach codec / web-playability meta after a host upload is probed/remuxed.
export function setPlaybackMeta(channelId, meta = {}) {
  const room = rooms.get(channelId);
  if (!room) return;
  if (meta.webPlayable != null) room.playback.webPlayable = Boolean(meta.webPlayable);
  if ('codecTip' in meta) room.playback.codecTip = meta.codecTip || null;
  if ('videoCodec' in meta) room.playback.videoCodec = meta.videoCodec || null;
  if ('audioCodec' in meta) room.playback.audioCodec = meta.audioCodec || null;
  if (meta.converting != null) room.playback.converting = Boolean(meta.converting);
  if (meta.bumpRevision || meta.mediaRevision != null) {
    room.playback.mediaRevision =
      meta.mediaRevision != null
        ? Number(meta.mediaRevision) || 0
        : (room.playback.mediaRevision || 0) + 1;
  }
  broadcast(room);
}

// Swap the live stream URL (e.g. after server-side H.264 / HLS convert finishes).
export function setPlaybackSource(channelId, playback = {}) {
  const room = rooms.get(channelId);
  if (!room) return;
  if (playback.src != null) room.playback.src = playback.src;
  if (playback.kind != null) room.playback.kind = playback.kind;
  if ('hls' in playback) room.playback.hls = playback.hls;
  if ('dash' in playback) room.playback.dash = playback.dash;
  if (playback.webPlayable != null) room.playback.webPlayable = Boolean(playback.webPlayable);
  if ('codecTip' in playback) room.playback.codecTip = playback.codecTip || null;
  room.playback.converting = false;
  room.playback.mediaRevision = (room.playback.mediaRevision || 0) + 1;
  broadcast(room, { event: { type: 'media-ready' } });
}

// Load a movie into the clan session and start it.

const MAX_MARQUEE = 3;

function primaryRoomId(channelOrTheaterId) {
  const room = rooms.get(channelOrTheaterId);
  return room?.parentChannelId || channelOrTheaterId;
}

/** Stage a title on the marquee (max 3). Host/anyone in room can nominate. */
export function addToMarquee(channelId, video) {
  const room = getRoom(channelId);
  if (!video?.uid) return { ok: false, reason: 'Missing video' };
  room.marquee = room.marquee || [];
  if (room.marquee.some((m) => m.uid === video.uid)) {
    broadcast(room, { event: { type: 'marquee' } });
    return { ok: true, marquee: snapshot(room).marquee };
  }
  if (room.marquee.length >= MAX_MARQUEE) {
    return { ok: false, reason: 'Marquee is full (3 movies max). Remove one first.' };
  }
  room.marquee.push({
    uid: video.uid,
    name: video.name,
    category: video.category || '',
    thumbnail: video.thumbnail || video.animatedThumbnail || '',
    durationSeconds: video.durationSeconds || video.duration || 0,
    votes: {},
  });
  broadcast(room, { event: { type: 'marquee', action: 'add', uid: video.uid } });
  return { ok: true, marquee: snapshot(room).marquee };
}

export function removeFromMarquee(channelId, by, uid) {
  const room = getRoom(channelId);
  if (room.hostId && room.hostId !== by) {
    return { ok: false, reason: 'Only the host can remove marquee titles.' };
  }
  room.marquee = (room.marquee || []).filter((m) => m.uid !== uid);
  broadcast(room, { event: { type: 'marquee', action: 'remove', uid } });
  return { ok: true };
}

/** One vote per user — switching vote moves their ballot. */
export function voteMarquee(channelId, userId, uid) {
  const room = getRoom(channelId);
  const list = room.marquee || [];
  if (!list.some((m) => m.uid === uid)) return { ok: false, reason: 'That title is not on the marquee.' };
  for (const m of list) {
    if (m.votes?.[userId]) delete m.votes[userId];
  }
  const target = list.find((m) => m.uid === uid);
  target.votes = target.votes || {};
  target.votes[userId] = true;
  broadcast(room, { event: { type: 'marquee', action: 'vote', uid, userId } });
  return { ok: true, marquee: snapshot(room).marquee };
}

export function clearMarquee(channelId, by) {
  const room = getRoom(channelId);
  if (room.hostId && room.hostId !== by) {
    return { ok: false, reason: 'Only the host can clear the marquee.' };
  }
  room.marquee = [];
  broadcast(room, { event: { type: 'marquee', action: 'clear' } });
  return { ok: true };
}

/**
 * Open an independent theater booth under this voice channel so another Activity
 * instance can watch a different marquee title (same VC chat, separate screen).
 */
export function openBooth(channelId, { hostId, guildId, video, playback, label } = {}) {
  const parent = getRoom(channelId);
  parent.booths = parent.booths || [];
  if (parent.booths.length >= MAX_MARQUEE) {
    return { ok: false, reason: 'Already have 3 theater screens for this channel.' };
  }
  const n = parent.booths.length + 1;
  const theaterId = `booth:${channelId}:${n}`;
  const booth = createRoom(theaterId, {
    parentChannelId: channelId,
    boothLabel: label || `Screen ${n}`,
  });
  parent.booths.push({ theaterId, label: booth.boothLabel, videoName: video?.name || null });
  if (video && playback) {
    startClanMovie(theaterId, { hostId, guildId: guildId || parent.guildId, video, playback });
  }
  // Drop started title from parent marquee so votes stay for remaining picks.
  if (video?.uid) {
    parent.marquee = (parent.marquee || []).filter((m) => m.uid !== video.uid);
  }
  broadcast(parent, {
    event: {
      type: 'booth',
      theaterId,
      label: booth.boothLabel,
      roomCode: booth.roomCode,
      video: video ? { uid: video.uid, name: video.name } : null,
    },
  });
  return {
    ok: true,
    theaterId,
    roomCode: booth.roomCode,
    snapshot: snapshot(booth),
  };
}

export function listBooths(channelId) {
  const parent = getRoom(primaryRoomId(channelId));
  return snapshot(parent).booths;
}

export function startClanMovie(channelId, { hostId, guildId, video, playback }) {
  const room = getRoom(channelId);
  // Retire previous code mapping if any.
  if (room.roomCode) codesToChannel.delete(room.roomCode);
  room.mode = 'clan';
  room.hostId = hostId;
  if (guildId) room.guildId = guildId;
  room.roomCode = mintRoomCode();
  codesToChannel.set(room.roomCode, channelId);
  room.codeLocked = false;
  room.snackBreak = false;
  room.playback = {
    ...emptyPlayback(),
    videoUid: video.uid,
    videoName: video.name,
    src: playback.src,
    kind: playback.kind,
    hls: playback.hls,
    dash: playback.dash,
    playing: false,
    positionAtUpdate: 0,
    updatedAt: Date.now(),
    locked: true,
    // Host session may already know MovieBox/large files need convert — pass
    // through so Activities never attach HEVC progressive during upload.
    webPlayable: playback.webPlayable != null ? Boolean(playback.webPlayable) : true,
    codecTip: playback.codecTip || null,
    converting: Boolean(playback.converting),
    videoCodec: playback.videoCodec || null,
    audioCodec: playback.audioCodec || null,
  };
  // Host is already "in the theater"; everyone else stays in the foyer until Enter.
  for (const p of room.participants.values()) {
    p.inside = p.id === hostId;
    p.codeOk = p.id === hostId || !room.codeLocked;
  }
  // Playing this title — pull it off the marquee so remaining picks stay votable.
  room.marquee = (room.marquee || []).filter((m) => m.uid !== video.uid);
  broadcast(room, {
    event: { type: 'movie', video: { uid: video.uid, name: video.name }, roomCode: room.roomCode },
  });
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
      if (room.roomCode) codesToChannel.delete(room.roomCode);
      room.roomCode = null;
      room.codeLocked = false;
      room.snackBreak = false;
      room.mode = 'idle';
      room.playback = emptyPlayback();
      for (const part of room.participants.values()) {
        part.inside = false;
        part.codeOk = false;
      }
      broadcast(room, { event: { type: 'ended' } });
      return { ok: true };
    case 'snack':
      room.snackBreak = Boolean(value);
      if (room.snackBreak && p.playing) {
        p.positionAtUpdate = cur;
        p.playing = false;
      }
      break;
    case 'codeLock':
      room.codeLocked = Boolean(value);
      break;
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
