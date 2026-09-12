import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
  AttachmentBuilder,
} from 'discord.js';
import * as sessions from '../../services/sessions.js';
import { createActivityInvite } from './theater.js';
import { COLORS } from './format.js';
import { renderTheaterCard, renderLobbyBoard, renderSeated } from '../canvas/cards.js';
import { animCurtain, animPopcorn, animSeated, animThrowPopcorn } from '../canvas/anim.js';

// ============================================================================
//  /join — the AUDIENCE entry point. Lists active watch parties, then runs a
//  small interactive pre-show (reusing the existing GIFs) — pick soda / popcorn
//  / snacks / seat, throw popcorn — and finally drops the viewer into the
//  EXISTING Theater Activity + synchronized playback. /watch and the hosting /
//  streaming system are not touched.
// ============================================================================

const SODAS = ['Cola', 'Lemon-Lime', 'Root Beer', 'Iced Tea', 'Water'];
const POPCORN = ['Small', 'Medium', 'Large', 'Jumbo'];
const SNACKS = ['Candy', 'Nachos', 'Pretzel', 'Chocolate', 'None'];
const SEATS = Array.from({ length: 12 }, (_, i) => ({
  index: i,
  label: `Row ${String.fromCharCode(65 + Math.floor(i / 4))} · Seat ${(i % 4) + 1}`,
}));

// Per-viewer pre-show picks (ephemeral, short-lived).
const picks = new Map(); // `${userId}:${channelId}` -> { soda, popcorn, snacks, seat }
const keyOf = (interaction, ch) => `${interaction.user.id}:${ch}`;
function state(interaction, ch) {
  const k = keyOf(interaction, ch);
  if (!picks.has(k)) picks.set(k, {});
  return picks.get(k);
}

function userFrom(interaction) {
  return {
    id: interaction.user.id,
    name: interaction.member?.displayName || interaction.user.globalName || interaction.user.username,
    avatar: interaction.user.displayAvatarURL({ extension: 'png', size: 128 }),
  };
}
// A minimal "video" object for the GIF renderers, built from the live room.
function vid(ch) {
  const room = sessions.getRoom(ch);
  return { uid: room.playback.videoUid, name: room.playback.videoName || 'the movie', category: 'Now Playing', durationSeconds: 0, thumbnail: '' };
}
function isLive(ch) {
  const room = sessions.getRoom(ch);
  return room.mode === 'clan' && Boolean(room.playback.videoUid);
}

async function resolveParty(interaction, p) {
  let hostName = 'Host';
  let channelName = '';
  try {
    const m = p.hostId ? await interaction.guild.members.fetch(p.hostId).catch(() => null) : null;
    if (m) hostName = m.displayName;
  } catch { /* ignore */ }
  try {
    const ch = await interaction.guild.channels.fetch(p.channelId).catch(() => null);
    if (ch) channelName = ch.name;
  } catch { /* ignore */ }
  return { ...p, hostName, channelName };
}

const btn = (id, label, emoji, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);

function selectRow(id, placeholder, values, current) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(id)
      .setPlaceholder(placeholder)
      .addOptions(values.map((v) => ({ label: v.label ?? v, value: String(v.value ?? v), default: String(v.value ?? v) === String(current) })))
  );
}

// Render a GIF step (ack first — encoding takes ~1s).
async function gifStep(interaction, buf, description, rows) {
  const file = new AttachmentBuilder(buf, { name: 'join.gif' });
  const embed = new EmbedBuilder().setColor(COLORS.gold).setImage('attachment://join.gif').setDescription(description);
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  await interaction.editReply({ content: '', embeds: [embed], files: [file], components: rows });
}

