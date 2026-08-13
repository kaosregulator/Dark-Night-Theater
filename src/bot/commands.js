import {
  SlashCommandBuilder,
  PermissionFlagsBits,
} from 'discord.js';

// Slash command definitions (data only). Registered by register-commands.js and
// handled in handlers/. Kept in one place so both share a single source.

export const commands = [
  new SlashCommandBuilder()
    .setName('watch')
    .setDescription('Browse the DarkNight library and start a watch party or private viewing.')
    .addStringOption((o) =>
      o.setName('search').setDescription('Filter by title, description or category').setRequired(false)
    )
    .addStringOption((o) =>
      o.setName('category').setDescription('Filter by category').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('theater')
    .setDescription('Open the Home Theater in your current voice channel and post live controls.'),

  new SlashCommandBuilder()
    .setName('library')
    .setDescription('Manage the Cloudflare Stream video library (staff only).')
    .addSubcommand((s) => s.setName('sync').setDescription('Re-pull the full library from Cloudflare Stream'))
    .addSubcommand((s) => s.setName('status').setDescription('Show library sync status and counts'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString()),

  new SlashCommandBuilder()
    .setName('theater-settings')
    .setDescription('Configure Home Theater for THIS server (admins only).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString()),
].map((c) => c.toJSON());
