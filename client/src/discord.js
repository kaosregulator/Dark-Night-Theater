import { DiscordSDK, patchUrlMappings } from '@discord/embedded-app-sdk';

// Handles the Discord Embedded App SDK handshake: identify the user, learn the
// voice channel / guild we're in, and route Cloudflare Stream through Discord's
// proxy so video plays inside the sandboxed Activity iframe.

export const dc = {
  sdk: null,
  auth: null, // { access_token, user }
  channelId: null,
  guildId: null,
  instanceId: null,
};

// When running inside Discord, the SDK is available. When opened in a plain
// browser (local dev / preview), we fall back to a mock so the UI still renders.
export function inDiscord() {
  const q = new URLSearchParams(location.search);
  return q.has('frame_id') || q.has('instance_id');
}

async function fetchConfig() {
  const res = await fetch('/api/config');
  return res.json();
}

export async function initDiscord(onStatus = () => {}) {
  const cfg = await fetchConfig();

  if (!inDiscord()) {
    // Local/browser preview mode — no real Discord context.
    dc.channelId = 'preview-channel';
    dc.guildId = 'preview-guild';
    dc.auth = { access_token: 'preview', user: { id: 'preview-user', name: 'You (preview)', avatar: '' } };
    onStatus('Preview mode (not inside Discord)');
    return dc;
  }

  onStatus('Connecting to Discord…');
  const sdk = new DiscordSDK(cfg.clientId);
  dc.sdk = sdk;
  await sdk.ready();

  // Route Cloudflare Stream hosts through Discord's proxy. These prefixes must
  // also exist as URL Mappings in the Developer Portal (see SETUP.md).
  const targets = cfg.streamTargets || [];
  if (targets.length) {
    patchUrlMappings(targets.map((target, i) => ({ prefix: `/stream${i}`, target })));
  }

  onStatus('Authorizing…');
  const { code } = await sdk.commands.authorize({
    client_id: cfg.clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify', 'guilds'],
  });

  const tokenRes = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const { access_token } = await tokenRes.json();

  const auth = await sdk.commands.authenticate({ access_token });
  dc.auth = {
    access_token,
    user: {
      id: auth.user.id,
      name: auth.user.global_name || auth.user.username,
      avatar: auth.user.avatar
        ? `https://cdn.discordapp.com/avatars/${auth.user.id}/${auth.user.avatar}.png?size=128`
        : '',
    },
  };
  dc.channelId = sdk.channelId;
  dc.guildId = sdk.guildId;
  dc.instanceId = sdk.instanceId;
  onStatus('Ready');
  return dc;
}
