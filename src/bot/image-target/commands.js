import {
  AttachmentBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { log } from '../../logger.js';
import { hasDatabaseUrl } from '../../db/postgres.js';
import { canManage } from '../permissions.js';
import {
  buildHubPayload,
  saveTargetFromAttachment,
} from './hub.js';

/**
 * /image-target and /imagetrack — open the Image Target Hub.
 * Optional attachment: add a target in one shot (and auto-watch this channel).
 */

function buildCommand(name, description) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .setDMPermission(false)
    .addAttachmentOption((o) =>
      o
        .setName('image')
        .setDescription('Optional: add this image as a target right away')
        .setRequired(false),
    )
    .addStringOption((o) =>
      o
        .setName('name')
        .setDescription('Optional name for the attached image')
        .setRequired(false),
    );
}

export const imageTargetCommand = buildCommand(
  'image-target',
  'Open the Image Target Hub — add images, watch channels, pick actions.',
);

export const imageTrackCommand = buildCommand(
  'imagetrack',
  'Alias for /image-target — image match hub.',
);

export async function handleImageTargetCommand(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'Server only.', ephemeral: true });
  }
  if (!canManage(interaction.member)) {
    return interaction.reply({
      content: '❌ You need **Manage Server** (or a manager role) to use this.',
      ephemeral: true,
    });
  }

  if (!hasDatabaseUrl() && process.env.IMAGE_TARGET_MEMORY !== '1') {
    return interaction.reply({
      content:
        '❌ Postgres is not configured. On Railway, set `DATABASE_URL=${{Postgres.DATABASE_URL}}` ' +
        'on this service, then redeploy. (Only warned when it is actually missing.)',
      ephemeral: true,
    });
  }

  const attachment = interaction.options.getAttachment('image');
  const name = interaction.options.getString('name');

  try {
    await interaction.deferReply({ ephemeral: true });

    if (attachment) {
      const { target, watched, jina } = await saveTargetFromAttachment(
        interaction.guildId,
        attachment,
        {
          name,
          userId: interaction.user.id,
          autoWatchChannelId: interaction.channelId,
        },
      );

      const hub = await buildHubPayload(interaction.guild);
      const note = [
        `✅ Target **${target.name}** saved.`,
        jina ? 'Jina embedding stored.' : 'Local pHash only (set `JINA_API_KEY` for stronger matching).',
        watched
          ? `Auto-watching ${interaction.channel} so matches here are caught.`
          : `${interaction.channel} was already watched.`,
        'Default action: **Delete + warn**. Change it in the hub if you want.',
      ].join('\n');

      // Put the note on the first embed description prefix
      hub.embeds[0].setDescription(`${note}\n\n${hub.embeds[0].data.description || ''}`);
      return interaction.editReply(hub);
    }

    return interaction.editReply(await buildHubPayload(interaction.guild));
  } catch (err) {
    log.error('[image-target] command error:', err);
    const msg = { content: `⚠️ ${err.message || 'Something went wrong.'}` };
    if (interaction.deferred || interaction.replied) return interaction.editReply(msg);
    return interaction.reply({ ...msg, ephemeral: true });
  }
}
