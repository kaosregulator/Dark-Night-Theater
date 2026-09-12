import { dc } from './discord.js';

// WebSocket sync client. Connects to the room for our voice channel, sends a
// `hello` to authenticate, then streams presence + playback updates. The same
// room is driven by the text-channel control buttons, so everything stays in
// lockstep. Auto-reconnects with backoff.

export class SyncClient extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.snapshot = null;
    this.backoff = 1000;
    this._closedByUs = false;
  }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws?channelId=${encodeURIComponent(dc.channelId)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener('open', () => {
      this.backoff = 1000;
      this.send({ type: 'hello', token: dc.auth.access_token, guildId: dc.guildId });
    });

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'welcome' || msg.type === 'sync') {
        if (msg.snapshot) this.snapshot = msg.snapshot;
        this.dispatchEvent(new CustomEvent('state', { detail: this.snapshot }));
        if (msg.event) this.dispatchEvent(new CustomEvent('room-event', { detail: msg.event }));
      } else if (msg.type === 'code-ok') {
        this.dispatchEvent(new CustomEvent('room-event', { detail: { type: 'code-ok', roomCode: msg.roomCode } }));
      } else if (msg.type === 'error') {
        this.dispatchEvent(new CustomEvent('sync-error', { detail: msg.error }));
      }
    });

    ws.addEventListener('close', () => {
      if (this._closedByUs) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 15000);
    });
    ws.addEventListener('error', () => ws.close());
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  control(action, value) {
    this.send({ type: 'control', action, value });
  }
  claimHost() {
    this.send({ type: 'claim-host' });
  }
  takeSeat(seat) {
    this.send({ type: 'seat', seat });
  }
  giveItem(item) {
    this.send({ type: 'item', item });
  }
  enter(opts = {}) {
    this.send({ type: 'enter', seat: opts.seat, items: opts.items || [] });
  }
  unlockCode(code) {
    this.send({ type: 'unlock-code', code });
  }
  react(kind) {
    this.send({ type: 'react', kind });
  }

  close() {
    this._closedByUs = true;
    this.ws?.close();
  }
}
