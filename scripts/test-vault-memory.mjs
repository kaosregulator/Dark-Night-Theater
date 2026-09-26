/**
 * Smoke test: vault memory fallback (no DATABASE_URL) — chunked upload + expand.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as vault from '../src/media/vault.js';

process.env.LIBRARY_QUOTA_GB = '1';

const tmpPayload = Buffer.alloc(3 * 1024 * 1024 + 1200, 0x5a);
tmpPayload.write('DARKNIGHT-VAULT-TEST', 0);

const started = await vault.beginUpload({
  name: 'full-movie-test.mp4',
  size: tmpPayload.length,
  title: 'Full Movie Test',
  category: 'Library',
});
assert.ok(started.id);
assert.equal(started.video.status, 'uploading');

const chunk = 512 * 1024;
let offset = 0;
while (offset < tmpPayload.length) {
  const end = Math.min(offset + chunk, tmpPayload.length);
  const r = await vault.appendUpload(started.id, offset, tmpPayload.subarray(offset, end));
  offset = r.receivedBytes;
}
assert.equal(offset, tmpPayload.length);

const video = await vault.finalizeUpload(started.id, { title: 'Full Movie Test' });
assert.equal(video.ready, true);
assert.equal(video.vault, true);
assert.ok(video.compressedSize > 0);
assert.ok(video.compressedSize < video.size); // gzip should shrink the zeros-ish payload

const usage = await vault.usageForScope();
assert.ok(usage.usedBytes >= video.compressedSize);

const expanded = await vault.ensureMaterialized(started.id);
assert.ok(expanded && fs.existsSync(expanded));
assert.equal(fs.statSync(expanded).size, tmpPayload.length);

const listed = await vault.listMovies();
assert.ok(listed.some((v) => v.uid === started.id));

await vault.removeMovie(started.id);
assert.equal(await vault.findMovie(started.id), null);

console.log('vault smoke ok', {
  rawMb: (tmpPayload.length / 1048576).toFixed(2),
  gzMb: (video.compressedSize / 1048576).toFixed(2),
  quotaGb: (usage.quotaBytes / (1024 ** 3)).toFixed(2),
});
