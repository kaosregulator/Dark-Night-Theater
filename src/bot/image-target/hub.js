import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import sharp from 'sharp';
import { log } from '../../logger.js';
import { hasDatabaseUrl } from '../../db/postgres.js';
import { canManage } from '../permissions.js';
import { pct } from './actions.js';
import {
  ACTIONS,
  DEFAULT_ACTION,
  DEFAULT_SIMILARITY_THRESHOLD,
} from './constants.js';
import { analyzeTargetBuffer, testAgainstTargets } from './detector.js';
import {
  downloadBytes,
  loadMediaAsImage,
  looksLikeImage,
  looksLikeVideo,
} from './download.js';
import {
  addChannel,
  addTarget,
  getGuildConfig,
  listTargets,
  patchGuildConfig,
  removeChannel,
  removeTarget,
  updateTarget,
} from './store.js';

/**
 * Image Target Hub — Discord file picker to add targets, one-click channel arming,
 * action picker, and target previews. Replaces the old slash-subcommand maze.
 *
 * customId prefix: `it:`
 */

export const HUB_PREFIX = 'it:';

function cid(...parts) {
  return `${HUB_PREFIX}${parts.join(':')}`;
}

export function parseHubId(customId) {
  if (!customId?.startsWith(HUB_PREFIX)) return null;
  const [action, ...parts] = customId.slice(HUB_PREFIX.length).split(':');
  return { action, parts };
}

function actionLabel(action) {
  return (
    {
      log: 'Log only',
      delete_log: 'Delete + log',
      delete_warn: 'Delete + warn (recommended)',
      delete_timeout: 'Delete + timeout',
      delete_kick: 'Delete + kick',
      delete_ban: 'Delete + ban',
    }[action] || action
  );
}

async function makePreviewJpeg(buffer) {
  try {
    return await sharp(buffer)
      .rotate()
      .resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer();
  } catch {
    return null;
  }
}

export async function bufferFromAttachment(attachment) {
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
  const downloaded = await downloadBytes(attachment.proxyURL || attachment.url);
  const buffer = Buffer.isBuffer(downloaded) ? downloaded : downloaded.buffer;
  const contentType = downloaded.contentType || attachment.contentType || '';
  const loaded = await loadMediaAsImage(buffer, {
    contentType,
    filename: attachment.name,
    url: attachment.url,
  });
  const out = Buffer.isBuffer(loaded) ? loaded : loaded.buffer;
  const mediaKind =
    (!Buffer.isBuffer(loaded) && loaded.mediaKind) ||
    (looksLikeVideo(meta) ? 'video' : 'image');
  return { buffer: out, mediaKind, sourceUrl: attachment.url };
}

async function probeChannelPerms(guild, channelId) {
  const ch = await guild.channels.fetch(channelId).catch(() => null);
  if (!ch) return { channelId, missing: ['channel not found'], ok: false };
  const perms = ch.permissionsFor(guild.members.me);
  const need = [
    ['View Channel', PermissionFlagsBits.ViewChannel],
    ['Read History', PermissionFlagsBits.ReadMessageHistory],
    ['Manage Messages', PermissionFlagsBits.ManageMessages],
    ['Send Messages', PermissionFlagsBits.SendMessages],
  ];
  const missing = need.filter(([, bit]) => !perms?.has(bit)).map(([n]) => n);
  return { channelId, ok: missing.length === 0, missing };
}

export async function saveTargetFromAttachment(
  guildId,
  attachment,
  { name = null, userId, autoWatchChannelId = null } = {},
) {
  const { buffer, mediaKind, sourceUrl } = await bufferFromAttachment(attachment);
  const analyzed = await analyzeTargetBuffer(buffer, { withEmbedding: true });
  const previewJpeg = await makePreviewJpeg(buffer);
  const displayName =
    (name && name.trim()) ||
    (attachment.name || 'target').replace(/\.[^.]+$/, '').slice(0, 64);

  const target = await addTarget(guildId, {
    name: displayName,
    perceptualHash: analyzed.dHash,
    blockHash: analyzed.blockHash,
    embedding: analyzed.embedding,
    embeddingModel: analyzed.embeddingModel,
    contentHash: analyzed.contentHash,
    mimeType: attachment.contentType || analyzed.format || null,
    createdBy: userId,
    mediaKind,
    previewJpeg,
    sourceUrl,
  });

  let watched = null;
  if (autoWatchChannelId) {
    const cfg = await getGuildConfig(guildId);
    if (!cfg.channels.includes(autoWatchChannelId)) {
      await addChannel(guildId, autoWatchChannelId);
      watched = autoWatchChannelId;
    }
  }

  // Prefer a visible warn for setups still on the old silent default.
  const cfg = await getGuildConfig(guildId);
  if (!cfg.action || cfg.action === 'delete_log') {
    await patchGuildConfig(guildId, { action: 'delete_warn' });
  }

  return { target, analyzed, watched, jina: Boolean(analyzed.embedding) };
}