// ---- entry -----------------------------------------------------------------
export async function handleJoinCommand(interaction) {
  const parties = sessions.listActiveRooms(interaction.guildId);
  if (parties.length === 0) {
    return interaction.reply({
      content: '🎬 No movie parties are playing right now. A host can start one with **/host**, then friends join from the **Activity menu** (or enter the 4-letter room code).',
      ephemeral: true,
    });
  }
  const resolved = await Promise.all(parties.map((p) => resolveParty(interaction, p)));
  if (resolved.length === 1) return showTheaterCard(interaction, resolved[0], false);

  const buf = await renderLobbyBoard(resolved);
  const file = new AttachmentBuilder(buf, { name: 'board.png' });
  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setImage('attachment://board.png')
    .setDescription(`🎬 **${resolved.length} theaters** playing now — pick one to join.`);
  const select = new StringSelectMenuBuilder()
    .setCustomId('join:pick')
    .setPlaceholder('🎬 Pick a theater…')
    .addOptions(
      resolved.slice(0, 25).map((p) => ({
        label: (p.videoName || 'Movie').slice(0, 100),
                  description: `${p.roomCode ? `Code ${p.roomCode} · ` : ''}Host ${p.hostName} · ${p.viewers} watching · #${p.channelName}`.slice(0, 100),
        value: p.channelId,
      }))
    );
  await interaction.reply({ embeds: [embed], files: [file], components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
}

async function showTheaterCard(interaction, party, isUpdate) {
  const buf = await renderTheaterCard(party);
  const file = new AttachmentBuilder(buf, { name: 'theater.png' });
  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setImage('attachment://theater.png')
    .setDescription(`🎬 **${party.videoName || 'A movie'}** · hosted by ${party.hostName}\n🔊 Playing in <#${party.channelId}> — join that voice channel to watch.`);
  const row = new ActionRowBuilder().addComponents(btn(`join:theater:${party.channelId}`, 'Join Theater', '🎟️', ButtonStyle.Success));
  const payload = { embeds: [embed], files: [file], components: [row] };
  if (isUpdate) await interaction.update(payload);
  else await interaction.reply({ ...payload, ephemeral: true });
}

// ---- component dispatcher ---------------------------------------------------
export async function handleJoin(interaction) {
  const [, step, ch] = interaction.customId.split(':'); // join:<step>:<channelId>
  if (step === 'pick') {
    const channelId = interaction.values?.[0];
    const p = sessions.listActiveRooms(interaction.guildId).find((x) => x.channelId === channelId);
    if (!p) return interaction.update({ content: '🎬 That theater has closed.', embeds: [], files: [], components: [] });
    return showTheaterCard(interaction, await resolveParty(interaction, p), true);
  }

  // Everything past here targets a specific channel/party.
  if (ch && !isLive(ch) && step !== 'watch') {
    return interaction.update({ content: '🎬 This theater has closed.', embeds: [], files: [], components: [] });
  }

  switch (step) {
    case 'theater': return arrival(interaction, ch);
    case 'concessions': return concessions(interaction, ch);
    case 'soda':
    case 'popcorn':
    case 'snacks': {
      state(interaction, ch)[step] = interaction.values?.[0];
      return interaction.deferUpdate();
    }
    case 'seatstep': return seatStep(interaction, ch);
    case 'seat': {
      state(interaction, ch).seat = Number(interaction.values?.[0]);
      return interaction.deferUpdate();
    }
    case 'seated': return seated(interaction, ch);
    case 'throw': return throwPopcorn(interaction, ch);
    case 'watch': return watchMovie(interaction, ch);
    default: return;
  }
}

// Step: arrival — curtains part on the movie.
async function arrival(interaction, ch) {
  const buf = await animCurtain(vid(ch), userFrom(interaction));
  await gifStep(interaction, buf, `🎬 Welcome to **${vid(ch).name}**! Grab your concessions before you take a seat.`, [
    new ActionRowBuilder().addComponents(btn(`join:concessions:${ch}`, 'Get Concessions', '🍿', ButtonStyle.Success)),
  ]);
}

// Step: concessions — pick soda / popcorn size / snacks.
async function concessions(interaction, ch) {
  const st = state(interaction, ch);
  const buf = await animPopcorn(userFrom(interaction), { snack: 'the Concession Stand' });
  await gifStep(interaction, buf, 'Pick your 🥤 soda, 🍿 popcorn size and 🍫 snack — then **Continue**.', [
    selectRow(`join:soda:${ch}`, '🥤 Choose a soda…', SODAS, st.soda),
    selectRow(`join:popcorn:${ch}`, '🍿 Popcorn size…', POPCORN, st.popcorn),
    selectRow(`join:snacks:${ch}`, '🍫 Choose a snack…', SNACKS, st.snacks),
    new ActionRowBuilder().addComponents(btn(`join:seatstep:${ch}`, 'Continue', '🎟️', ButtonStyle.Success)),
  ]);
}

// Step: choose a seat.
async function seatStep(interaction, ch) {
  const st = state(interaction, ch);
  const buf = await animSeated(userFrom(interaction), vid(ch), { seat: 'your pick' });
  await gifStep(interaction, buf, '🪑 Choose your seat, then **Take your seat**.', [
    selectRow(`join:seat:${ch}`, '🪑 Choose a seat…', SEATS.map((s) => ({ label: s.label, value: s.index })), st.seat),
    new ActionRowBuilder().addComponents(btn(`join:seated:${ch}`, 'Take your seat', '🪑', ButtonStyle.Success)),
  ]);
}

function orderLine(st) {
  const seat = st.seat != null ? SEATS[st.seat]?.label : 'Row A · Seat 1';
  return `🥤 ${st.soda || '—'}   ·   🍿 ${st.popcorn || '—'}   ·   🍫 ${st.snacks || 'None'}   ·   🪑 ${seat}`;
}

// Step: seated — interactive (throw popcorn) + watch movie.
async function seated(interaction, ch) {
  const st = state(interaction, ch);
  const seatLabel = st.seat != null ? SEATS[st.seat]?.label : 'Row A · Seat 1';
  const buf = await renderSeated(userFrom(interaction), vid(ch), { seat: seatLabel });
  const file = new AttachmentBuilder(buf, { name: 'join.png' });
  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setImage('attachment://join.png')
    .setDescription(`🍿 You're seated for **${vid(ch).name}**!\n${orderLine(st)}\n\nThrow some popcorn, then start the movie.`);
  const rows = [
    new ActionRowBuilder().addComponents(
      btn(`join:throw:${ch}`, 'Throw Popcorn', '🍿', ButtonStyle.Secondary),
      btn(`join:watch:${ch}`, 'Watch Movie', '🎬', ButtonStyle.Success)
    ),
  ];
  if (!interaction.deferred && !interaction.replied) await interaction.deferUpdate();
  await interaction.editReply({ content: '', embeds: [embed], files: [file], components: rows });
}

// Step: throw popcorn animation (repeatable).
async function throwPopcorn(interaction, ch) {
  const buf = await animThrowPopcorn(userFrom(interaction), vid(ch));
  await gifStep(interaction, buf, '🍿 Popcorn away! Throw again, or start the movie.', [
    new ActionRowBuilder().addComponents(
      btn(`join:throw:${ch}`, 'Throw Popcorn', '🍿', ButtonStyle.Secondary),
      btn(`join:watch:${ch}`, 'Watch Movie', '🎬', ButtonStyle.Success)
    ),
  ]);
}

// Step: enter the existing Theater Activity + synced playback.
async function watchMovie(interaction, ch) {
  if (!isLive(ch)) {
    return interaction.reply({ content: '🎬 This theater has closed.', ephemeral: true });
  }
  const member = interaction.member;
  if (member.voice?.channelId !== ch) {
    return interaction.reply({
      content: `🔊 Join the voice channel <#${ch}> first, then press **Watch Movie**.`,
      ephemeral: true,
    });
  }
  await interaction.deferReply({ ephemeral: true });
  const st = state(interaction, ch);
  if (st.seat != null) sessions.setPreferredSeat(ch, member.id, st.seat); // carry the chosen seat into the Activity
  const voice = await interaction.client.channels.fetch(ch).catch(() => null);
  const url = voice ? await createActivityInvite(voice) : null;
  picks.delete(keyOf(interaction, ch));
  await interaction.editReply(
    url
      ? `🎬 **Enjoy the show!** Open the Theater in <#${ch}>:\n${url}\n\n_You'll arrive outside — press **Enter Theater** to grab a seat and sync to the movie._`
      : '⚠️ Couldn’t create the Theater link — the bot needs **Create Instant Invite** in that channel.'
  );
}
