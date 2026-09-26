import { config, readiness, missingSecrets } from './config.js';
import { log } from './logger.js';
import { startWebServer } from './web/server.js';
import { startBot } from './bot/client.js';
import { syncLibrary } from './services/library-store.js';
import { hasDatabaseUrl, pingDatabase } from './db/postgres.js';
import { migrateImageTargetSchema } from './bot/image-target/migrate.js';
import { migrateVaultSchema } from './media/vault.js';

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
  log.info(`Movie host:       ✅ local + vault (${config.media.dir}, ${config.media.libraryQuotaGb} GB quota)`);
  log.info(`Postgres:         ${hasDatabaseUrl() ? '✅ DATABASE_URL set' : '❌ DATABASE_URL missing'}`);
  if (config.app.baseUrl) log.info(`Add movies at:    ${config.app.baseUrl}/host`);
  if (miss.length) log.warn(`Missing secrets:  ${miss.join(', ')}`);
  if (!config.app.baseUrl) log.warn('PUBLIC_BASE_URL not set — Activity URL mapping needs it.');
}

async function initPostgres() {
  if (!hasDatabaseUrl()) {
    log.warn(
      '[postgres] DATABASE_URL not set — share Postgres.DATABASE_URL into this Railway service. Image Target + movie vault need it.',
    );
    return false;
  }
  try {
    await pingDatabase();
    await migrateImageTargetSchema();
    await migrateVaultSchema();
    return true;
  } catch (err) {
    log.error('[postgres] init failed:', err.message);
    return false;
  }
}

async function main() {
  banner();

  // Web server always starts (even unconfigured) so hosting shows "running".
  startWebServer();

  // Postgres schema (image-target + movie vault) — best-effort before the bot connects.
  await initPostgres();

  // Bot starts if configured.
  await startBot().catch((err) => log.error('Bot failed to start:', err.message));

  // Scan the media folder + vault on boot so files / films are ready immediately.
  syncLibrary().catch((err) => log.warn('Initial media scan skipped:', err.message));
}

main().catch((err) => {
  log.error('Fatal startup error:', err);
  process.exit(1);
});

// Keep the process resilient on Replit/Railway.
process.on('unhandledRejection', (reason) => log.error('unhandledRejection:', reason));
process.on('uncaughtException', (err) => log.error('uncaughtException:', err));
