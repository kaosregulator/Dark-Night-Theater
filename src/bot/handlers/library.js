import { EmbedBuilder } from 'discord.js';
import * as library from '../../services/library-store.js';
import { readiness } from '../../config.js';
import { canManage } from '../permissions.js';
import { COLORS } from './format.js';

// /library sync | status — staff tools to manage the Cloudflare Stream library.

export async function handleLibraryCommand(interaction) {
  const sub = interaction.options.getSubcommand();

  if (!canManage(interaction.member)) {
    return interaction.reply({ content: '🔒 You don’t have permission to manage the library.', ephemeral: true });
  }

  if (sub === 'status') {
    const embed = new EmbedBuilder()
      .setColor(COLORS.gold)
      .setTitle('📚 Library status')
      .addFields(
        { name: 'Videos cached', value: String(library.getCachedLibrary().length), inline: true },
        { name: 'Last synced', value: library.lastSyncedAt() || 'never', inline: true },
        { name: 'Cloudflare', value: readiness.cloudflare ? '✅ configured' : '❌ not configured', inline: true }
      );
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (sub === 'sync') {
    if (!readiness.cloudflare) {
      return interaction.reply({
        content: '❌ Cloudflare isn’t configured. Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_STREAM_API_TOKEN`.',
        ephemeral: true,
      });
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const videos = await library.syncLibrary();
      await interaction.editReply(`✅ Synced **${videos.length}** videos from Cloudflare Stream.`);
    } catch (err) {
      await interaction.editReply(`⚠️ Sync failed: ${err.message}`);
    }
  }
}
