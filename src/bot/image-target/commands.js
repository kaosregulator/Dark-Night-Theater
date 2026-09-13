import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { log } from '../../logger.js';
import { canManage } from '../permissions.js';
import { pct } from './actions.js';
import { ACTIONS, DEFAULT_SIMILARITY_THRESHOLD } from './constants.js';
import {
  analyzeTargetBuffer,
  testAgainstTargets,
} from './detector.js';
import {
  downloadBytes,
  loadMediaAsImage,
  looksLikeImage,
  looksLikeVideo,
} from './download.js';
import {
  addChannel,
  addTarget,
  findTargetByName,
  getGuildConfig,
  getTarget,
  listTargets,
  patchGuildConfig,
  removeChannel,
  removeTarget,
  updateTarget,
} from './store.js';

/** /image-target and /imagetrack — admin commands for the image watcher. */

function buildCommand(name, description) {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild.toString())
    .setDMPermission(false)
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Upload an image/GIF/video frame to watch for')
        .addAttachmentOption((o) =>
          o.setName('media').setDescription('Image, GIF, or video to watch').setRequired(true),
        )
        .addStringOption((o) =>
          o.setName('name').setDescription('Friendly name for this target').setRequired(false),
        ),
    )
    .addSubcommand((s) =>
      s.setName('list').setDescription('List watched target images for this server'),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Remove a target by name or ID')
        .addStringOption((o) =>
          o.setName('target').setDescription('Target name or ID').setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('enable')
        .setDescription('Enable a target')
        .addStringOption((o) =>
          o.setName('target').setDescription('Target name or ID').setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('disable')
        .setDescription('Disable a target without deleting it')
        .addStringOption((o) =>
          o.setName('target').setDescription('Target name or ID').setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('test')
        .setDescription('Test an image against targets (no delete / no punish)')
        .addAttachmentOption((o) =>
          o.setName('media').setDescription('Image to test').setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('channel')
        .setDescription('Add, remove, or list watched channels')
        .addStringOption((o) =>
          o
            .setName('action')
            .setDescription('What to do')
            .setRequired(true)
            .addChoices(
              { name: 'add', value: 'add' },
              { name: 'remove', value: 'remove' },
              { name: 'list', value: 'list' },
            ),
        )
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Channel (required for add/remove)').setRequired(false),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('threshold')
        .setDescription('Set cosine-similarity match threshold (0.50–0.99)')
        .addNumberOption((o) =>
          o
            .setName('value')
            .setDescription('e.g. 0.90 — cosine similarity after L2-normalization')
            .setRequired(true)
            .setMinValue(0.5)
            .setMaxValue(0.99),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('action')
        .setDescription('Set what happens when a target matches')
        .addStringOption((o) =>
          o
            .setName('mode')
            .setDescription('Moderation action')
            .setRequired(true)
            .addChoices(
              { name: 'Log only', value: 'log' },
              { name: 'Delete + log (default)', value: 'delete_log' },
              { name: 'Delete + warn', value: 'delete_warn' },
              { name: 'Delete + timeout', value: 'delete_timeout' },
              { name: 'Delete + kick', value: 'delete_kick' },
              { name: 'Delete + ban', value: 'delete_ban' },
            ),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('log-channel')
        .setDescription('Channel where detections are posted')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Log channel (omit to clear)').setRequired(false),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('escalation')
        .setDescription('Toggle strike escalation (warn → timeout → kick → ban)')
        .addBooleanOption((o) =>
          o.setName('enabled').setDescription('Enable escalation').setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s.setName('status').setDescription('Show image-target watcher status for this server'),
    );
}

export const imageTargetCommand = buildCommand(
  'image-target',
  'Watch for target images (pHash + Jina CLIP). Admin only.',
);

export const imageTrackCommand = buildCommand(
  'imagetrack',
  'Alias for /image-target — watch for target images. Admin only.',
);

function resolveTarget(guildId, query) {
  return getTarget(guildId, query) || findTargetByName(guildId, query);
}

async function bufferFromAttachment(attachment) {
  const meta = {
    contentType: attachment.contentType || '',
    filename: attachment.name || '',
    url: attachment.url,
  };
  if (!looksLikeImage(meta) && !looksLikeVideo(meta)) {
    throw new Error('Please attach an image, GIF, or video.');
  }
  if (attachment.size && attachment.size > 8 * 1024 * 1024) {
    throw new Error('File is too large (max 8 MB).');
  }
  const downloaded = await downloadBytes(attachment.url);
  const buffer = Buffer.isBuffer(downloaded) ? downloaded : downloaded.buffer;
  const contentType = downloaded.contentType || attachment.contentType || '';
  const loaded = await loadMediaAsImage(buffer, {
    contentType,
    filename: attachment.name,
    url: attachment.url,
  });
  if (Buffer.isBuffer(loaded)) {
    return { buffer: loaded, mediaKind: looksLikeVideo(meta) ? 'video' : 'image' };
  }
  return {
    buffer: loaded.buffer,
    mediaKind: loaded.mediaKind || (looksLikeVideo(meta) ? 'video' : 'image'),
  };
}

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

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  try {
    switch (sub) {
      case 'add':
        return await cmdAdd(interaction, guildId);
      case 'list':
        return await cmdList(interaction, guildId);
      case 'remove':
        return await cmdRemove(interaction, guildId);
      case 'enable':
      case 'disable':
        return await cmdToggle(interaction, guildId, sub === 'enable');
      case 'test':
        return await cmdTest(interaction, guildId);
      case 'channel':
        return await cmdChannel(interaction, guildId);
      case 'threshold':
        return await cmdThreshold(interaction, guildId);
      case 'action':
        return await cmdAction(interaction, guildId);
      case 'log-channel':
        return await cmdLogChannel(interaction, guildId);
      case 'escalation':
        return await cmdEscalation(interaction, guildId);
      case 'status':
        return await cmdStatus(interaction, guildId);
      default:
        return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
    }
  } catch (err) {
    log.error('[image-target] command error:', err);
    const msg = { content: `⚠️ ${err.message || 'Something went wrong.'}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) return interaction.followUp(msg);
    return interaction.reply(msg);
  }
}

async function cmdAdd(interaction, guildId) {
  await interaction.deferReply({ ephemeral: true });
  const attachment = interaction.options.getAttachment('media', true);
  const name =
    interaction.options.getString('name') ||
    (attachment.name || 'target').replace(/\.[^.]+$/, '').slice(0, 64);

  const { buffer, mediaKind } = await bufferFromAttachment(attachment);
  const analyzed = await analyzeTargetBuffer(buffer, { withEmbedding: true });

  const target = addTarget(guildId, {
    name,
    perceptualHash: analyzed.dHash,
    blockHash: analyzed.blockHash,
    embedding: analyzed.embedding,
    embeddingModel: analyzed.embeddingModel,
    contentHash: analyzed.contentHash,
    mimeType: attachment.contentType || analyzed.format || null,
    createdBy: interaction.user.id,
    mediaKind,
  });

  const jinaNote = analyzed.embedding
    ? 'Jina embedding stored.'
    : 'Jina unavailable — local pHash only (set `JINA_API_KEY` for stronger matching).';

  return interaction.editReply({
    content:
      `✅ Target **${target.name}** saved.\n` +
      '\`\`\`\n' +
      `id: ${target.targetId}\n` +
      `dHash: ${analyzed.dHash}\n` +
      `block: ${String(analyzed.blockHash).slice(0, 16)}…\n` +
      '\`\`\`\n' +
      `${jinaNote}\n` +
      'Use `/image-target channel` to choose where to watch.',
  });
}

async function cmdList(interaction, guildId) {
  const targets = listTargets(guildId);
  if (!targets.length) {
    return interaction.reply({
      content: 'No image targets yet. Use `/image-target add`.',
      ephemeral: true,
    });
  }
  const lines = targets.map((t, i) => {
    const flag = t.enabled ? '🟢' : '🔴';
    const emb = t.embedding?.length ? '· AI' : '· pHash';
    return `${flag} **#${i + 1}** — ${t.name} \`${String(t.targetId).slice(0, 8)}\` ${emb}`;
  });
  const embed = new EmbedBuilder()
    .setColor(0xc9a227)
    .setTitle('🖼️ Image Targets')
    .setDescription(lines.join('\n').slice(0, 4000));
  return interaction.reply({ embeds: [embed], ephemeral: true });
}

async function cmdRemove(interaction, guildId) {
  const q = interaction.options.getString('target', true);
  const t = resolveTarget(guildId, q);
  if (!t) {
    return interaction.reply({ content: 'Target not found.', ephemeral: true });
  }
  removeTarget(guildId, t.targetId);
  return interaction.reply({
    content: `🗑️ Removed target **${t.name}**.`,
    ephemeral: true,
  });
}

async function cmdToggle(interaction, guildId, enabled) {
  const q = interaction.options.getString('target', true);
  const t = resolveTarget(guildId, q);
  if (!t) {
    return interaction.reply({ content: 'Target not found.', ephemeral: true });
  }
  updateTarget(guildId, t.targetId, { enabled });
  return interaction.reply({
    content: `${enabled ? '🟢 Enabled' : '🔴 Disabled'} **${t.name}**.`,
    ephemeral: true,
  });
}

async function cmdTest(interaction, guildId) {
  await interaction.deferReply({ ephemeral: true });
  const attachment = interaction.options.getAttachment('media', true);
  const { buffer } = await bufferFromAttachment(attachment);
  const result = await testAgainstTargets(guildId, buffer);

  if (!result.results?.length) {
    return interaction.editReply({ content: result.message || 'No targets to test against.' });
  }

  const top = result.results[0];
  const score = top.finalScore ?? 0;
  const embed = new EmbedBuilder()
    .setColor(result.match ? 0xe74c3c : 0x3bd275)
    .setTitle('🔍 Image Target Test')
    .setDescription(
      result.results
        .slice(0, 5)
        .map((r) => {
          const mark = r.matched ? '🚨' : '·';
          return `${mark} ${r.target.name}: ${pct(r.finalScore ?? 0)} (${r.method || '—'})`;
        })
        .join('\n'),
    )
    .addFields(
      { name: 'Top target', value: top?.target?.name || '—', inline: true },
      { name: 'Similarity', value: `**${pct(score)}**`, inline: true },
      { name: 'Method', value: top?.method || '—', inline: true },
      {
        name: 'Result',
        value: result.match ? '🚨 **MATCH**' : '✅ No match',
        inline: false,
      },
      {
        name: 'Jina',
        value: result.jinaAvailable
          ? 'available'
          : result.jinaError
            ? `error: ${result.jinaError}`
            : 'not configured (local pHash only)',
        inline: false,
      },
    );

  return interaction.editReply({ embeds: [embed] });
}

async function cmdChannel(interaction, guildId) {
  const action = interaction.options.getString('action', true);
  const channel = interaction.options.getChannel('channel');
  const cfg = getGuildConfig(guildId);

  if (action === 'list') {
    const list = cfg.channels.length
      ? cfg.channels.map((id) => `<#${id}>`).join(', ')
      : '_none — watcher idle until you add a channel_';
    return interaction.reply({ content: `Watched channels: ${list}`, ephemeral: true });
  }

  if (!channel) {
    return interaction.reply({
      content: 'Please provide a `channel` for add/remove.',
      ephemeral: true,
    });
  }

  if (action === 'remove') {
    removeChannel(guildId, channel.id);
    return interaction.reply({
      content: `Stopped watching ${channel}.`,
      ephemeral: true,
    });
  }

  addChannel(guildId, channel.id);
  return interaction.reply({
    content: `✅ Now watching ${channel} for target images.`,
    ephemeral: true,
  });
}

async function cmdThreshold(interaction, guildId) {
  const value = interaction.options.getNumber('value', true);
  patchGuildConfig(guildId, { threshold: value });
  return interaction.reply({
    content:
      `✅ Similarity threshold set to **${value}** ` +
      `(cosine similarity of L2-normalized embeddings; default ${DEFAULT_SIMILARITY_THRESHOLD}).\n` +
      'Score ≥ threshold → match. This is **not** a pixel-% — it is vector similarity.',
    ephemeral: true,
  });
}

async function cmdAction(interaction, guildId) {
  const mode = interaction.options.getString('mode', true);
  if (!ACTIONS.includes(mode)) {
    return interaction.reply({ content: 'Invalid action.', ephemeral: true });
  }
  patchGuildConfig(guildId, { action: mode });
  return interaction.reply({
    content: `✅ Match action set to \`${mode}\` . Severe actions stay off unless you pick them.`,
    ephemeral: true,
  });
}

async function cmdLogChannel(interaction, guildId) {
  const channel = interaction.options.getChannel('channel');
  patchGuildConfig(guildId, { logChannelId: channel?.id || null });
  return interaction.reply({
    content: channel
      ? `✅ Detection logs → ${channel}`
      : '✅ Log channel cleared (will post in the watched channel).',
    ephemeral: true,
  });
}

async function cmdEscalation(interaction, guildId) {
  const enabled = interaction.options.getBoolean('enabled', true);
  patchGuildConfig(guildId, { escalationEnabled: enabled });
  return interaction.reply({
    content: enabled
      ? '✅ Escalation ON: 1st warn → 2nd timeout → 3rd kick → 4th ban.'
      : '✅ Escalation OFF — using the single configured action only.',
    ephemeral: true,
  });
}

async function cmdStatus(interaction, guildId) {
  const cfg = getGuildConfig(guildId);
  const targets = listTargets(guildId);
  const enabled = targets.filter((t) => t.enabled).length;
  const jina = Boolean(process.env.JINA_API_KEY?.trim());
  const embed = new EmbedBuilder()
    .setColor(0xc9a227)
    .setTitle('🖼️ Image Target Status')
    .addFields(
      { name: 'Targets', value: `${enabled}/${targets.length} enabled`, inline: true },
      {
        name: 'Channels',
        value: cfg.channels.length
          ? cfg.channels.map((id) => `<#${id}>`).join(', ')
          : '_none_',
        inline: true,
      },
      { name: 'Action', value: `\`${cfg.action}\``, inline: true },
      { name: 'Threshold', value: String(cfg.threshold), inline: true },
      {
        name: 'Escalation',
        value: cfg.escalationEnabled ? 'ON' : 'OFF',
        inline: true,
      },
      {
        name: 'Log channel',
        value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : '_watched channel_',
        inline: true,
      },
      {
        name: 'Jina CLIP',
        value: jina ? '🔑 key set' : '❌ no `JINA_API_KEY` (pHash-only)',
        inline: false,
      },
    );
  return interaction.reply({ embeds: [embed], ephemeral: true });
}