export async function buildHubPayload(guild) {
  const guildId = guild.id;
  let cfg = await getGuildConfig(guildId);
  // Migrate older silent default so live matches are visible without a re-setup.
  if (cfg.action === 'delete_log') {
    await patchGuildConfig(guildId, { action: 'delete_warn' });
    cfg = await getGuildConfig(guildId);
  }
  const targets = await listTargets(guildId, { includeDisabled: true });
  const enabled = targets.filter((t) => t.enabled);
  const jina = Boolean(process.env.JINA_API_KEY?.trim());
  const dbOk = hasDatabaseUrl() || process.env.IMAGE_TARGET_MEMORY === '1';

  const channelProbes = [];
  for (const id of cfg.channels.slice(0, 8)) {
    channelProbes.push(await probeChannelPerms(guild, id));
  }
  const permProblems = channelProbes.filter((p) => !p.ok);

  const armed =
    dbOk &&
    enabled.length > 0 &&
    cfg.channels.length > 0 &&
    permProblems.length === 0;

  const statusLines = [
    armed
      ? '🟢 **ARMED** — matching images in watched channels will be actioned.'
      : '🟡 **NOT ARMED** — finish the checklist so live posts are caught.',
    '',
    `**Targets:** ${enabled.length}/${targets.length} enabled`,
    `**Channels:** ${
      cfg.channels.length
        ? cfg.channels.map((id) => `<#${id}>`).join(', ')
        : '_none — tap **Watch this channel**_'
    }`,
    `**Action:** \`${cfg.action || DEFAULT_ACTION}\` — ${actionLabel(cfg.action || DEFAULT_ACTION)}`,
    `**Threshold:** ${cfg.threshold ?? DEFAULT_SIMILARITY_THRESHOLD}`,
    `**Jina CLIP:** ${jina ? '🔑 on' : 'off (local pHash still catches near-duplicates)'}`,
    `**Postgres:** ${dbOk ? '✅' : '❌ set DATABASE_URL'}`,
  ];

  if (permProblems.length) {
    statusLines.push(
      '',
      '⚠️ **Missing bot permissions** (only listed when something is actually wrong):',
      ...permProblems.map(
        (p) => `• <#${p.channelId}> — needs ${p.missing.join(', ')}`,
      ),
    );
  } else if (cfg.channels.length) {
    statusLines.push('', '✅ Bot permissions look good in watched channels.');
  }

  const checklist = [
    dbOk ? '✅ Database' : '❌ Database (`DATABASE_URL`)',
    enabled.length ? '✅ Target image added' : '❌ Add a target image',
    cfg.channels.length ? '✅ Channel watched' : '❌ Watch this channel',
    !cfg.channels.length || permProblems.length === 0
      ? '✅ Channel permissions'
      : '❌ Fix Manage Messages / View / Send in watched channels',
  ];

  const embed = new EmbedBuilder()
    .setColor(armed ? 0x3bd275 : 0xc9a227)
    .setTitle('🖼️ Image Target Hub')
    .setDescription(statusLines.join('\n'))
    .addFields({ name: 'Fast setup', value: checklist.join('\n') })
    .setFooter({
      text: 'Tip: /image-target + attach a file adds a target and watches this channel.',
    });

  const files = [];
  const gallery = new EmbedBuilder().setColor(0x5b6ee1).setTitle('🎯 Saved targets');

  if (!targets.length) {
    gallery.setDescription(
      '_No targets yet. Tap **Add image** or run `/image-target` with a file attached._',
    );
  } else {
    const lines = [];
    for (let i = 0; i < Math.min(targets.length, 10); i++) {
      const t = targets[i];
      const flag = t.enabled ? '🟢' : '🔴';
      const ai = t.embedding?.length ? '· AI' : '· pHash';
      lines.push(`${flag} **${t.name}** \`${String(t.targetId).slice(0, 8)}\` ${ai}`);
      if (t.previewJpeg && files.length < 8) {
        const name = `target-${i + 1}.jpg`;
        files.push(new AttachmentBuilder(Buffer.from(t.previewJpeg), { name }));
        if (files.length === 1) gallery.setThumbnail(`attachment://${name}`);
      } else if (t.sourceUrl && !gallery.data.thumbnail) {
        gallery.setThumbnail(t.sourceUrl);
      }
    }
    gallery.setDescription(lines.join('\n').slice(0, 4000));
  }

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('add'))
      .setLabel('Add image')
      .setEmoji('📎')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(cid('watch'))
      .setLabel('Watch this channel')
      .setEmoji('👀')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(cid('unwatch'))
      .setLabel('Unwatch this channel')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid('refresh'))
      .setLabel('Refresh')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(cid('test'))
      .setLabel('Test image')
      .setEmoji('🔍')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(cid('action'))
      .setLabel('Set action')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(cid('remove'))
      .setLabel('Remove target')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!targets.length),
  );

  return {
    embeds: [embed, gallery],
    components: [row1, row2],
    files,
    ephemeral: true,
  };
}

