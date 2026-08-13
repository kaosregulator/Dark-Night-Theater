import { EmbedBuilder } from 'discord.js';
import * as library from '../../services/library-store.js';
import { config } from '../../config.js';
import { canManage } from '../permissions.js';
import { COLORS } from './format.js';

// /library sync | status — staff tools to manage the local movie library.

export async function handleLibraryCommand(interaction) {
  const sub = interaction.options.getSubcommand();

  if (!canManage(interaction.member)) {
    return interaction.reply({ content: '🔒 You don’t have permission to manage the library.', ephemeral: true });
  }

  const hostUrl = config.app.baseUrl ? `${config.app.baseUrl}/host` : '`<PUBLIC_BASE_URL>`/host';

  if (sub === 'status') {
    const embed = new EmbedBuilder()
      .setColor(COLORS.gold)
      .setTitle('📚 Library status')
      .addFields(
        { name: 'Videos', value: String(library.getCachedLibrary().length), inline: true },
        { name: 'Last scanned', value: library.lastSyncedAt() || 'never', inline: true },
        { name: 'Media folder', value: `\`${config.media.dir}\``, inline: false },
        { name: 'Add movies', value: `Upload from your device at ${hostUrl}` }
      );
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (sub === 'sync') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const videos = await library.syncLibrary();
      await interaction.editReply(
        `✅ Scanned the media folder — **${videos.length}** video(s).\nAdd more from your device at ${hostUrl}`
      );
    } catch (err) {
      await interaction.editReply(`⚠️ Scan failed: ${err.message}`);
    }
  }
}
