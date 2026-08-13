import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import * as library from '../../services/library-store.js';
import * as sessions from '../../services/sessions.js';
import { getSettings } from '../../services/settings-store.js';
import { getPlaybackUrls } from '../../cloudflare/stream.js';
import { canHost, canManage } from '../permissions.js';
import { createActivityInvite, publishPanel } from './theater.js';
import { COLORS } from './format.js';
import { log } from '../../logger.js';
import { assignSeat, ticketNumber } from '../canvas/cards.js';
import { animCurtain, animTicket, animPopcorn, animSeated } from '../canvas/anim.js';

// ============================================================================
//  In-Discord gamified PRE-SHOW.
//
//  Visibility model (by request):
//    • the /watch MENU stays EPHEMERAL (private to the user)
//    • the PRE-SHOW is ONE PUBLIC message everyone in the channel can see —
//      it evolves Box Office → 🎟 Ticket → 🍿 Popcorn → 🪑 Seat, then VANISHES
//      when the user enters the theater (or after a short idle timeout).
//    • only the user who started it can press the buttons; anyone else who
//      taps gets nudged to run /watch and start their own — that's the hook.
// ============================================================================

const IDLE_MS = 120_000; // auto-remove an abandoned pre-show after 2 min
const timers = new Map(); // messageId -> timeout
const SNACKS = ['a LARGE Popcorn', 'Nachos & Cheese', 'Movie Candy', 'an Ice-Cold Soda', 'a Combo Deal', 'Extra-Butter Popcorn'];

function userFrom(interaction) {
  return {
    id: interaction.user.id,
    name: interaction.member?.displayName || interaction.user.globalName || interaction.user.username,
    avatar: interaction.user.displayAvatarURL({ extension: 'png', size: 128 }),
  };
}
function embedImg(name, description) {
  return new EmbedBuilder().setColor(COLORS.gold).setImage(`attachment://${name}`).setDescription(description);
}
function btn(id, label, style = ButtonStyle.Secondary, emoji) {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  if (emoji) b.setEmoji(emoji);
  return b;
}
function arm(message) {
  clearTimeout(timers.get(message.id));
  timers.set(
    message.id,
    setTimeout(() => {
      timers.delete(message.id);
      message.delete().catch(() => {});
    }, IDLE_MS)
  );
}
function disarmDelete(message) {
  clearTimeout(timers.get(message.id));
  timers.delete(message.id);
  message.delete().catch(() => {});
}

// Route every ps:* button here. custom_id = ps:<step>:<uid>[:<ownerId>]
export async function handlePreshow(interaction) {
  const [, step, uid, ownerId] = interaction.customId.split(':');
  // Steps after "box" carry the owner id and are gated to that user.
  if (ownerId && interaction.user.id !== ownerId) {
    return interaction.reply({
      content: `🍿 This is <@${ownerId}>'s pre-show. Run \`/watch\` to grab **your own** ticket and popcorn!`,
      ephemeral: true,
    });
  }
  switch (step) {
    case 'box':
      return startPublicPreshow(interaction, uid);
    case 'ticket':
      return advance(interaction, uid, ownerId, 'ticket');
    case 'popcorn':
      return advance(interaction, uid, ownerId, 'popcorn');
    case 'seat':
      return advance(interaction, uid, ownerId, 'seat');
    case 'enter':
      return enterTheater(interaction, uid);
    case 'private':
      return watchPrivate(interaction, uid);
    default:
      return;
  }
}

// From the ephemeral menu: collapse the private menu and post the PUBLIC
// pre-show that the whole channel can watch.
async function startPublicPreshow(interaction, uid) {
  const owner = userFrom(interaction);
  const video = library.findVideo(uid);
  if (!video) return interaction.update({ content: 'That video is unavailable.', embeds: [], components: [], files: [] });

  // Ack the (ephemeral) menu click first — GIF encoding takes ~1s.
  await interaction.deferUpdate();
  const buf = await animCurtain(video, owner);
  const file = new AttachmentBuilder(buf, { name: 'preshow.gif' });
  const row = new ActionRowBuilder().addComponents(
    btn(`ps:ticket:${uid}:${owner.id}`, 'Get Ticket', ButtonStyle.Success, '🎟️')
  );
  const settings = getSettings(interaction.guildId);
  if (settings.privateViewingEnabled) row.addComponents(btn(`ps:private:${uid}:${owner.id}`, 'Watch Privately', ButtonStyle.Secondary, '🔒'));

  try {
    const message = await interaction.channel.send({
      content: `🎟️ **${owner.name}** stepped up to the Box Office…`,
      embeds: [embedImg('preshow.gif', '🎬 The show is about to begin — grab a ticket and some popcorn!')],
      files: [file],
      components: [row],
    });
    arm(message);
  } catch (err) {
    log.warn('preshow public post failed:', err.message);
    return interaction.editReply({
      content: '⚠️ I couldn’t post the pre-show here (need **Send Messages / Embed Links / Attach Files**).',
      embeds: [],
      components: [],
    });
  }

  await interaction.editReply({
    content: '🎬 Lights up — your pre-show is playing in the channel below. Only **you** can run it. 🍿',
    embeds: [],
    components: [],
  });
}

