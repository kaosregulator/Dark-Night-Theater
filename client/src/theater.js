// The visual theater: screen, curtains, seats with Discord avatars, host
// controls, social interactions, and a movie lobby. Vanilla DOM + CSS so it
// stays light enough for Discord mobile. All state comes from setState().

import './styles.css';

const SEAT_COUNT = 24;
const ITEMS = [
  { key: 'popcorn', emoji: '🍿', label: 'Popcorn' },
  { key: 'soda', emoji: '🥤', label: 'Soda' },
  { key: 'candy', emoji: '🍫', label: 'Candy' },
];

function fmt(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export class TheaterUI {
  constructor(root) {
    this.root = root;
    this.handlers = {};
    this.state = null;
    this.me = null;
    this.mode = 'lobby';
    this.library = [];
  }

  on(evt, cb) {
    this.handlers[evt] = cb;
  }
  emit(evt, detail) {
    this.handlers[evt]?.(detail || {});
  }

  mount() {
    this.root.innerHTML = `
      <div class="stage">
        <header class="topbar">
          <div class="brand">🎬 <span>DARKNIGHT CINEMA</span></div>
          <div class="meta">
            <span class="badge" id="mode-badge">Lobby</span>
            <span class="watchers">👥 <span id="watch-count">0</span></span>
          </div>
          <div class="topbar-actions">
            <button class="btn" id="btn-lobby">🎞️ Movies</button>
          </div>
        </header>

        <section class="screen-wrap">
          <div class="curtain left"></div>
          <div class="curtain right"></div>
          <div class="beam"></div>
          <div class="screen">
            <video id="theater-video" playsinline webkit-playsinline></video>
            <div class="screen-empty" id="screen-empty">
              <div class="screen-empty-inner">
                <div class="pop">🍿</div>
                <p>No movie playing. Open <b>Movies</b> to start.</p>
              </div>
            </div>
            <div class="tap hidden" id="tap-to-play">▶ Tap to start</div>
          </div>
          <div class="now-playing" id="now-playing"></div>
          <div class="feed-note hidden" id="feed-note"></div>
        </section>

        <section class="controls" id="controls"></section>

        <section class="floor">
          <div class="seats" id="seats"></div>
        </section>

        <section class="social" id="social"></section>

        <div class="lobby hidden" id="lobby"></div>
        <div class="intro hidden" id="intro"></div>
        <div class="toasts" id="toasts"></div>
      </div>
    `;

    this.videoEl = this.root.querySelector('#theater-video');
    this.root.querySelector('#btn-lobby').onclick = () => this.toggleLobby();
    this.renderSeats();
    this.renderSocial();
    this.renderControls();
  }

  // ---- Seats ---------------------------------------------------------------
  renderSeats() {
    const seats = this.root.querySelector('#seats');
    seats.innerHTML = '';
    for (let i = 0; i < SEAT_COUNT; i++) {
      const b = document.createElement('button');
      b.className = 'seat';
      b.dataset.seat = String(i);
      b.innerHTML = '🪑';
      b.onclick = () => this.emit('seat', { seat: i });
      seats.appendChild(b);
    }
  }

  updateSeats() {
    const participants = this.state?.participants || [];
    const bySeat = new Map();
    const standing = [];
    for (const p of participants) {
      if (p.seat === null || p.seat === undefined) standing.push(p);
      else bySeat.set(p.seat, p);
    }
    this.root.querySelectorAll('.seat').forEach((el) => {
      const idx = Number(el.dataset.seat);
      const p = bySeat.get(idx);
      if (p) {
        el.classList.add('occupied');
        el.classList.toggle('me', p.id === this.me?.id);
        const items = (p.items || []).map((i) => ITEMS.find((x) => x.key === i)?.emoji || '').join('');
        el.innerHTML = `
          <img src="${p.avatar || ''}" alt="" onerror="this.style.display='none'"/>
          <span class="seat-name">${escapeHtml(p.name)}</span>
          ${items ? `<span class="seat-items">${items}</span>` : ''}`;
      } else {
        el.classList.remove('occupied', 'me');
        el.innerHTML = '🪑';
      }
    });

    // Anyone without a seat shows in a "standing" strip.
    let strip = this.root.querySelector('#standing');
    if (!strip) {
      strip = document.createElement('div');
      strip.id = 'standing';
      strip.className = 'standing';
      this.root.querySelector('.floor').prepend(strip);
    }
    strip.innerHTML = standing.length
      ? `<span class="standing-label">Finding a seat:</span>` +
        standing
          .map(
            (p) =>
              `<span class="mini" title="${escapeHtml(p.name)}"><img src="${p.avatar || ''}" onerror="this.style.opacity=0"/></span>`
          )
          .join('')
      : '';
  }

  // ---- Social --------------------------------------------------------------
  renderSocial() {
    const el = this.root.querySelector('#social');
    el.innerHTML = ITEMS.map(
      (i) => `<button class="btn social-btn" data-item="${i.key}">${i.emoji} ${i.label}</button>`
    ).join('');
    el.querySelectorAll('.social-btn').forEach((b) => {
      b.onclick = () => {
        this.emit('item', { item: b.dataset.item });
        this.floatEmoji(ITEMS.find((x) => x.key === b.dataset.item)?.emoji || '🍿');
      };
    });
  }

  // ---- Host controls -------------------------------------------------------
  renderControls() {
    const el = this.root.querySelector('#controls');
    const mk = (action, label, extra = '') =>
      `<button class="btn ctl" data-action="${action}" ${extra}>${label}</button>`;
    el.innerHTML = `
      ${mk('back30', '⏮ 30')}
      ${mk('back10', '⏪ 10')}
      <button class="btn ctl ctl-main" data-action="toggle" id="ctl-toggle">▶</button>
      ${mk('fwd10', '10 ⏩')}
      ${mk('fwd30', '30 ⏭')}
      <span class="ctl-sep"></span>
      ${mk('lock', '🔒', 'id="ctl-lock"')}
      ${mk('end', '⏹ End', 'id="ctl-end"')}
      <button class="btn ctl ghost hidden" id="ctl-host">👑 Become host</button>
    `;
    el.querySelectorAll('[data-action]').forEach((b) => {
      b.onclick = () => {
        const action = b.dataset.action;
        const value = action === 'back30' ? -30 : action === 'back10' ? -10 : action === 'fwd10' ? 10 : action === 'fwd30' ? 30 : undefined;
        const map = { back30: 'seekBy', back10: 'seekBy', fwd10: 'seekBy', fwd30: 'seekBy' };
        this.emit('control', { action: map[action] || action, value });
      };
    });
    el.querySelector('#ctl-host').onclick = () => this.emit('claim-host');
  }

  // ---- State application ---------------------------------------------------
  setState(snap, { me }) {
    this.state = snap;
    if (me) this.me = me;
    this.root.querySelector('#watch-count').textContent = String(snap.participants?.length || 0);
    this.updateSeats();

    const p = snap.playback || {};
    const isHost = snap.hostId && snap.hostId === this.me?.id;
    const canControl = isHost || !p.locked || !snap.hostId;

    // Now playing + screen empty state.
    const np = this.root.querySelector('#now-playing');
    const empty = this.root.querySelector('#screen-empty');
    if (p.videoUid && this.mode !== 'private') {
      np.innerHTML = `🎬 <b>${escapeHtml(p.videoName || '')}</b> · ${p.playing ? '▶ Playing' : '⏸ Paused'} · ${fmt(p.livePosition)}`;
      empty.classList.add('hidden');
    } else if (this.mode !== 'private') {
      np.innerHTML = '';
      empty.classList.remove('hidden');
    }

    // Temp-session upload feed notice (only relevant to the shared clan movie).
    const note = this.root.querySelector('#feed-note');
    if (note) {
      if (this.mode !== 'private' && p.feedStatus === 'stalled') {
        note.textContent = '⏳ Waiting for the host’s upload… keep the host’s browser tab open.';
        note.classList.remove('hidden');
      } else {
        note.classList.add('hidden');
      }
    }

    // Controls availability.
    const toggle = this.root.querySelector('#ctl-toggle');
    if (toggle) toggle.textContent = p.playing ? '⏸' : '▶';
    const lock = this.root.querySelector('#ctl-lock');
    if (lock) lock.textContent = p.locked ? '🔒' : '🔓';
    this.root.querySelectorAll('#controls .ctl').forEach((b) => {
      const hostOnly = b.id === 'ctl-lock' || b.id === 'ctl-end';
      b.disabled = hostOnly ? !isHost : !canControl;
    });
    const hostBtn = this.root.querySelector('#ctl-host');
    if (hostBtn) hostBtn.classList.toggle('hidden', Boolean(snap.hostId));

    if (this.mode !== 'private') this.setModeBadge(snap.mode === 'clan' ? 'Clan Movie' : 'Lobby');
  }

  setMode(mode, video) {
    this.mode = mode;
    const empty = this.root.querySelector('#screen-empty');
    if (mode === 'private') {
      this.setModeBadge('Private');
      empty.classList.add('hidden');
      this.root.querySelector('#now-playing').innerHTML = video
        ? `🔒 Private: <b>${escapeHtml(video.name)}</b>`
        : '🔒 Private viewing';
    } else if (mode === 'lobby') {
      this.setModeBadge('Lobby');
    }
  }

  setModeBadge(text) {
    const el = this.root.querySelector('#mode-badge');
    if (el) el.textContent = text;
  }

  // ---- Lobby / library -----------------------------------------------------
  setLibrary(videos, categories) {
    this.library = videos;
    const lobby = this.root.querySelector('#lobby');
    const cats = ['All', ...(categories || []).map((c) => c.name)];
    lobby.innerHTML = `
      <div class="lobby-head">
        <h2>🍿 Now Showing</h2>
        <button class="btn" id="lobby-close">✕</button>
      </div>
      <div class="lobby-cats">${cats
        .map((c, i) => `<button class="chip ${i === 0 ? 'active' : ''}" data-cat="${c === 'All' ? '' : escapeAttr(c)}">${escapeHtml(c)}</button>`)
        .join('')}</div>
      <div class="grid" id="lobby-grid"></div>`;
    lobby.querySelector('#lobby-close').onclick = () => this.toggleLobby(false);
    lobby.querySelectorAll('.chip').forEach((chip) => {
      chip.onclick = () => {
        lobby.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        this.renderGrid(chip.dataset.cat);
      };
    });
    this.renderGrid('');
  }

  renderGrid(category) {
    const grid = this.root.querySelector('#lobby-grid');
    if (!grid) return;
    const list = this.library.filter((v) => !category || v.category === category);
    grid.innerHTML = list
      .map(
        (v) => `
      <div class="card" data-uid="${v.uid}">
        <div class="thumb" style="background-image:url('${v.thumbnail || ''}')">
          <span class="dur">${fmt(v.durationSeconds)}</span>
          ${v.requireSignedURLs ? '<span class="lock">🔒</span>' : ''}
        </div>
        <div class="card-body">
          <div class="card-title">${escapeHtml(v.name)}</div>
          <div class="card-cat">${escapeHtml(v.category)}</div>
          <div class="card-actions">
            <button class="btn small primary" data-act="clan" data-uid="${v.uid}">🍿 Watch Party</button>
            <button class="btn small" data-act="private" data-uid="${v.uid}">🔒 Private</button>
          </div>
        </div>
      </div>`
      )
      .join('');
    grid.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => {
        const uid = b.dataset.uid;
        if (b.dataset.act === 'clan') this.emit('pick-clan', { uid });
        else this.emit('pick-private', { uid });
        this.toggleLobby(false);
      };
    });
    // Animated GIF "moving poster" on hover (Cloudflare animated thumbnail).
    grid.querySelectorAll('.card').forEach((card) => {
      const v = this.library.find((x) => x.uid === card.dataset.uid);
      const thumb = card.querySelector('.thumb');
      if (!v?.animatedThumbnail || !thumb) return;
      card.addEventListener('mouseenter', () => (thumb.style.backgroundImage = `url('${v.animatedThumbnail}')`));
      card.addEventListener('mouseleave', () => (thumb.style.backgroundImage = `url('${v.thumbnail || ''}')`));
    });
  }

  // Cinematic "Now Showing" intro: curtains part over an animated poster + title
  // card, then fades. Triggered for everyone at once on a clan movie (via the
  // synced 'movie' room event) and locally when starting private viewing.
  showIntro(video) {
    if (!video) return;
    const el = this.root.querySelector('#intro');
    const poster = video.animatedThumbnail || video.thumbnail || '';
    el.innerHTML = `
      <div class="intro-curtain il"></div>
      <div class="intro-curtain ir"></div>
      <div class="intro-card">
        ${poster ? `<div class="intro-poster" style="background-image:url('${poster}')"></div>` : ''}
        <div class="intro-now">🎬 NOW SHOWING</div>
        <div class="intro-title">${escapeHtml(video.name)}</div>
        <div class="intro-sub">${escapeHtml(video.category || '')} · ${fmt(video.durationSeconds)}</div>
      </div>`;
    el.classList.remove('hidden');
    // reflow so the animation restarts if replayed
    void el.offsetWidth;
    el.classList.add('play');
    clearTimeout(this._introT);
    this._introT = setTimeout(() => {
      el.classList.remove('play');
      el.classList.add('hidden');
    }, 3800);
  }

  toggleLobby(force) {
    const lobby = this.root.querySelector('#lobby');
    const show = force === undefined ? lobby.classList.contains('hidden') : force;
    lobby.classList.toggle('hidden', !show);
  }

  // ---- Feedback ------------------------------------------------------------
  handleRoomEvent(ev) {
    if (!ev) return;
    if (ev.type === 'join') this.toast(`👤 ${ev.user.name} entered the theater`);
    else if (ev.type === 'leave') this.toast(`👋 ${ev.user.name} left`);
    else if (ev.type === 'item') this.toast(`${itemEmoji(ev.item)} ${ev.user.name} got ${ev.item}!`);
    else if (ev.type === 'movie') {
      const v = this.library.find((x) => x.uid === ev.video.uid) || ev.video;
      this.showIntro(v);
      this.toast(`🎬 Now playing: ${ev.video.name}`);
    } else if (ev.type === 'ended') this.toast('🎬 The movie ended');
  }

  toast(text) {
    const wrap = this.root.querySelector('#toasts');
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    wrap.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, 3200);
  }

  floatEmoji(emoji) {
    const e = document.createElement('div');
    e.className = 'float-emoji';
    e.textContent = emoji;
    e.style.left = 20 + Math.random() * 60 + '%';
    this.root.querySelector('.stage').appendChild(e);
    setTimeout(() => e.remove(), 1600);
  }

  showTapToPlay(onTap) {
    const el = this.root.querySelector('#tap-to-play');
    el.classList.remove('hidden');
    el.onclick = () => {
      el.classList.add('hidden');
      onTap();
    };
  }
}

function itemEmoji(key) {
  return ITEMS.find((i) => i.key === key)?.emoji || '🍿';
}
function escapeHtml(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s = '') {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
