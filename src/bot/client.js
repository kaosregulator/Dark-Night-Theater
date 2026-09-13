import { Client, GatewayIntentBits, Events, ActivityType } from 'discord.js';
import { config, readiness } from '../config.js';
import { log } from '../logger.js';
import { routeInteraction } from './handlers/index.js';
import { wireControlPanelRefresh } from './handlers/theater.js';
import { setDiscordClient } from './clientRef.js';
import { attachImageTargetWatcher } from './image-target/index.js';

// Core intents required for the theater bot (always safe).
const CORE_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildVoiceStates,
];

// Privileged extras for /image-target message scanning.
// MessageContent MUST be enabled in the Discord Developer Portal or Discord
// rejects login with "Used disallowed intents".
const IMAGE_TARGET_INTENTS = [
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
];

function isDisallowedIntentsError(err) {
  const msg = String(err?.message || err || '');
  return /disallowed intents/i.test(msg);
}

function buildClient({ withImageTargetIntents }) {
  const intents = withImageTargetIntents
    ? [...CORE_INTENTS, ...IMAGE_TARGET_INTENTS]
    : [...CORE_INTENTS];

  const client = new Client({ intents });

  client.once(Events.ClientReady, (c) => {
    log.info(`Bot online as ${c.user.tag}`);
    c.user.setActivity('🎬 /host · Activity menu', { type: ActivityType.Watching });
    wireControlPanelRefresh();
  });

  client.on(Events.InteractionCreate, routeInteraction);
  client.on(Events.Error, (e) => log.error('discord client error:', e.message));

  if (withImageTargetIntents) {
    attachImageTargetWatcher(client);
  }

  setDiscordClient(client);
  return client;
}

/**
 * Boots the Discord bot.
 * Tries privileged intents first (for image-target). If Discord rejects them,
 * falls back to core intents so the theater stays online, and logs how to
 * enable Message Content Intent for image watching.
 */
export async function startBot() {
  if (!readiness.bot) {
    log.warn('Bot not started: DISCORD_BOT_TOKEN / DISCORD_CLIENT_ID missing.');
    return null;
  }

  // Attempt 1: full intents (theater + image-target watcher).
  let client = buildClient({ withImageTargetIntents: true });
  try {
    await client.login(config.discord.botToken);
    return client;
  } catch (err) {
    if (!isDisallowedIntentsError(err)) throw err;

    log.error(
      'Bot login rejected: Used disallowed intents. ' +
        'Message Content Intent is not enabled for this application.',
    );
    log.warn(
      'Falling back without image-target intents so the theater bot can stay online. ' +
        'To enable /image-target watching: Discord Developer Portal → your app → Bot → ' +
        'Privileged Gateway Intents → turn ON "Message Content Intent" → Save → Redeploy.',
    );

    try {
      client.destroy();
    } catch {
      /* ignore */
    }

    // Attempt 2: core intents only (theater still works; image-target idle).
    client = buildClient({ withImageTargetIntents: false });
    await client.login(config.discord.botToken);
    log.warn(
      '[image-target] watcher NOT attached — enable Message Content Intent, then redeploy.',
    );
    return client;
  }
}
