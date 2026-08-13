import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
} from 'discord.js';
import { getSettings, setSettings, toggleSetting } from '../../services/settings-store.js';
import * as library from '../../services/library-store.js';
import { COLORS, formatDuration } from './format.js';

// ============================================================================
//  /theater-settings — per-guild configuration. EVERY server has its own.
//  Rendered as one editable message: toggle buttons + role pickers + a movie
//  picker. Guarded by ManageGuild (set on the command) and re-checked here.
// ============================================================================

const onOff = (b) => (b ? '🟢 ON' : '🔴 OFF');

const TOGGLES = [
  ['homeTheaterEnabled', 'Home Theater'],
  ['privateViewingEnabled', 'Private Viewing'],
  ['clanMovieEnabled', 'Clan Movie Night'],
  ['publicViewingEnabled', 'Public Viewing'],
  ['allowSocialInteractions', 'Social Interactions'],
  ['showAvatars', 'Show Avatars'],
];

function render(guildId) {
  const s = getSettings(guildId);
  const currentMovie = s.currentClanMovieUid ? library.findVideo(s.currentClanMovieUid) : null;

  const embed = new EmbedBuilder()
    .setColor(COLORS.gold)
    .setTitle('⚙️ Home Theater Settings')
    .setDescription('Settings apply to **this server only**. Toggle with the buttons below.')
    .addFields(
      { name: 'Home Theater', value: onOff(s.homeTheaterEnabled), inline: true },
      { name: 'Private Viewing', value: onOff(s.privateViewingEnabled), inline: true },
      { name: 'Clan Movie Night', value: onOff(s.clanMovieEnabled), inline: true },
      { name: 'Public Viewing', value: onOff(s.publicViewingEnabled), inline: true },
      { name: 'Social Interactions', value: onOff(s.allowSocialInteractions), inline: true },
      { name: 'Show Avatars', value: onOff(s.showAvatars), inline: true },
      { name: 'Max Viewers', value: String(s.maxViewers), inline: true },
      { name: 'Host Role', value: s.hostRoleId ? `<@&${s.hostRoleId}>` : 'Owner + Admins', inline: true },
      { name: 'Manager Role', value: s.managerRoleId ? `<@&${s.managerRoleId}>` : 'Owner + Admins', inline: true },
      {
        name: 'Current Clan Movie',
        value: currentMovie ? `🎬 ${currentMovie.name} (${formatDuration(currentMovie.durationSeconds)})` : '—',
      }
    );

  // Row 1 + 2: toggle buttons (max 5 per row).
  const toggleButtons = TOGGLES.map(([key, label]) => {
    const on = getSettings(guildId)[key];
    return new ButtonBuilder()
      .setCustomId(`set:toggle:${key}`)
      .setLabel(label)
      .setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary);
  });
  const row1 = new ActionRowBuilder().addComponents(toggleButtons.slice(0, 5));
  const row2 = new ActionRowBuilder().addComponents(
    ...toggleButtons.slice(5),
    new ButtonBuilder().setCustomId('set:max:dec').setLabel('Max −10').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('set:max:inc').setLabel('Max +10').setStyle(ButtonStyle.Secondary)
  );

  // Row 3 + 4: role pickers.
  const row3 = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId('set:role:host').setPlaceholder('Theater Host role (optional)').setMinValues(0).setMaxValues(1)
  );
  const row4 = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder().setCustomId('set:role:manager').setPlaceholder('Theater Manager role (optional)').setMinValues(0).setMaxValues(1)
  );

  // Row 5: current clan movie picker.
  const movieOptions = library
    .getCachedLibrary()
    .slice(0, 25)
    .map((v) => ({
      label: v.name.slice(0, 100),
      description: `${formatDuration(v.durationSeconds)} • ${v.category}`.slice(0, 100),
      value: v.uid,
      default: v.uid === s.currentClanMovieUid,
    }));
  const row5 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('set:movie')
      .setPlaceholder('Set the current clan movie…')
      .addOptions(movieOptions.length ? movieOptions : [{ label: 'Library empty — run /library sync', value: 'none' }])
      .setDisabled(movieOptions.length === 0)
  );

  return { embeds: [embed], components: [row1, row2, row3, row4, row5] };
}

export async function handleSettingsCommand(interaction) {
  await interaction.reply({ ...render(interaction.guildId), ephemeral: true });
}

// Route a settings component interaction (customId starts with "set:").
export async function handleSettingsComponent(interaction) {
  const guildId = interaction.guildId;
  const id = interaction.customId;

  if (id.startsWith('set:toggle:')) {
    toggleSetting(guildId, id.split(':')[2]);
  } else if (id === 'set:max:dec') {
    const s = getSettings(guildId);
    setSettings(guildId, { maxViewers: Math.max(1, s.maxViewers - 10) });
  } else if (id === 'set:max:inc') {
    const s = getSettings(guildId);
    setSettings(guildId, { maxViewers: s.maxViewers + 10 });
  } else if (id === 'set:role:host') {
    setSettings(guildId, { hostRoleId: interaction.values?.[0] || null });
  } else if (id === 'set:role:manager') {
    setSettings(guildId, { managerRoleId: interaction.values?.[0] || null });
  } else if (id === 'set:movie') {
    const uid = interaction.values?.[0];
    if (uid && uid !== 'none') setSettings(guildId, { currentClanMovieUid: uid });
  }

  await interaction.update(render(guildId));
}
