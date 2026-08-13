import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import * as library from '../../services/library-store.js';
import * as sessions from '../../services/sessions.js';
import { getSettings } from '../../services/settings-store.js';
import { getPlaybackUrls } from '../../cloudflare/stream.js';
import { canHost, canManage } from '../permissions.js';
import { createActivityInvite, publishPanel } from './theater.js';
import { COLORS } from './format.js';
import { renderBoxOffice, renderTicket, renderConcession, renderSeated, assignSeat, ticketNumber } from '../canvas/cards.js';

// ============================================================================
//  In-Discord gamified PRE-SHOW (all Canvas embeds, no external site):
//    Box Office preview → 🎟 Ticket → 🍿 Popcorn → 🪑 Seat → 🎬 Enter Theater
//  Each step is an ephemeral embed with a generated image featuring the user's
//  avatar. The owner's poster/title/screen (from Cloudflare) is the preview.
// ============================================================================

const SNACKS = ['a LARGE Popcorn 🍿', 'Nachos & Cheese 🧀', 'Candy 🍫', 'a Soda 🥤', 'a Combo Deal 🎟', 'Extra Butter Popcorn 🧈'];

function userFrom(interaction) {
  return {
    id: interaction.user.id,
    name: interaction.member?.displayName || interaction.user.globalName || interaction.user.username,
    avatar: interaction.user.displayAvatarURL({ extension: 'png', size: 128 }),
  };
}

function embedWith(name, description) {
  return new EmbedBuilder().setColor(COLORS.gold).setImage(`attachment://${name}`).setDescription(description);
}

function btn(id, label, style = ButtonStyle.Secondary, emoji) {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
}

// Step 1 — Box Office preview (owner's poster/title/screen).
export async function showBoxOffice(interaction, uid) {
  const video = library.findVideo(uid);
  if (!video) return interaction.update({ content: 'That video is unavailable.', embeds: [], components: [], files: [] });
  const settings = getSettings(interaction.guildId);
  const buf = await renderBoxOffice(video, userFrom(interaction));
  const file = new AttachmentBuilder(buf, { name: 'boxoffice.png' });

  const row = new ActionRowBuilder().addComponents(btn(`ps:ticket:${uid}`, 'Get Ticket', ButtonStyle.Success, '🎟️'));
  if (settings.privateViewingEnabled) row.addComponents(btn(`w:private:${uid}`, 'Watch Privately', ButtonStyle.Secondary, '🔒'));
  row.addComponents(btn('w:back', 'Back', ButtonStyle.Secondary));

  await interaction.update({
    content: '',
    embeds: [embedWith('boxoffice.png', '🎬 **The show is about to begin.** Step up to the box office…')],
    files: [file],
    components: [row],
  });
}

// Step 2 — Ticket (avatar + seat + ticket no).
export async function showTicket(interaction, uid) {
  const video = library.findVideo(uid);
  const user = userFrom(interaction);
  const seat = assignSeat(user.id);
  const buf = await renderTicket(user, video, { seat, ticketNo: ticketNumber(user.id, uid) });
  const file = new AttachmentBuilder(buf, { name: 'ticket.png' });
  const row = new ActionRowBuilder().addComponents(btn(`ps:popcorn:${uid}`, 'Grab Popcorn', ButtonStyle.Success, '🍿'));
  await interaction.update({
    embeds: [embedWith('ticket.png', `🎟️ **Ticket printed!** Your seat: **${seat}**. Now hit the concession stand.`)],
    files: [file],
    components: [row],
  });
}

// Step 3 — Concessions (random snack reward = the mini-game beat).
export async function showPopcorn(interaction, uid) {
  const user = userFrom(interaction);
  const snack = SNACKS[Math.floor(Math.random() * SNACKS.length)];
  const buf = await renderConcession(user, { snack });
  const file = new AttachmentBuilder(buf, { name: 'popcorn.png' });
  const row = new ActionRowBuilder().addComponents(btn(`ps:seat:${uid}`, 'Take Your Seat', ButtonStyle.Success, '🪑'));
  await interaction.update({
    embeds: [embedWith('popcorn.png', `🍿 You got **${snack}**! Snacks in hand — go find your seat.`)],
    files: [file],
    components: [row],
  });
}

// Step 4 — Seated & ready → launch the Activity.
export async function showSeated(interaction, uid) {
  const video = library.findVideo(uid);
  const user = userFrom(interaction);
  const seat = assignSeat(user.id);
  const buf = await renderSeated(user, video, { seat });
  const file = new AttachmentBuilder(buf, { name: 'seated.png' });
  const settings = getSettings(interaction.guildId);

  const row = new ActionRowBuilder();
  if (settings.clanMovieEnabled) row.addComponents(btn(`ps:enter:${uid}`, 'Enter Theater', ButtonStyle.Success, '🎬'));
  if (settings.privateViewingEnabled) row.addComponents(btn(`w:private:${uid}`, 'Watch Privately', ButtonStyle.Secondary, '🔒'));
  if (row.components.length === 0) row.addComponents(btn('w:back', 'Back'));

  await interaction.update({
    embeds: [embedWith('seated.png', `🪑 **You're seated!** Lights dimming… press **Enter Theater** to open the screen in your voice channel.`)],
    files: [file],
    components: [row],
  });
}

// "Enter Theater" — start the clan movie (if permitted & not already running)
// and hand back the Activity launch link.
export async function enterTheater(interaction, uid) {
  const member = interaction.member;
  const voice = member.voice?.channel;
  if (!voice) {
    return interaction.reply({ content: '🔊 Join a voice channel first, then press Enter Theater.', ephemeral: true });
  }
  const video = library.findVideo(uid);
  if (!video) return interaction.reply({ content: 'That video is unavailable.', ephemeral: true });

  await interaction.deferReply({ ephemeral: true });
  const room = sessions.getRoom(voice.id);
  const alreadyPlaying = room.mode === 'clan' && room.playback.videoUid === uid;

  if (!alreadyPlaying) {
    if (!canHost(member) && !canManage(member)) {
      return interaction.editReply(
        '⏳ The movie hasn’t been started yet and you’re not a host. Ask a host to start it, then press Enter Theater to join.'
      );
    }
    const playback = await getPlaybackUrls(video);
    sessions.startClanMovie(voice.id, { hostId: member.id, guildId: interaction.guildId, video, playback });
    await publishPanel(interaction.channel, voice.id, await createActivityInvite(voice));
  }

  const activityUrl = await createActivityInvite(voice);
  await interaction.editReply(
    activityUrl
      ? `🎬 **Enjoy the show!** Open the Theater in <#${voice.id}>:\n${activityUrl}`
      : '⚠️ Couldn’t create the Theater link — the bot needs **Create Instant Invite** permission here.'
  );
}
