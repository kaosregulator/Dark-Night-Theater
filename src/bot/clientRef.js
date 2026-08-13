// Shared reference to the running discord.js client so the web layer (the /host
// "start party" endpoint) can post the control panel and create the Activity
// invite. Set once when the bot boots.
let client = null;
export function setDiscordClient(c) {
  client = c;
}
export function getDiscordClient() {
  return client;
}
