import { WebSocketServer } from 'ws';
import { verifyDiscordToken } from '../util/auth.js';
import * as sessions from '../services/sessions.js';
import { getSettings } from '../services/settings-store.js';
import { log } from '../logger.js';

// Real-time sync hub. One WebSocket per participant in the Activity. The client
// connects to /ws?channelId=<voiceChannelId>, then sends { type:'hello', token,
// guildId } to authenticate. After that, control/seat/item messages flow in and
// room snapshots flow out. The same room is also mutated by the text-channel
// control buttons (see bot handlers), so both surfaces stay in lockstep.

export function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    // theaterId lets an Activity instance join a booth screen; default = voice channel room.
    const channelId = url.searchParams.get('theaterId') || url.searchParams.get('channelId');
    ws.channelId = channelId;
    ws.voiceChannelId = url.searchParams.get('channelId') || channelId;
    ws.user = null;
    ws.alive = true;

    const send = (obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };

    // Forward room updates for this channel to the socket.
    const onUpdate = (payload) => {
      if (payload.channelId === ws.channelId) send({ type: 'sync', ...payload });
    };
    sessions.bus.on('update', onUpdate);

    ws.on('pong', () => (ws.alive = true));

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // Authenticate first.
      if (msg.type === 'hello') {
        const user = await verifyDiscordToken(msg.token);
        if (!user) return send({ type: 'error', error: 'auth-failed' });
        ws.user = user;
        ws.guildId = msg.guildId || null;
        sessions.join(ws.channelId, { ...user, guildId: ws.guildId });
        return send({ type: 'welcome', user, snapshot: sessions.snapshot(sessions.getRoom(ws.channelId)) });
      }

      if (!ws.user) return send({ type: 'error', error: 'not-authenticated' });
      const uid = ws.user.id;

      switch (msg.type) {
        case 'heartbeat':
          send({ type: 'pong' });
          break;

        case 'seat':
          sessions.takeSeat(ws.channelId, uid, msg.seat);
          break;

        case 'item': {
          const settings = ws.guildId ? getSettings(ws.guildId) : null;
          if (settings && !settings.allowSocialInteractions) break;
          sessions.giveItem(ws.channelId, uid, msg.item);
          break;
        }

        case 'control': {
          // Host-only enforcement lives in sessions.control().
          const result = sessions.control(ws.channelId, uid, msg.action, msg.value);
          if (!result.ok) send({ type: 'error', error: result.reason || 'Control rejected' });
          break;
        }

        case 'enter': {
          // Foyer → seats: audience completed the in-Activity join ritual.
          const result = sessions.enterTheater(ws.channelId, uid, {
            seat: msg.seat,
            items: msg.items,
          });
          if (!result.ok) send({ type: 'error', error: result.reason || 'Could not enter' });
          break;
        }

        case 'unlock-code': {
          const result = sessions.unlockWithCode(ws.channelId, uid, msg.code);
          if (!result.ok) send({ type: 'error', error: result.reason || 'Bad code' });
          else send({ type: 'code-ok', roomCode: result.roomCode });
          break;
        }

        case 'react': {
          // Lightweight emotes (popcorn throw / cheer) — broadcast to everyone.
          const kind = String(msg.kind || 'cheer').slice(0, 20);
          sessions.bus.emit('update', {
            channelId: ws.channelId,
            snapshot: sessions.snapshot(sessions.getRoom(ws.channelId)),
            event: {
              type: 'react',
              kind,
              user: { id: uid, name: ws.user.name || ws.user.username || 'Someone' },
            },
          });
          break;
        }

        case 'claim-host':
          // First person / owner grabbing host when none set.
          if (!sessions.isHost(ws.channelId, uid) && !sessions.getRoom(ws.channelId).hostId) {
            sessions.setHost(ws.channelId, uid);
          }
          break;

        case 'marquee-add': {
          const result = sessions.addToMarquee(ws.channelId, msg.video || { uid: msg.uid, name: msg.name });
          if (!result.ok) send({ type: 'error', error: result.reason || 'Marquee add failed' });
          break;
        }

        case 'marquee-remove': {
          const result = sessions.removeFromMarquee(ws.channelId, uid, msg.uid);
          if (!result.ok) send({ type: 'error', error: result.reason || 'Marquee remove failed' });
          break;
        }

        case 'marquee-vote': {
          const result = sessions.voteMarquee(ws.channelId, uid, msg.uid);
          if (!result.ok) send({ type: 'error', error: result.reason || 'Vote failed' });
          break;
        }

        case 'marquee-clear': {
          const result = sessions.clearMarquee(ws.channelId, uid);
          if (!result.ok) send({ type: 'error', error: result.reason || 'Clear failed' });
          break;
        }

        default:
          break;
      }
    });

    ws.on('close', () => {
      sessions.bus.off('update', onUpdate);
      if (ws.user) sessions.leave(ws.channelId, ws.user.id);
    });
  });

  // Drop dead sockets.
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) {
        ws.terminate();
        continue;
      }
      ws.alive = false;
      ws.ping();
    }
  }, 30_000);
  wss.on('close', () => clearInterval(interval));

  log.info('WebSocket sync hub attached at /ws');
  return wss;
}