// Edit the SAME public message forward one step.
async function advance(interaction, uid, ownerId, to) {
  const owner = userFrom(interaction); // gated: presser is the owner
  const video = library.findVideo(uid);
  const seat = assignSeat(owner.id);

  // Ack first — GIF encoding takes ~1s; the public message holds the prior step
  // until we edit it below (no flicker, no 3s timeout).
  await interaction.deferUpdate();

  let buf, description, next, contentLine;
  if (to === 'ticket') {
    buf = await animTicket(owner, video, { seat, ticketNo: ticketNumber(owner.id, uid) });
    description = `🎟️ Ticket printed — seat **${seat}**. Off to the concession stand…`;
    contentLine = `🎟️ **${owner.name}** grabbed a ticket…`;
    next = btn(`ps:popcorn:${uid}:${ownerId}`, 'Grab Popcorn', ButtonStyle.Success, '🍿');
  } else if (to === 'popcorn') {
    const snack = SNACKS[Math.floor(Math.random() * SNACKS.length)];
    buf = await animPopcorn(owner, { snack });
    description = `🍿 Scored **${snack}**! One more step — find your seat.`;
    contentLine = `🍿 **${owner.name}** hit the concession stand…`;
    next = btn(`ps:seat:${uid}:${ownerId}`, 'Take Your Seat', ButtonStyle.Success, '🪑');
  } else {
    buf = await animSeated(owner, video, { seat });
    description = `🪑 Seated in **${seat}** — lights dimming. Press **Enter Theater**!`;
    contentLine = `🪑 **${owner.name}** is taking their seat…`;
    const settings = getSettings(interaction.guildId);
    next = settings.clanMovieEnabled
      ? btn(`ps:enter:${uid}:${ownerId}`, 'Enter Theater', ButtonStyle.Success, '🎬')
      : btn(`ps:private:${uid}:${ownerId}`, 'Watch Privately', ButtonStyle.Secondary, '🔒');
  }

  const file = new AttachmentBuilder(buf, { name: 'preshow.gif' });
  await interaction.editReply({
    content: contentLine,
    embeds: [embedImg('preshow.gif', description)],
    files: [file],
    components: [new ActionRowBuilder().addComponents(next)],
  });
  arm(interaction.message);
}

// Enter the theater: the public pre-show VANISHES, the movie session starts,
// and the user gets a private launch link.
async function enterTheater(interaction, uid) {
  const member = interaction.member;
  const voice = member.voice?.channel;
  await interaction.deferReply({ ephemeral: true });
  if (interaction.message) disarmDelete(interaction.message); // the pre-show disappears

  if (!voice) return interaction.editReply('🔊 Join a voice channel first, then run `/watch` again to enter.');
  const video = library.findVideo(uid);
  if (!video) return interaction.editReply('That video is unavailable.');

  const room = sessions.getRoom(voice.id);
  const alreadyPlaying = room.mode === 'clan' && room.playback.videoUid === uid;
  if (!alreadyPlaying) {
    if (!canHost(member) && !canManage(member)) {
      return interaction.editReply('⏳ No host has started this movie yet. Ask a host to start it, then join.');
    }
    const playback = await getPlaybackUrls(video);
    sessions.startClanMovie(voice.id, { hostId: member.id, guildId: interaction.guildId, video, playback });
    await publishPanel(interaction.channel, voice.id, await createActivityInvite(voice));
  }

  const activityUrl = await createActivityInvite(voice);
  await interaction.editReply(
    activityUrl
      ? `🎬 **Enjoy the show!** Open the Theater in <#${voice.id}>:\n${activityUrl}`
      : '⚠️ Couldn’t create the Theater link — the bot needs **Create Instant Invite** here.'
  );
}

// Private viewing from the pre-show: remove the public message, hand back a
// personal launch link.
async function watchPrivate(interaction, uid) {
  const settings = getSettings(interaction.guildId);
  await interaction.deferReply({ ephemeral: true });
  if (interaction.message) disarmDelete(interaction.message);
  if (!settings.privateViewingEnabled) return interaction.editReply('🚫 Private viewing is off for this server.');

  const voice = interaction.member.voice?.channel;
  if (!voice) return interaction.editReply('🔊 Join any voice channel to open the Theater, then choose Private inside.');
  const activityUrl = await createActivityInvite(voice);
  const video = library.findVideo(uid);
  await interaction.editReply(
    activityUrl
      ? `🔒 Open the Theater and pick **Private** to watch **${video?.name || 'your movie'}** solo:\n${activityUrl}`
      : '⚠️ Couldn’t create the Theater link — the bot needs **Create Instant Invite** here.'
  );
}
