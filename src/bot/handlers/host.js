import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { signHostSession } from '../../media/token.js';
import { config } from '../../config.js';
import { getSettings } from '../../services/settings-store.js';
import { canHost, canManage } from '../permissions.js';
import { COLORS } from './format.js';
import { createActivityInvite } from './theater.js';

// ============================================================================
//  /host — the primary host entry point. Opens a signed /host upload page so
//  an admin can pick a video from their device, start the party, then return
//  to Discord. The Activity main menu (join / room code / seats) is where the
//  audience lives after that.
// ============================================================================

export async function handleHostCommand(interaction) {
  const settings = getSettings(interaction.guildId);
  if (!settings.homeTheaterEnabled) {
    return interaction.reply({ content: '🚫 Home Theater is turned off for this server.', ephemeral: true });
  }

  const member = interaction.member;
  if (!member || !(canHost(member) || canManage(member))) {
    return interaction.reply({
      content: '🔒 Only hosts / admins can upload a movie. Ask a host, or open the **Activity menu → Host a Movie** if you have permission.',
      ephemeral: true,
    });
  }

  if (!config.app.baseUrl) {
    return interaction.reply({
      content: '⚠️ `PUBLIC_BASE_URL` is not set on the bot, so the host upload page can’t be linked yet.',
      ephemeral: true,
    });
  }

  const voiceId = member.voice?.channelId;
  if (!voiceId) {
    return interaction.reply({
      content: '🔊 Join a voice channel first, then run **/host** again so the party lands in the right room.',
      ephemeral: true,
    });
  }

  const token = signHostSession({
    userId: member.id,
    guildId: interaction.guildId,
    voiceChannelId: voiceId,
    textChannelId: interaction.channelId,
  });
  const hostUrl = `${config.app.baseUrl}/host?s=${encodeURIComponent(token)}`;

  let activityUrl = null;
  try {
    const voice = await interaction.guild.channels.fetch(voiceId).catch(() => null);
    if (voice) activityUrl = await createActivityInvite(voice);
  } catch {
    /* Activity invite is optional — host link is the critical path */
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle('📤 Host a Movie')
    .setDescription(
      [
        '1. Tap **Upload & Start Party** — keep that browser tab open while it uploads.',
        '2. Come back to Discord and launch the **DarkNight** Activity in this voice channel.',
        '3. Share the **4-letter room code** from the Activity top bar with your friends.',
        '4. Friends hit **Join** (or enter the code if you lock the door) → concessions → seat → movie.',
      ].join('\n')
    )
    .setFooter({ text: 'Any movie works — we auto-convert to a Discord-safe stream' });

  const rows = [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel('Upload & Start Party')
        .setEmoji('📤')
        .setURL(hostUrl)
    ),
  ];
  if (activityUrl) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel('Open Theater Activity')
          .setEmoji('🎬')
          .setURL(activityUrl)
      )
    );
  }

  return interaction.reply({ embeds: [embed], components: rows, ephemeral: true });
}
