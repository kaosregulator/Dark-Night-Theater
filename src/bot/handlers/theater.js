import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InviteTargetType,
} from 'discord.js';
import { config } from '../../config.js';
import { log } from '../../logger.js';
import { canHost } from '../permissions.js';
import { getSettings } from '../../services/settings-store.js';
import * as sessions from '../../services/sessions.js';
import { formatDuration, COLORS } from './format.js';

// ============================================================================
//  The text-channel control panel — "live buttons in Discord".
//  Buttons carry the target voice channel id, mutate the shared room state
//  (sessions.control), and the panel message auto-refreshes as state changes,
//  so pressing ⏯ here moves the video for everyone in the Activity too.
// ============================================================================

// channelId -> discord.js Message (the control panel to keep refreshed)
const panels = new Map();

function ctlId(action, channelId) {
  return `t:ctl:${action}:${channelId}`;
}

function controlRows(channelId, { activityUrl } = {}) {
  const room = sessions.getRoom(channelId);
  const p = room.playback;
  const playing = p.playing;

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(ctlId('back30', channelId)).setLabel('-30s').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(ctlId('back10', channelId)).setLabel('-10s').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(ctlId('toggle', channelId))
      .setLabel(playing ? 'Pause' : 'Play')
      .setEmoji(playing ? '⏸️' : '▶️')
      .setStyle(playing ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId(ctlId('fwd10', channelId)).setLabel('+10s').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(ctlId('fwd30', channelId)).setLabel('+30s').setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ctlId('lock', channelId))
      .setLabel(p.locked ? 'Controls: Host only' : 'Controls: Everyone')
      .setEmoji(p.locked ? '🔒' : '🔓')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(ctlId('end', channelId)).setLabel('End').setEmoji('⏹️').setStyle(ButtonStyle.Secondary)
  );
  if (activityUrl) {
    row2.addComponents(
      new ButtonBuilder().setLabel('Open Theater').setEmoji('🎬').setStyle(ButtonStyle.Link).setURL(activityUrl)
    );
  }
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(ctlId('ioshelp', channelId))
      .setLabel('iOS / Android not working?')
      .setEmoji('📱')
      .setStyle(ButtonStyle.Secondary)
  );
  return [row1, row2, row3];
}

const IOS_MOBILE_HELP =
  '**“This Activity is not currently available on this OS”** comes from Discord — not this bot.\n\n' +
  '**App owner fix (takes ~30 seconds):**\n' +
  '1. Open [Discord Developer Portal](https://discord.com/developers/applications) → your **DarkNight** app\n' +
  '2. Left sidebar: **Activities → Settings**\n' +
  '3. Turn **Enable Activities** ON\n' +
  '4. Under **Supported Platforms**, check **Web**, **iOS**, and **Android** → **Save**\n\n' +
  'Then reopen the Activity from a voice channel on your phone. Until those boxes are checked, Discord blocks the Activity on mobile before our theater can load.';

function panelEmbed(channelId) {
  const room = sessions.getRoom(channelId);
  const p = room.playback;
  const pos = formatDuration(sessions.livePosition(room));
  const hostMention = room.hostId ? `<@${room.hostId}>` : '—';
  const embed = new EmbedBuilder()
    .setColor(p.playing ? COLORS.green : COLORS.gold)
    .setTitle('🎬 DarkNight Home Theater')
    .setDescription(
      p.videoUid
        ? `**Now playing:** ${p.videoName}\n**Status:** ${p.playing ? '▶️ Playing' : '⏸️ Paused'} at \`${pos}\`${
            p.codecTip ? `\n\n⚠️ **Playback tip:** ${p.codecTip}` : ''
          }`
        : 'No movie loaded yet. Pick one with `/watch`, then press Play.'
    )
    .addFields(
      { name: 'Host', value: hostMention, inline: true },
      { name: 'Watching', value: String(room.participants.size), inline: true },
      { name: 'Controls', value: p.locked ? '🔒 Host only' : '🔓 Everyone', inline: true },
      {
        name: '📱 Phone / iOS',
        value:
          'If Discord says Activity isn’t available: Developer Portal → **Activities → Settings** → enable **iOS** + **Android**. Tap **📱 iOS / Android not working?** below for steps.',
        inline: false,
      }
    )
    .setFooter({
      text: 'Open Theater in a voice channel · Mobile needs iOS+Android checked in the Developer Portal',
    });
  return embed;
}

