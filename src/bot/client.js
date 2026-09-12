import { Client, GatewayIntentBits, Events, ActivityType } from 'discord.js';
import { config, readiness } from '../config.js';
import { log } from '../logger.js';
import { routeInteraction } from './handlers/index.js';
import { wireControlPanelRefresh } from './handlers/theater.js';
import { setDiscordClient } from './clientRef.js';

// Boots the Discord bot. Returns the client (or null if not configured, so the
// web server can still run and show setup help).
export async function startBot() {
  if (!readiness.bot) {
    log.warn('Bot not started: DISCORD_BOT_TOKEN / DISCORD_CLIENT_ID missing.');
    return null;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates, // needed to see who is in voice channels
    ],
  });

  client.once(Events.ClientReady, (c) => {
    log.info(`Bot online as ${c.user.tag}`);
    c.user.setActivity('🎬 /host · Activity menu', { type: ActivityType.Watching });
    wireControlPanelRefresh();
  });

  client.on(Events.InteractionCreate, routeInteraction);
  client.on(Events.Error, (e) => log.error('discord client error:', e.message));

  setDiscordClient(client); // let the web layer post panels / create invites
  await client.login(config.discord.botToken);
  return client;
}
