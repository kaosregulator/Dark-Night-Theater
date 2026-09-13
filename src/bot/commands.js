import {
  SlashCommandBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import {
  imageTargetCommand,
  imageTrackCommand,
} from './image-target/index.js';

// Slash command definitions (data only). Registered by register-commands.js and
// handled in handlers/. Kept in one place so both share a single source.

export const commands = [
  new SlashCommandBuilder()
    .setName('host')
    .setDescription('Host a movie — open the upload page, then return to the Activity (primary command).'),

  new SlashCommandBuilder()
    .setName('watch')
    .setDescription('Browse the library (optional). Prefer /host + the Activity menu for parties.')
    .addStringOption((o) =>
      o.setName('search').setDescription('Filter by title, description or category').setRequired(false)
    )
    .addStringOption((o) =>
      o.setName('category').setDescription('Filter by category').setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('join')
    .setDescription('List parties (optional). Prefer Activity menu → Join / Enter Room Code.'),

  new SlashCommandBuilder()
    .setName('theater')
    .setDescription('Post live controls for the current voice-channel party (optional).'),

  new SlashCommandBuilder()
    .setName('library')
    .setDescription('Manage the local movie library (staff only).')
    .addSubcommand((s) => s.setName('sync').setDescription('Re-scan the media folder for new/removed videos'))
    .addSubcommand((s) => s.setName('status').setDescription('Show library counts and where to add movies'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString()),

  new SlashCommandBuilder()
    .setName('theater-settings')
    .setDescription('Configure Home Theater for THIS server (admins only).')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString()),

  // Ported from DN-cards — interactive dashboard; options live in the panel.
  new SlashCommandBuilder()
    .setName('emoji')
    .setDescription('Make an animated emoji from any avatar, image, or server icon')
    .setDMPermission(false),

  // Image-target watcher (pHash + optional Jina CLIP). Builders already have
  // ManageGuild permission + subcommands.
  imageTargetCommand,
  imageTrackCommand,
].map((c) => (typeof c.toJSON === 'function' ? c.toJSON() : c));
