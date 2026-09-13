import assert from 'node:assert/strict';
import {
  getRoom,
  snapshot,
  addToMarquee,
  voteMarquee,
  removeFromMarquee,
  openBooth,
  startClanMovie,
} from '../src/services/sessions.js';

const channelId = 'test-vc-marquee';
const room = getRoom(channelId);
room.hostId = 'host-1';

const v1 = { uid: 'a', name: 'Alpha', category: 'Action', thumbnail: '', durationSeconds: 100 };
const v2 = { uid: 'b', name: 'Bravo', category: 'Comedy', thumbnail: '', durationSeconds: 120 };
const v3 = { uid: 'c', name: 'Charlie', category: 'Drama', thumbnail: '', durationSeconds: 90 };
const v4 = { uid: 'd', name: 'Delta', category: 'Horror', thumbnail: '', durationSeconds: 80 };

assert.equal(addToMarquee(channelId, v1).ok, true);
assert.equal(addToMarquee(channelId, v2).ok, true);
assert.equal(addToMarquee(channelId, v3).ok, true);
assert.equal(addToMarquee(channelId, v4).ok, false, '4th title should be rejected');

voteMarquee(channelId, 'u1', 'b');
voteMarquee(channelId, 'u2', 'b');
voteMarquee(channelId, 'u3', 'a');
// switch vote
voteMarquee(channelId, 'u3', 'b');
const snap = snapshot(getRoom(channelId));
const bravo = snap.marquee.find((m) => m.uid === 'b');
assert.equal(bravo.voteCount, 3);
assert.ok(!bravo.voters.includes('missing'));

removeFromMarquee(channelId, 'host-1', 'a');
assert.equal(snapshot(getRoom(channelId)).marquee.length, 2);

const booth = openBooth(channelId, {
  hostId: 'host-1',
  guildId: 'g1',
  video: v2,
  playback: { src: '/media/b.mp4', kind: 'file' },
  label: 'Screen 2',
});
assert.equal(booth.ok, true);
assert.ok(booth.theaterId.startsWith('booth:'));
assert.ok(booth.roomCode);
assert.equal(getRoom(booth.theaterId).playback.videoUid, 'b');
assert.equal(snapshot(getRoom(channelId)).marquee.some((m) => m.uid === 'b'), false);

startClanMovie(channelId, {
  hostId: 'host-1',
  guildId: 'g1',
  video: v3,
  playback: { src: '/media/c.mp4', kind: 'file' },
});
assert.equal(getRoom(channelId).playback.videoUid, 'c');
assert.equal(snapshot(getRoom(channelId)).marquee.length, 0);

console.log('ALL PASSED — marquee + booth theaters');
