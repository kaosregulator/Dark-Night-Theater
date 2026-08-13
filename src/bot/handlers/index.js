import { log } from '../../logger.js';
import { handleWatchCommand, handleWatchPick, handleWatchParty, handleWatchPrivate, handleWatchBack } from './watch.js';
import { handleTheaterCommand, handleControlButton } from './theater.js';
import { handlePreshow } from './preshow.js';
import { handleSettingsCommand, handleSettingsComponent } from './settings.js';
import { handleLibraryCommand } from './library.js';

// Central interaction router. Wired to the client's interactionCreate event.
export async function routeInteraction(interaction) {
  try {
    // ---- Slash commands ----
    if (interaction.isChatInputCommand()) {
      switch (interaction.commandName) {
        case 'watch':
          return await handleWatchCommand(interaction);
        case 'theater':
          return await handleTheaterCommand(interaction);
        case 'theater-settings':
          return await handleSettingsCommand(interaction);
        case 'library':
          return await handleLibraryCommand(interaction);
        default:
          return;
      }
    }

    // ---- Select menus ----
    if (interaction.isStringSelectMenu() || interaction.isRoleSelectMenu()) {
      const id = interaction.customId;
      if (id === 'w:pick') return await handleWatchPick(interaction);
      if (id.startsWith('set:')) return await handleSettingsComponent(interaction);
      return;
    }

    // ---- Buttons ----
    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id.startsWith('w:party:')) return await handleWatchParty(interaction, id.slice('w:party:'.length));
      if (id.startsWith('w:private:')) return await handleWatchPrivate(interaction, id.slice('w:private:'.length));
      if (id === 'w:back') return await handleWatchBack(interaction);
      // Gamified pre-show — one public, owner-gated, self-deleting message.
      if (id.startsWith('ps:')) return await handlePreshow(interaction);
      if (id.startsWith('t:ctl:')) {
        const [, , action, channelId] = id.split(':');
        return await handleControlButton(interaction, action, channelId);
      }
      if (id.startsWith('set:')) return await handleSettingsComponent(interaction);
      return;
    }
  } catch (err) {
    log.error('interaction error:', err);
    try {
      const msg = { content: '⚠️ Something went wrong handling that.', ephemeral: true };
      if (interaction.deferred || interaction.replied) await interaction.followUp(msg);
      else await interaction.reply(msg);
    } catch {
      /* ignore */
    }
  }
}
