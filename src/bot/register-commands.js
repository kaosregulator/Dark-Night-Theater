import { REST, Routes } from 'discord.js';
import { config, readiness } from '../config.js';
import { commands } from './commands.js';
import { log } from '../logger.js';

// Registers slash commands with Discord. Run once (and after changing command
// definitions):  npm run register
// If DISCORD_DEV_GUILD_ID is set, registers to that guild (instant); otherwise
// registers globally (can take up to ~1h to propagate).

export async function registerCommands() {
  if (!readiness.bot) {
    log.error('Cannot register commands: DISCORD_BOT_TOKEN / DISCORD_CLIENT_ID missing.');
    return false;
  }
  const rest = new REST({ version: '10' }).setToken(config.discord.botToken);
  const { clientId, devGuildId } = config.discord;
  try {
    if (devGuildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, devGuildId), { body: commands });
      log.info(`Registered ${commands.length} commands to dev guild ${devGuildId}.`);
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      log.info(`Registered ${commands.length} global commands.`);
    }
    return true;
  } catch (err) {
    log.error('Command registration failed:', err.message);
    return false;
  }
}

// Allow running this file directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  registerCommands().then((ok) => process.exit(ok ? 0 : 1));
}
