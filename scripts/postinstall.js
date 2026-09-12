// Runs after npm install. Never throws — a failed optional step must not break
// Railway/local installs.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

try {
  console.log('\n✅ Dependencies installed for DarkNight Home Theater.');
  console.log('   Next: copy .env.example -> .env and fill in your secrets,');
  console.log('   then run:  npm run build  &&  npm start');
  console.log('   (register slash commands once with: npm run register)\n');
} catch {
  /* no-op */
}

// Pull the ~380MB MakeEmoji offline pack (skipped if already present).
try {
  const r = spawnSync(process.execPath, [join(here, 'fetch-emoji-offline.mjs')], {
    stdio: 'inherit',
    env: process.env,
  });
  if (r.status !== 0) {
    console.warn('[postinstall] emoji-offline fetch exited', r.status);
  }
} catch (err) {
  console.warn('[postinstall] emoji-offline fetch skipped:', err?.message ?? err);
}