function addImageModal() {
  return new ModalBuilder()
    .setCustomId(cid('add_modal'))
    .setTitle('Add image target')
    .addLabelComponents(
      new LabelBuilder().setLabel('Optional name').setTextInputComponent(
        new TextInputBuilder()
          .setCustomId('name')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(64)
          .setPlaceholder('e.g. Scam banner'),
      ),
      new LabelBuilder()
        .setLabel('Target image / GIF / video')
        .setFileUploadComponent(
          new FileUploadBuilder()
            .setCustomId('media')
            .setMinValues(1)
            .setMaxValues(1)
            .setRequired(true),
        ),
    );
}

function testImageModal() {
  return new ModalBuilder()
    .setCustomId(cid('test_modal'))
    .setTitle('Test an image (dry run)')
    .addLabelComponents(
      new LabelBuilder().setLabel('Image to test').setFileUploadComponent(
        new FileUploadBuilder()
          .setCustomId('media')
          .setMinValues(1)
          .setMaxValues(1)
          .setRequired(true),
      ),
    );
}

export async function handleImageTargetHub(interaction) {
  if (!interaction.inGuild()) {
    return interaction.reply({ content: 'Server only.', ephemeral: true });
  }
  if (!canManage(interaction.member)) {
    return interaction.reply({
      content: '❌ You need **Manage Server** (or a manager role).',
      ephemeral: true,
    });
  }

  const parsed = parseHubId(interaction.customId);
  if (!parsed) return;

  const { action } = parsed;
  const guildId = interaction.guildId;

  try {
    if (action === 'refresh') {
      await interaction.deferUpdate();
      return interaction.editReply(await buildHubPayload(interaction.guild));
    }

    if (action === 'watch') {
      await interaction.deferUpdate();
      await addChannel(guildId, interaction.channelId);
      await interaction.editReply(await buildHubPayload(interaction.guild));
      return interaction.followUp({
        content: `✅ Now watching ${interaction.channel}. Matching posts here will be actioned.`,
        ephemeral: true,
      });
    }

    if (action === 'unwatch') {
      await interaction.deferUpdate();
      await removeChannel(guildId, interaction.channelId);
      await interaction.editReply(await buildHubPayload(interaction.guild));
      return interaction.followUp({
        content: `Stopped watching ${interaction.channel}.`,
        ephemeral: true,
      });
    }

    if (action === 'add') return interaction.showModal(addImageModal());
    if (action === 'test') return interaction.showModal(testImageModal());

    if (action === 'action') {
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(cid('action_pick'))
          .setPlaceholder('What should happen on a match?')
          .addOptions(
            ACTIONS.map((a) => ({
              label: actionLabel(a).slice(0, 100),
              value: a,
              description: a === 'delete_warn' ? 'Recommended default' : a,
            })),
          ),
      );
      return interaction.reply({
        content: 'Pick a match action:',
        components: [row],
        ephemeral: true,
      });
    }

    if (action === 'action_pick' && interaction.isStringSelectMenu()) {
      const mode = interaction.values[0];
      await patchGuildConfig(guildId, { action: mode });
      return interaction.update({
        content: `✅ Match action set to **${actionLabel(mode)}** (\`${mode}\`).`,
        components: [],
      });
    }

    if (action === 'remove') {
      const targets = await listTargets(guildId, { includeDisabled: true });
      if (!targets.length) {
        return interaction.reply({ content: 'No targets to remove.', ephemeral: true });
      }
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(cid('remove_pick'))
          .setPlaceholder('Remove which target?')
          .addOptions(
            targets.slice(0, 25).map((t) => ({
              label: t.name.slice(0, 100),
              value: t.targetId,
              description: `${t.enabled ? 'enabled' : 'disabled'} · ${String(t.targetId).slice(0, 8)}`,
            })),
          ),
      );
      return interaction.reply({
        content: 'Select a target to remove:',
        components: [row],
        ephemeral: true,
      });
    }

    if (action === 'remove_pick' && interaction.isStringSelectMenu()) {
      const id = interaction.values[0];
      const targets = await listTargets(guildId, { includeDisabled: true });
      const t = targets.find((x) => x.targetId === id);
      await removeTarget(guildId, id);
      return interaction.update({
        content: `🗑️ Removed **${t?.name || id}**. Run \`/image-target\` to refresh the hub.`,
        components: [],
      });
    }

    if (action === 'add_modal' && interaction.isModalSubmit()) {
      await interaction.deferReply({ ephemeral: true });
      let name = null;
      try {
        name = interaction.fields.getTextInputValue('name')?.trim() || null;
      } catch {
        name = null;
      }
      const files = interaction.fields.getUploadedFiles('media', true);
      const attachment = files?.first?.() || [...(files?.values?.() || [])][0];
      if (!attachment) {
        return interaction.editReply({ content: '❌ No file received.' });
      }
      const { target, watched, jina } = await saveTargetFromAttachment(guildId, attachment, {
        name,
        userId: interaction.user.id,
        autoWatchChannelId: interaction.channelId,
      });
      const hub = await buildHubPayload(interaction.guild);
      const note = [
        `✅ Target **${target.name}** saved.`,
        jina
          ? 'Jina embedding stored.'
          : 'Local pHash only (set `JINA_API_KEY` for stronger matching).',
        watched ? `Auto-watching ${interaction.channel}.` : null,
        'Default action: **Delete + warn**.',
      ]
        .filter(Boolean)
        .join('\n');
      hub.embeds[0].setDescription(`${note}\n\n${hub.embeds[0].data.description || ''}`);
      return interaction.editReply(hub);
    }

    if (action === 'test_modal' && interaction.isModalSubmit()) {
      await interaction.deferReply({ ephemeral: true });
      const files = interaction.fields.getUploadedFiles('media', true);
      const attachment = files?.first?.() || [...(files?.values?.() || [])][0];
      if (!attachment) {
        return interaction.editReply({ content: '❌ No file received.' });
      }
      const { buffer } = await bufferFromAttachment(attachment);
      const result = await testAgainstTargets(guildId, buffer);
      if (!result.results?.length) {
        return interaction.editReply({
          content: result.message || 'No targets to test against.',
        });
      }
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
        .addFields({
          name: 'Result',
          value: result.match
            ? '🚨 **MATCH** — live posts like this should be actioned in watched channels'
            : '✅ No match under current thresholds',
        });
      return interaction.editReply({ embeds: [embed] });
    }

    if (action === 'toggle' && parsed.parts[0]) {
      const targetId = parsed.parts[0];
      const targets = await listTargets(guildId, { includeDisabled: true });
      const t = targets.find((x) => x.targetId === targetId);
      if (!t) {
        return interaction.reply({ content: 'Target not found.', ephemeral: true });
      }
      await updateTarget(guildId, targetId, { enabled: !t.enabled });
      await interaction.deferUpdate();
      return interaction.editReply(await buildHubPayload(interaction.guild));
    }
  } catch (err) {
    log.error('[image-target] hub error:', err);
    const msg = { content: `⚠️ ${err.message || 'Something went wrong.'}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) return interaction.followUp(msg);
    return interaction.reply(msg);
  }
}