// Create the activity launch invite for a voice channel (this is how a bot
// opens a Discord Activity — an EMBEDDED_APPLICATION invite).
async function createActivityInvite(voiceChannel) {
  try {
    const invite = await voiceChannel.createInvite({
      targetType: InviteTargetType.EmbeddedApplication,
      targetApplication: config.discord.clientId,
      maxAge: 0,
    });
    return `https://discord.gg/${invite.code}`;
  } catch (err) {
    log.warn('Could not create activity invite:', err.message);
    return null;
  }
}

export async function handleTheaterCommand(interaction) {
  const member = interaction.member;
  const settings = getSettings(interaction.guildId);
  if (!settings.homeTheaterEnabled) {
    return interaction.reply({ content: '🚫 Home Theater is turned off for this server.', ephemeral: true });
  }
  const voice = member.voice?.channel;
  if (!voice) {
    return interaction.reply({
      content: '🔊 Join a **voice channel** first — that\'s where the Theater opens.',
      ephemeral: true,
    });
  }

  // The user who opens the theater becomes host if allowed and none is set.
  const room = sessions.getRoom(voice.id);
  room.guildId = interaction.guildId;
  if (!room.hostId && canHost(member)) sessions.setHost(voice.id, member.id);

  const activityUrl = await createActivityInvite(voice);

  await interaction.reply({
    embeds: [panelEmbed(voice.id)],
    components: controlRows(voice.id, { activityUrl }),
  });
  const message = await interaction.fetchReply();
  panels.set(voice.id, message);
  sessions.setControlMessage(voice.id, { channelId: message.channelId, messageId: message.id });
}

// Handle a control-panel button press.
export async function handleControlButton(interaction, action, channelId) {
  const member = interaction.member;
  const room = sessions.getRoom(channelId);

  // Lock/unlock and end are host/staff actions; playback obeys the room lock.
  const staffAction = action === 'lock' || action === 'end';
  if (staffAction && !canHost(member) && room.hostId !== member.id) {
    return interaction.reply({ content: '🔒 Only the host can do that.', ephemeral: true });
  }

  let result = { ok: true };
  switch (action) {
    case 'ioshelp':
      return interaction.reply({ content: IOS_MOBILE_HELP, ephemeral: true });
    case 'toggle':
      result = sessions.control(channelId, member.id, 'toggle');
      break;
    case 'back10':
      result = sessions.control(channelId, member.id, 'seekBy', -10);
      break;
    case 'back30':
      result = sessions.control(channelId, member.id, 'seekBy', -30);
      break;
    case 'fwd10':
      result = sessions.control(channelId, member.id, 'seekBy', 10);
      break;
    case 'fwd30':
      result = sessions.control(channelId, member.id, 'seekBy', 30);
      break;
    case 'lock':
      result = sessions.control(channelId, member.id, room.playback.locked ? 'unlock' : 'lock');
      break;
    case 'end':
      result = sessions.control(channelId, member.id, 'end');
      break;
    default:
      result = { ok: false, reason: 'Unknown action.' };
  }

  if (!result.ok) {
    return interaction.reply({ content: `⛔ ${result.reason}`, ephemeral: true });
  }
  // Acknowledge silently; the panel refresh (below, via bus) shows new state.
  await interaction.deferUpdate();
}

// Keep control panels in sync with room state changes (from any surface).
let refreshWired = false;
export function wireControlPanelRefresh() {
  if (refreshWired) return;
  refreshWired = true;
  const pending = new Map(); // channelId -> timeout (debounce edits)
  sessions.bus.on('update', ({ channelId }) => {
    const msg = panels.get(channelId);
    if (!msg) return;
    if (pending.has(channelId)) return;
    pending.set(
      channelId,
      setTimeout(async () => {
        pending.delete(channelId);
        try {
          // Preserve the existing link button (activity URL) if present.
          const linkBtn = msg.components?.[1]?.components?.find((c) => c.data?.style === ButtonStyle.Link);
          const activityUrl = linkBtn?.data?.url;
          await msg.edit({ embeds: [panelEmbed(channelId)], components: controlRows(channelId, { activityUrl }) });
        } catch (err) {
          log.debug('panel refresh failed:', err.message);
        }
      }, 500)
    );
  });
}

// Publish (or re-publish) a public control panel into a text channel and track
// it for live refresh. Used by /theater and by the /watch "Start Watch Party".
export async function publishPanel(textChannel, voiceChannelId, activityUrl) {
  const message = await textChannel.send({
    embeds: [panelEmbed(voiceChannelId)],
    components: controlRows(voiceChannelId, { activityUrl }),
  });
  panels.set(voiceChannelId, message);
  sessions.setControlMessage(voiceChannelId, { channelId: message.channelId, messageId: message.id });
  return message;
}

export { createActivityInvite, controlRows, panelEmbed };
