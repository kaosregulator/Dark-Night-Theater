import {
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { log } from '../../logger.js';
import { ACTIONS, DEFAULT_TIMEOUT_MS } from './constants.js';
import {
  getGuildConfig,
  getStrikes,
  incrementStrike,
  recordDetection,
} from './store.js';

/**
 * Lightweight moderation actions for image-target matches.
 * No full moderation suite — just the actions needed here.
 * Escalation (optional) walks delete_warn → delete_timeout → delete_kick → delete_ban.
 */

export function pct(score) {
  return `${(Math.max(0, Math.min(1, score)) * 100).toFixed(1)}%`;
}

export function buildDetectionEmbed({
  user,
  channel,
  target,
  score,
  method,
  messageId,
  action,
  strikes,
}) {
  return new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle('🚨 Target image detected')
    .addFields(
      { name: 'User', value: `${user}`, inline: true },
      { name: 'Channel', value: `${channel}`, inline: true },
      { name: 'Target', value: target.name, inline: true },
      { name: 'Similarity', value: `**${pct(score)}**`, inline: true },
      { name: 'Method', value: method, inline: true },
      { name: 'Action', value: action, inline: true },
      ...(strikes != null
        ? [{ name: 'Strikes', value: String(strikes), inline: true }]
        : []),
      { name: 'Message ID', value: `\`${messageId}\``, inline: false },
    )
    .setTimestamp();
}

async function safeDelete(message) {
  try {
    if (!message.deletable) {
      log.warn(
        `[image-target] cannot delete message ${message.id} in #${message.channel?.id} — ` +
          'bot needs Manage Messages in this channel',
      );
      return false;
    }
    await message.delete();
    return true;
  } catch (err) {
    log.warn('[image-target] delete failed:', err.message);
    return false;
  }
}

async function safeWarn(message, target, score) {
  try {
    await message.channel.send({
      content:
        `⚠️ ${message.author} — your image matched watched target **${target.name}** ` +
        `(${pct(score)}). Please do not repost it.`,
      allowedMentions: { users: [message.author.id] },
    });
  } catch (err) {
    log.warn('[image-target] warn failed:', err.message);
  }
}

async function meCan(guild, perm) {
  const me = guild.members.me;
  return Boolean(me?.permissions?.has(perm));
}

/**
 * Apply the configured (or escalated) action for a match.
 * Returns the action string that was attempted.
 */
export async function applyDetectionAction(message, match) {
  const guildId = message.guild.id;
  const cfg = await getGuildConfig(guildId);
  let action = ACTIONS.includes(cfg.action) ? cfg.action : 'delete_warn';

  let strikes = await getStrikes(guildId, message.author.id);
  if (cfg.escalationEnabled && Array.isArray(cfg.escalation) && cfg.escalation.length) {
    const idx = Math.min(strikes, cfg.escalation.length - 1);
    action = cfg.escalation[idx] || action;
  }

  const deleted = action.startsWith('delete_')
    ? await safeDelete(message)
    : false;

  // Always public-warn on delete_warn. If delete failed for any delete_* action,
  // still warn so mods see something happened (silent failures were confusing).
  if (action === 'delete_warn' || (action.startsWith('delete_') && !deleted)) {
    await safeWarn(message, match.target, match.score);
  } else if (action === 'log') {
    // log-only: no public warn
  }

  if (action === 'delete_timeout') {
    if (await meCan(message.guild, PermissionFlagsBits.ModerateMembers)) {
      try {
        const ms = cfg.timeoutMs || DEFAULT_TIMEOUT_MS;
        await message.member?.timeout(ms, `Image target: ${match.target.name}`);
      } catch (err) {
        log.warn('[image-target] timeout failed:', err.message);
      }
    }
  }

  if (action === 'delete_kick') {
    if (await meCan(message.guild, PermissionFlagsBits.KickMembers)) {
      try {
        await message.member?.kick(`Image target: ${match.target.name}`);
      } catch (err) {
        log.warn('[image-target] kick failed:', err.message);
      }
    }
  }

  if (action === 'delete_ban') {
    if (await meCan(message.guild, PermissionFlagsBits.BanMembers)) {
      try {
        await message.member?.ban({
          reason: `Image target: ${match.target.name}`,
          deleteMessageSeconds: 0,
        });
      } catch (err) {
        log.warn('[image-target] ban failed:', err.message);
      }
    }
  }

  strikes = await incrementStrike(guildId, message.author.id);

  const detection = await recordDetection(guildId, {
    userId: message.author.id,
    channelId: message.channel.id,
    messageId: message.id,
    targetId: match.target.targetId,
    targetName: match.target.name,
    similarity: match.score,
    method: match.method,
    action,
    deleted,
  });

  // Log channel (or fall back to the watched channel).
  const embed = buildDetectionEmbed({
    user: message.author,
    channel: message.channel,
    target: match.target,
    score: match.score,
    method: match.method,
    messageId: message.id,
    action,
    strikes,
  });

  try {
    const logId = cfg.logChannelId;
    const logCh = logId
      ? await message.guild.channels.fetch(logId).catch(() => null)
      : message.channel;
    if (logCh?.isTextBased?.()) {
      await logCh.send({ embeds: [embed] });
    }
  } catch (err) {
    log.warn('[image-target] log post failed:', err.message);
  }

  return { action, strikes, detection, deleted };
}
