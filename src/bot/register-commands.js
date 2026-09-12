import { REST, Routes } from 'discord.js';
import { config, readiness } from '../config.js';
import { commands } from './commands.js';
import { log } from '../logger.js';

// Registers slash commands with Discord. Run once (and after changing command
// definitions):  npm run register
// If DISCORD_DEV_GUILD_ID is set, registers to that guild (instant); otherwise
// registers globally (can take up to ~1h to propagate).
//
// Discord Activities can have a special Entry Point command. Discord does not
// allow a bulk command overwrite to remove that command, so preserve it when
// replacing the normal slash-command set.

export async function registerCommands() {
  if (!readiness.bot) {
    log.error('Cannot register commands: DISCORD_BOT_TOKEN / DISCORD_CLIENT_ID missing.');
    return false;
  }
  const rest = new REST({ version: '10' }).setToken(config.discord.botToken);
  const { clientId, devGuildId } = config.discord;
  const route = devGuildId
    ? Routes.applicationGuildCommands(clientId, devGuildId)
    : Routes.applicationCommands(clientId);

  try {
    // Preserve Discord's Activity Entry Point command if one already exists.
    const existing = await rest.get(route);
    const entryPoint = Array.isArray(existing)
      ? existing.find((command) => command.type === 4)
      : null;
    const body = entryPoint ? [...commands, entryPoint] : commands;

    await rest.put(route, { body });

    if (devGuildId) {
      log.info(`Registered ${commands.length} commands to dev guild ${devGuildId}${entryPoint ? ' (preserved Activity Entry Point).' : '.'}`);
    } else {
      log.info(`Registered ${commands.length} global commands${entryPoint ? ' (preserved Activity Entry Point).' : '.'}`);
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
