import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config, missingSecrets } from '../config.js';
import { log } from '../logger.js';
import { api } from './routes/api.js';
import { media } from './routes/media.js';
import { host, hostPage } from './routes/host.js';
import { attachWebSocket } from './ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../../dist/public');

export function startWebServer() {
  const app = express();
  app.disable('x-powered-by');

  // Discord embeds the Activity in an iframe; allow it and its CDNs.
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader(
      'Content-Security-Policy',
      "frame-ancestors https://*.discord.com https://*.discordsays.com;"
    );
    next();
  });

  // Local movie streaming (HTTP range) — same-origin as the Activity.
  app.use('/media', media);
  // Host uploader API (mounted before /api so its raw upload body isn't parsed).
  app.use(host);
  app.get('/host', (req, res) => res.type('html').send(hostPage()));

  app.use('/api', api);

  // Serve the built Activity if it exists.
  const built = fs.existsSync(path.join(PUBLIC_DIR, 'index.html'));
  if (built) {
    app.use(express.static(PUBLIC_DIR));
  }

  // Root: the built Activity, or a helpful setup page before `npm run build`.
  app.get('*', (req, res) => {
    if (built) {
      return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(setupPage());
  });

  const server = http.createServer(app);
  attachWebSocket(server);
  server.listen(config.app.port, () => {
    log.info(`Web server listening on :${config.app.port}`);
    if (config.app.baseUrl) log.info(`Public URL: ${config.app.baseUrl}`);
  });
  return server;
}

function setupPage() {
  const missing = missingSecrets();
  const rows = missing.length
    ? missing.map((m) => `<li><code>${m}</code></li>`).join('')
    : '<li>All required secrets are set ✅</li>';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>DarkNight Home Theater — Setup</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#0b0b12;color:#e7e7f0;margin:0;padding:2rem;line-height:1.6}
    .card{max-width:720px;margin:2rem auto;background:#15151f;border:1px solid #2a2a3a;border-radius:16px;padding:2rem}
    h1{margin-top:0;color:#c9a227}code{background:#20202c;padding:.15rem .4rem;border-radius:6px;color:#ffd66b}
    ol{padding-left:1.2rem}a{color:#7aa2ff}
  </style></head><body><div class="card">
  <h1>🎬 DarkNight Home Theater</h1>
  <p>The server is running but the frontend hasn't been built yet, or some secrets are missing.</p>
  <h3>Missing / required secrets</h3><ul>${rows}</ul>
  <h3>To finish setup</h3>
  <ol>
    <li>Fill in <code>.env</code> (see <code>.env.example</code>) or your host's Secrets.</li>
    <li>Run <code>npm run build</code> to build the Activity.</li>
    <li>Run <code>npm run register</code> once to register slash commands.</li>
    <li>Restart. Then in the Discord Developer Portal set your Activity URL mapping to this host.</li>
  </ol>
  <p>See <code>SETUP.md</code> in the repo for the full walkthrough.</p>
  <hr style="border-color:#2a2a3a;margin:1.5rem 0">
  <p style="font-size:.8rem;color:#9a97b5">⚖️ This bot owns and stores no video content. All media is provided by the
  operator from their own device/files. Whoever supplies content warrants it is purchased/licensed and is
  solely liable for it. Illegal or unlicensed content is not supported. See <code>DISCLAIMER.md</code>.</p>
  </div></body></html>`;
}
