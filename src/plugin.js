import { Events } from 'discord.js';
import { commands } from './bot/commands.js';
import { registerCommands } from './bot/register-commands.js';
import { routeInteraction } from './bot/handlers/index.js';
import { wireControlPanelRefresh } from './bot/handlers/theater.js';
import { setDiscordClient } from './bot/clientRef.js';
import { mountTheater } from './web/server.js';
import { attachWebSocket } from './web/ws.js';
import { GatewayIntentBits } from 'discord.js';

// ============================================================================
//  ADD-ON / PLUGIN API
//
//  Drop the whole DarkNight Theater feature (/watch, /join, /theater, host
//  uploads, temp streaming, the Activity, sync) into an EXISTING Node.js
//  discord.js v14 bot WITHOUT overwriting it. Your bot keeps its own commands
//  and handlers; this only ADDS an interaction listener (that ignores anything
//  it doesn't own) plus the Theater's web routes.
//
//  Quick start (in your existing bot):
//    import { attachTheater, mountTheaterWeb, theaterCommands, THEATER_INTENTS }
//      from 'darknight-home-theater/src/plugin.js';
//
//    // 1) make sure your Client has the voice-states intent:
//    //    new Client({ intents: [ ...yours, GatewayIntentBits.GuildVoiceStates ] })
//    // 2) attach interactions to YOUR client:
//    attachTheater(client);
//    // 3) mount the web routes onto YOUR express app + http server:
//    mountTheaterWeb(app, httpServer);        // serves the Activity at "/"
//    // 4) include our commands when you register yours:
//    await registerAllCommands([...yourCommands, ...theaterCommands]);
//
//  Requirements: Node 18+, discord.js v14, and the same env vars this repo uses
//  (DISCORD_CLIENT_ID/SECRET, PUBLIC_BASE_URL, SESSION_SECRET, MEDIA_DIR…).
//  The Activity belongs to ONE Discord Application, so the host bot and the
//  Activity must share that application's client id/secret.
// ============================================================================

// The slash-command definitions (JSON) to merge into your own registration.
export const theaterCommands = commands;

// Intents this feature needs — union these into your Client's intents.
export const THEATER_INTENTS = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates];

// Command names / custom-id prefixes this feature owns (so you can check for
// collisions with your existing bot).
export const THEATER_COMMAND_NAMES = ['watch', 'join', 'theater', 'library', 'theater-settings'];
export const THEATER_CUSTOMID_PREFIXES = ['w:', 'ps:', 't:ctl:', 'set:', 'join:'];

// Attach the Theater's interaction handling to YOUR existing client. Adds an
// extra interactionCreate listener that no-ops on anything it doesn't own, so
// your handlers keep working. Safe to call once after you create the client.
export function attachTheater(client) {
  setDiscordClient(client);
  client.on(Events.InteractionCreate, routeInteraction);
  if (client.isReady?.()) wireControlPanelRefresh();
  else client.once(Events.ClientReady, () => wireControlPanelRefresh());
  return client;
}

// Mount the Theater web (movie streaming, temp sessions, host uploader, API,
// WebSocket sync, and the Activity) onto YOUR express app + http server.
// Pass { serveActivity:false } if your app already owns "/" and you'll serve the
// built Activity (dist/public) yourself or on a dedicated subdomain.
export function mountTheaterWeb(app, httpServer, opts = {}) {
  mountTheater(app, opts);
  attachWebSocket(httpServer);
  return app;
}

// Convenience: register commands (yours + theaterCommands) with Discord. If you
// already have your own registration, just append `theaterCommands` to its body.
export async function registerTheaterCommands() {
  return registerCommands();
}
