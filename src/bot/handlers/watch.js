import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from 'discord.js';
import * as library from '../../services/library-store.js';
import * as sessions from '../../services/sessions.js';
import { getPlaybackUrls } from '../../cloudflare/stream.js';
import { getSettings } from '../../services/settings-store.js';
import { canHost, canManage } from '../permissions.js';
import { formatDuration, videoLabel, COLORS } from './format.js';
import { createActivityInvite, publishPanel } from './theater.js';

// ============================================================================
//  /watch — browse the library (thumbnail, title, duration, category), then
//  start a synced Watch Party in your voice channel or watch privately.
//  Browsing is ephemeral (personal); starting a party posts a public panel.
// ============================================================================

function browseComponents(videos) {
  // Discord select menus cap at 25 options.
  const options = videos.slice(0, 25).map((v) => ({
    label: v.name.slice(0, 100),
    description: `${formatDuration(v.durationSeconds)} • ${v.category}`.slice(0, 100),
    value: v.uid,
  }));
  const select = new StringSelectMenuBuilder()
    .setCustomId('w:pick')
    .setPlaceholder('🎬 Pick a movie…')
    .addOptions(options.length ? options : [{ label: 'No videos found', value: 'none' }])
    .setDisabled(options.length === 0);
  return [new ActionRowBuilder().addComponents(select)];
}

export async function handleWatchCommand(interaction) {
  const settings = getSettings(interaction.guildId);
  if (!settings.homeTheaterEnabled) {
    return interaction.reply({ content: '🚫 Home Theater is turned off for this server.', ephemeral: true });
  }

  const query = interaction.options.getString('search') || '';
  const category = interaction.options.getString('category') || '';
  const videos = library.search({ query, category });

  if (library.getCachedLibrary().length === 0) {
    return interaction.reply({
      content:
        '📭 The library is empty. An admin should run `/library sync` after wiring Cloudflare Stream.',
      ephemeral: true,
    });
  }

  const cats = library
    .categories()
    .map((c) => `\`${c.name}\` (${c.count})`)
    .join('  ');
  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle('🍿 DarkNight Library')
    .setDescription(
      `${videos.length} result${videos.length === 1 ? '' : 's'}${query ? ` for “${query}”` : ''}.` +
        `\nPick one below to see details and start watching.`
    )
    .addFields({ name: 'Categories', value: cats || '—' })
    .setFooter({ text: 'Showing up to 25 — refine with /watch search:<text> or category:<name>' });

  await interaction.reply({ embeds: [embed], components: browseComponents(videos), ephemeral: true });
}

// A video was picked from the select menu — show details + action buttons.
export async function handleWatchPick(interaction) {
  const uid = interaction.values?.[0];
  const video = library.findVideo(uid);
  if (!video) return interaction.update({ content: 'That video is no longer available.', embeds: [], components: [] });

  const progress = sessions.getPrivateProgress(interaction.user.id, uid);
  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle(`🎬 ${video.name}`)
    .setThumbnail(video.thumbnail || null)
    .addFields(
      { name: 'Duration', value: formatDuration(video.durationSeconds), inline: true },
      { name: 'Category', value: video.category, inline: true },
      { name: 'Access', value: video.requireSignedURLs ? '🔒 Signed' : '🌐 Public', inline: true }
    );
  if (video.description) embed.setDescription(video.description.slice(0, 500));
  if (progress?.position) {
    embed.addFields({ name: 'Resume', value: `You left off at \`${formatDuration(progress.position)}\`` });
  }

  const settings = getSettings(interaction.guildId);
  const row = new ActionRowBuilder();
  if (settings.clanMovieEnabled) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`w:party:${uid}`)
        .setLabel('Start Watch Party')
        .setEmoji('🍿')
        .setStyle(ButtonStyle.Success)
    );
  }
  if (settings.privateViewingEnabled) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`w:private:${uid}`)
        .setLabel('Watch Privately')
        .setEmoji('🔒')
        .setStyle(ButtonStyle.Secondary)
    );
  }
  row.addComponents(
    new ButtonBuilder().setCustomId('w:back').setLabel('Back').setStyle(ButtonStyle.Secondary)
  );

  await interaction.update({ embeds: [embed], components: [row] });
}

// "Start Watch Party" — load the movie into the voice channel's clan session
// and post the public live-control panel.
export async function handleWatchParty(interaction, uid) {
  const member = interaction.member;
  const settings = getSettings(interaction.guildId);
  if (!settings.clanMovieEnabled) {
    return interaction.reply({ content: '🚫 Clan movie nights are off for this server.', ephemeral: true });
  }
  const voice = member.voice?.channel;
  if (!voice) {
    return interaction.reply({ content: '🔊 Join a voice channel first, then start the party.', ephemeral: true });
  }
  if (!canHost(member) && !canManage(member)) {
    return interaction.reply({
      content: '🔒 You don’t have permission to start a clan movie here.',
      ephemeral: true,
    });
  }
  const video = library.findVideo(uid);
  if (!video) return interaction.reply({ content: 'That video is unavailable.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });
  const playback = await getPlaybackUrls(video);
  sessions.startClanMovie(voice.id, {
    hostId: member.id,
    guildId: interaction.guildId,
    video,
    playback,
  });
  const activityUrl = await createActivityInvite(voice);
  await publishPanel(interaction.channel, voice.id, activityUrl);

  await interaction.editReply({
    content: `✅ Loaded **${video.name}** in <#${voice.id}>. Panel posted — press ▶️ to begin. Open the Theater to watch.`,
  });
}

// "Watch Privately" — launch the Activity in private mode (independent session).
export async function handleWatchPrivate(interaction, uid) {
  const settings = getSettings(interaction.guildId);
  if (!settings.privateViewingEnabled) {
    return interaction.reply({ content: '🚫 Private viewing is off for this server.', ephemeral: true });
  }
  const voice = interaction.member.voice?.channel;
  if (!voice) {
    return interaction.reply({
      content: '🔊 Join any voice channel to open the Theater, then choose Private mode inside.',
      ephemeral: true,
    });
  }
  const activityUrl = await createActivityInvite(voice);
  const video = library.findVideo(uid);
  await interaction.reply({
    content: activityUrl
      ? `🔒 Open the Theater and pick **Private** to watch **${video?.name || 'your movie'}** on your own:\n${activityUrl}`
      : 'Could not create the Theater launch link — check the bot has permission to create invites.',
    ephemeral: true,
  });
}

export async function handleWatchBack(interaction) {
  // Re-run the browse view with no filter.
  const videos = library.getCachedLibrary();
  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle('🍿 DarkNight Library')
    .setDescription('Pick a movie to see details.');
  await interaction.update({ embeds: [embed], components: browseComponents(videos) });
}
