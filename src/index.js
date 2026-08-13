import { config, readiness, missingSecrets } from './config.js';
import { log } from './logger.js';
import { startWebServer } from './web/server.js';
import { startBot } from './bot/client.js';
import { syncLibrary } from './services/library-store.js';

// ============================================================================
//  DarkNight Home Theater — single-process entrypoint.
//  Starts the web server (serves the Discord Activity + API + WebSocket sync)
//  and the Discord bot together. Designed so a fresh clone + secrets = running.
// ============================================================================

function banner() {
  log.info('════════════════════════════════════════════');
  log.info('🎬  DarkNight Home Theater');
  log.info('════════════════════════════════════════════');
  const miss = missingSecrets();
  log.info(`Bot ready:        ${readiness.bot ? '✅' : '❌'}`);
  log.info(`Activity OAuth:   ${readiness.activity ? '✅' : '❌'}`);
  log.info(`Movie host:       ✅ local files (${config.media.dir})`);
  if (config.app.baseUrl) log.info(`Add movies at:    ${config.app.baseUrl}/host`);
  if (miss.length) log.warn(`Missing secrets:  ${miss.join(', ')}`);
  if (!config.app.baseUrl) log.warn('PUBLIC_BASE_URL not set — Activity URL mapping needs it.');
}

async function main() {
  banner();

  // Web server always starts (even unconfigured) so hosting shows "running".
  startWebServer();

  // Bot starts if configured.
  await startBot().catch((err) => log.error('Bot failed to start:', err.message));

  // Scan the media folder on boot so files dropped in are ready immediately.
  syncLibrary().catch((err) => log.warn('Initial media scan skipped:', err.message));
}

main().catch((err) => {
  log.error('Fatal startup error:', err);
  process.exit(1);
});

// Keep the process resilient on Replit/Railway.
process.on('unhandledRejection', (reason) => log.error('unhandledRejection:', reason));
process.on('uncaughtException', (err) => log.error('uncaughtException:', err));
