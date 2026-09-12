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

const SODAS = ['Cola', 'Lemon-Lime', 'Root Beer', 'Iced Tea', 'Water'];
const POPCORN = ['Small', 'Medium', 'Large', 'Jumbo'];
const SNACKS = ['Candy', 'Nachos', 'Pretzel', 'Chocolate', 'None'];

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
    this.inside = true;
    this.library = [];
    this._joinPicks = { soda: null, popcorn: null, snacks: null, seat: null };
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
            <span class="room-code hidden" id="room-code" title="Party code"></span>
            <span class="watchers">👥 <span id="watch-count">0</span></span>
          </div>
          <div class="topbar-actions">
            <button class="btn" id="btn-menu" title="Main menu">🏠</button>
            <button class="btn" id="btn-fullscreen" title="Fullscreen">⛶</button>
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
            <div class="codec-banner hidden" id="codec-banner"></div>
              <div class="snack-overlay hidden" id="snack-overlay">
                <div class="snack-card">
                  <div class="snack-emoji">🍿🥤</div>
                  <h2>Snack Break!</h2>
                  <p>Go grab something — the show is paused. Don't miss the good part.</p>
                </div>
              </div>
              <button class="ghost-react" data-react="popcorn" title="Throw popcorn">🍿</button>
              <button class="ghost-react" data-react="cheer" title="Cheer">👏</button>
              <button class="ghost-react" data-react="boo" title="Boo (playful)">👻</button>
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
        <div class="foyer hidden" id="foyer"></div>
        <div class="join-flow hidden" id="join-flow"></div>
        <div class="intro hidden" id="intro"></div>
        <div class="main-menu hidden" id="main-menu"></div>
        <div class="toasts" id="toasts"></div>
        <div class="float-layer" id="float-layer"></div>
      </div>
    `;

    this.videoEl = this.root.querySelector('#theater-video');
    this.root.querySelector('#btn-lobby').onclick = () => this.toggleLobby();
    this.root.querySelector('#btn-menu').onclick = () => this.emit('open-menu');
    this.root.querySelector('#btn-fullscreen').onclick = () => this.toggleFullscreen();
    this.root.querySelectorAll('.ghost-react').forEach((b) => {
      b.onclick = () => {
        this.emit('react', { kind: b.dataset.react });
        this.floatReact(b.dataset.react);
      };
    });
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
    const foyer = [];
    for (const p of participants) {
      if (!p.inside) {
        foyer.push(p);
        continue;
      }
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
    const bits = [];
    if (standing.length) {
      bits.push(
        `<span class="standing-label">Finding a seat:</span>` +
          standing
            .map(
              (p) =>
                `<span class="mini" title="${escapeHtml(p.name)}"><img src="${p.avatar || ''}" onerror="this.style.opacity=0"/></span>`
            )
            .join('')
      );
    }
    if (foyer.length) {
      bits.push(
        `<span class="standing-label">Outside:</span>` +
          foyer
            .map(
              (p) =>
                `<span class="mini foyer-mini" title="${escapeHtml(p.name)} (lobby)"><img src="${p.avatar || ''}" onerror="this.style.opacity=0"/></span>`
            )
            .join('')
      );
    }
    strip.innerHTML = bits.join('<span class="standing-gap"></span>');
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
      <button class="btn ctl" id="ctl-snack">🍿 Snack break</button>
      <button class="btn ctl" id="ctl-door">🔒 Code lock</button>
      <button class="btn ctl ghost hidden" id="ctl-host">👑 Become host</button>
    `;
    el.querySelectorAll('[data-action]').forEach((b) => {
      b.onclick = () => {
        const action = b.dataset.action;
        if (action === 'lock') {
          const locked = this.state?.playback?.locked;
          this.emit('control', { action: locked ? 'unlock' : 'lock' });
          return;
        }
        const value = action === 'back30' ? -30 : action === 'back10' ? -10 : action === 'fwd10' ? 10 : action === 'fwd30' ? 30 : undefined;
        const map = { back30: 'seekBy', back10: 'seekBy', fwd10: 'seekBy', fwd30: 'seekBy' };
        this.emit('control', { action: map[action] || action, value });
      };
    });
    el.querySelector('#ctl-host').onclick = () => this.emit('claim-host');
    this.root.querySelector('#ctl-snack').onclick = () => {
      const on = !this.state?.snackBreak;
      this.emit('control', { action: 'snack', value: on });
    };
    this.root.querySelector('#ctl-door').onclick = () => {
      const on = !this.state?.codeLocked;
      this.emit('control', { action: 'codeLock', value: on });
    };
  }

  // ---- State application ---------------------------------------------------
  setState(snap, { me, inside = true }) {
    this.state = snap;
    if (me) this.me = me;
    this.inside = inside;

    const watching = (snap.participants || []).filter((p) => p.inside).length;
    this.root.querySelector('#watch-count').textContent = String(watching || snap.participants?.length || 0);

    // Party code badge
    const codeEl = this.root.querySelector('#room-code');
    if (codeEl) {
      if (snap.roomCode && snap.mode === 'clan') {
        codeEl.textContent = `🔤 ${snap.roomCode}${snap.codeLocked ? ' 🔒' : ''}`;
        codeEl.classList.remove('hidden');
      } else {
        codeEl.classList.add('hidden');
      }
    }

    // Snack break overlay
    const snack = this.root.querySelector('#snack-overlay');
    if (snack) snack.classList.toggle('hidden', !(inside && snap.snackBreak));

    this.updateSeats();

    const p = snap.playback || {};
    const isHost = snap.hostId && snap.hostId === this.me?.id;
    const canControl = inside && (isHost || !p.locked || !snap.hostId);

    // Now playing + screen empty state (only meaningful when inside).
    const np = this.root.querySelector('#now-playing');
    const empty = this.root.querySelector('#screen-empty');
    if (!inside) {
      np.innerHTML = '';
      empty.classList.add('hidden');
    } else if (p.videoUid && this.mode !== 'private') {
      np.innerHTML = `🎬 <b>${escapeHtml(p.videoName || '')}</b> · ${p.playing ? '▶ Playing' : '⏸ Paused'} · ${fmt(p.livePosition)}`;
      empty.classList.add('hidden');
    } else if (this.mode !== 'private') {
      np.innerHTML = '';
      empty.classList.remove('hidden');
    }

    // Temp-session upload feed notice (only for the shared clan movie).
    const note = this.root.querySelector('#feed-note');
    if (note) {
      if (inside && this.mode !== 'private' && p.converting && (p.feedStatus === 'streaming' || p.feedStatus === 'stalled')) {
        // MovieBox/large files: hold the black progressive URL while the host
        // finishes uploading, then build Discord HLS.
        note.textContent =
          p.feedStatus === 'stalled'
            ? '⏳ Large/MovieBox upload stalled — waiting for the host… Discord stream builds after upload finishes.'
            : '📡 Uploading MovieBox/large file… Discord playback is held until a safe HLS stream is ready (avoids the black screen).';
        note.classList.remove('hidden');
      } else if (inside && this.mode !== 'private' && p.converting) {
        note.textContent = '⚙️ Building Discord-safe HLS… first segments unlock playback soon on large files.';
        note.classList.remove('hidden');
      } else if (inside && this.mode !== 'private' && p.feedStatus === 'disconnected') {
        note.textContent = '⚠️ Host connection lost — waiting for the host…';
        note.classList.remove('hidden');
      } else if (inside && this.mode !== 'private' && p.feedStatus === 'stalled') {
        note.textContent = '⏳ Buffering — waiting for the host’s upload…';
        note.classList.remove('hidden');
      } else if (inside && this.mode !== 'private' && p.feedStatus === 'streaming') {
        note.textContent = '📡 Streaming while the host uploads…';
        note.classList.remove('hidden');
      } else {
        note.classList.add('hidden');
      }
    }

    // Codec / black-screen guidance from server probe (MovieBox HEVC, AC-3, etc.).
    // While converting, prefer the converting message — never leave a sticky fatal banner.
    if (inside && this.mode !== 'private' && p.converting) {
      this._localDecodeFail = false;
      this.showCodecBanner(
        p.codecTip ||
          (p.feedStatus === 'streaming' || p.feedStatus === 'stalled'
            ? 'Uploading MovieBox/large file… Discord stream builds after upload (black screen avoided). Keep the host tab open.'
            : 'Building Discord-safe HLS… keep the host tab open.')
      );
    } else if (inside && this.mode !== 'private' && p.codecTip) {
      this.showCodecBanner(p.codecTip);
    } else if (!this._localDecodeFail) {
      this.hideCodecBanner();
    } else if (inside && this.mode !== 'private' && p.webPlayable && !p.converting) {
      // Convert finished — clear any decode-fail left over from the original file.
      this.hideCodecBanner();
    }

    // Controls availability.
    const toggle = this.root.querySelector('#ctl-toggle');
    if (toggle) toggle.textContent = p.playing ? '⏸' : '▶';
    const lock = this.root.querySelector('#ctl-lock');
    if (lock) lock.textContent = p.locked ? '🔒' : '🔓';
    this.root.querySelectorAll('#controls .ctl').forEach((b) => {
      const hostOnly = b.id === 'ctl-lock' || b.id === 'ctl-end' || b.id === 'ctl-snack' || b.id === 'ctl-door';
      b.disabled = hostOnly ? !isHost : !canControl;
    });
    const hostBtn = this.root.querySelector('#ctl-host');
    if (hostBtn) hostBtn.classList.toggle('hidden', Boolean(snap.hostId) || !inside);

    // Hide theater chrome while outside — foyer owns the screen.
    const chromeHidden = !inside && snap.mode === 'clan' && Boolean(p.videoUid);
    this.root.querySelector('#controls')?.classList.toggle('hidden', chromeHidden);
    this.root.querySelector('.floor')?.classList.toggle('hidden', chromeHidden);
    this.root.querySelector('#social')?.classList.toggle('hidden', chromeHidden);
    this.root.querySelector('.screen-wrap')?.classList.toggle('hidden', chromeHidden);
    this.root.querySelector('#btn-lobby')?.classList.toggle('hidden', chromeHidden);

    if (this.mode !== 'private') {
      if (!inside && snap.mode === 'clan' && p.videoUid) this.setModeBadge('Outside');
      else this.setModeBadge(snap.mode === 'clan' ? 'Clan Movie' : 'Lobby');
    }
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

  // ---- Foyer (theater outside) ---------------------------------------------
  showFoyer(snap) {
    const foyer = this.root.querySelector('#foyer');
    const joinFlow = this.root.querySelector('#join-flow');
    if (!foyer) return;
    // Don't wipe / restart if the viewer is mid join ritual.
    if (joinFlow && !joinFlow.classList.contains('hidden')) {
      this._foyerSnap = snap;
      return;
    }
    this._foyerSnap = snap;
    const p = snap.playback || {};
    const host = (snap.participants || []).find((x) => x.id === snap.hostId);
    const insideCount = (snap.participants || []).filter((x) => x.inside).length;
    const outsideCount = (snap.participants || []).filter((x) => !x.inside).length;

    // Prefer preferred seat from /join if the server already assigned one.
    const meP = (snap.participants || []).find((x) => x.id === this.me?.id);
    if (meP?.seat != null && this._joinPicks.seat == null) this._joinPicks.seat = meP.seat;

    if (snap.codeLocked && meP && !meP.codeOk && snap.hostId !== this.me?.id) {
      foyer.innerHTML = `
        <div class="foyer-sky"></div>
        <div class="foyer-marquee">
          <div class="foyer-title">DARKNIGHT CINEMA</div>
          <div class="foyer-now">DOOR LOCKED</div>
          <div class="foyer-movie">${escapeHtml(p.videoName || 'A movie')}</div>
          <div class="foyer-meta">Code <b>${escapeHtml(snap.roomCode || '????')}</b> required · ask the host</div>
        </div>
        <p class="foyer-copy">Hit 🏠 and use <b>Enter Room Code</b> with the host’s 4-letter code.</p>
        <button class="btn foyer-enter" id="foyer-menu">🏠 Open Menu</button>
      `;
      foyer.classList.remove('hidden');
      foyer.querySelector('#foyer-menu').onclick = () => this.emit('open-menu');
      return;
    }

    foyer.innerHTML = `
      <div class="foyer-sky"></div>
      <div class="foyer-marquee">
        <div class="foyer-lights"></div>
        <div class="foyer-title">DARKNIGHT CINEMA</div>
        <div class="foyer-now">NOW SHOWING</div>
        <div class="foyer-movie">${escapeHtml(p.videoName || 'A movie')}</div>
        <div class="foyer-meta">
          ${p.playing ? '▶ In progress' : '⏸ Paused'}
          · 👥 ${insideCount} inside
          ${outsideCount ? `· ${outsideCount} outside` : ''}
          ${host ? `· Host ${escapeHtml(host.name)}` : ''}
        </div>
      </div>
      <div class="foyer-doors">
        <div class="foyer-door left"></div>
        <div class="foyer-door right"></div>
      </div>
      <p class="foyer-copy">You're outside the theater. Enter to grab concessions, pick a seat, and join wherever the movie is.</p>
      <button class="btn foyer-enter" id="foyer-enter">🎟️ Enter Theater</button>
    `;
    foyer.classList.remove('hidden');
    foyer.querySelector('#foyer-enter').onclick = () => this.startJoinFlow(this._foyerSnap || snap);
  }

  hideFoyer() {
    const foyer = this.root.querySelector('#foyer');
    if (foyer) {
      foyer.classList.add('hidden');
      foyer.innerHTML = '';
    }
    this.hideJoinFlow();
  }

  // ---- In-Activity /join ritual --------------------------------------------
  startJoinFlow(snap) {
    this._joinPicks = {
      soda: this._joinPicks.soda,
      popcorn: this._joinPicks.popcorn,
      snacks: this._joinPicks.snacks,
      seat: this._joinPicks.seat,
    };
    this.renderJoinStep('arrival', snap);
  }

  hideJoinFlow() {
    const el = this.root.querySelector('#join-flow');
    if (el) {
      el.classList.add('hidden');
      el.innerHTML = '';
    }
  }

  renderJoinStep(step, snap) {
    const el = this.root.querySelector('#join-flow');
    const movie = snap?.playback?.videoName || 'the movie';
    const picks = this._joinPicks;
    el.classList.remove('hidden');

    const seatLabel = (i) => `Row ${String.fromCharCode(65 + Math.floor(i / 6))} · Seat ${(i % 6) + 1}`;

    if (step === 'arrival') {
      el.innerHTML = `
        <div class="join-card join-arrival">
          <div class="join-curtains" aria-hidden="true">
            <div class="join-curtain jl"></div>
            <div class="join-curtain jr"></div>
          </div>
          <div class="join-body">
            <div class="join-kicker">Welcome</div>
            <h2>🎟️ ${escapeHtml(movie)}</h2>
            <p>Grab your concessions before you take a seat.</p>
            <button class="btn primary" id="join-next">🍿 Get Concessions</button>
          </div>
        </div>`;
      requestAnimationFrame(() => el.querySelector('.join-card')?.classList.add('open'));
      el.querySelector('#join-next').onclick = () => this.renderJoinStep('concessions', snap);
      return;
    }

    if (step === 'concessions') {
      el.innerHTML = `
        <div class="join-card">
          <div class="join-body">
            <div class="join-kicker">Concession Stand</div>
            <h2>🍿 What's your order?</h2>
            <label class="join-field">🥤 Soda
              <select id="pick-soda">${SODAS.map((x) => `<option ${picks.soda === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
            </label>
            <label class="join-field">🍿 Popcorn
              <select id="pick-popcorn">${POPCORN.map((x) => `<option ${picks.popcorn === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
            </label>
            <label class="join-field">🍫 Snack
              <select id="pick-snacks">${SNACKS.map((x) => `<option ${picks.snacks === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
            </label>
            <button class="btn primary" id="join-next">🎟️ Continue</button>
          </div>
        </div>`;
      el.querySelector('#join-next').onclick = () => {
        picks.soda = el.querySelector('#pick-soda').value;
        picks.popcorn = el.querySelector('#pick-popcorn').value;
        picks.snacks = el.querySelector('#pick-snacks').value;
        this.renderJoinStep('seat', snap);
      };
      return;
    }

    if (step === 'seat') {
      const taken = new Set(
        (snap.participants || []).filter((p) => p.inside && p.seat != null).map((p) => p.seat)
      );
      const options = Array.from({ length: SEAT_COUNT }, (_, i) => {
        const busy = taken.has(i) && picks.seat !== i;
        return `<option value="${i}" ${picks.seat === i ? 'selected' : ''} ${busy ? 'disabled' : ''}>${seatLabel(i)}${busy ? ' (taken)' : ''}</option>`;
      }).join('');
      el.innerHTML = `
        <div class="join-card">
          <div class="join-body">
            <div class="join-kicker">Find your seat</div>
            <h2>🪑 Pick a seat</h2>
            <label class="join-field">Seat
              <select id="pick-seat">${options}</select>
            </label>
            <button class="btn primary" id="join-next">🪑 Take your seat</button>
          </div>
        </div>`;
      el.querySelector('#join-next').onclick = () => {
        picks.seat = Number(el.querySelector('#pick-seat').value);
        this.renderJoinStep('ready', snap);
      };
      return;
    }

    // ready — throw popcorn optional, then enter and sync to live position
    const order = `🥤 ${picks.soda || '—'} · 🍿 ${picks.popcorn || '—'} · 🍫 ${picks.snacks || 'None'} · 🪑 ${seatLabel(picks.seat ?? 0)}`;
    el.innerHTML = `
      <div class="join-card">
        <div class="join-body">
          <div class="join-kicker">You're seated</div>
          <h2>🍿 Enjoy the show</h2>
          <p class="join-order">${escapeHtml(order)}</p>
          <p>When you enter, you'll join the movie wherever it is right now.</p>
          <div class="join-actions">
            <button class="btn" id="join-throw">🍿 Throw Popcorn</button>
            <button class="btn primary" id="join-watch">🎬 Watch Movie</button>
          </div>
        </div>
      </div>`;
    el.querySelector('#join-throw').onclick = () => {
      this.floatEmoji('🍿');
      this.toast('🍿 Popcorn away!');
    };
    el.querySelector('#join-watch').onclick = () => {
      const items = [];
      if (picks.popcorn) items.push('popcorn');
      if (picks.soda) items.push('soda');
      if (picks.snacks && picks.snacks !== 'None') items.push('candy');
      this.emit('enter-theater', { seat: picks.seat ?? 0, items });
      this.hideJoinFlow();
      this.showIntro({
        name: movie,
        category: 'Joining mid-show',
        durationSeconds: Math.round(snap?.playback?.livePosition || 0),
        thumbnail: '',
      });
    };
  }

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
    if (ev.type === 'join') {
      this.toast(ev.user.inside ? `🎟️ ${ev.user.name} entered the theater` : `👤 ${ev.user.name} arrived outside`);
    } else if (ev.type === 'enter') this.toast(`🎟️ ${ev.user.name} entered the theater`);
    else if (ev.type === 'leave') this.toast(`👋 ${ev.user.name} left`);
    else if (ev.type === 'item') this.toast(`${itemEmoji(ev.item)} ${ev.user.name} got ${ev.item}!`);
    else if (ev.type === 'movie') {
      if (this.inside) {
        const v = this.library.find((x) => x.uid === ev.video.uid) || ev.video;
        this.showIntro(v);
      }
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
    el.textContent = '▶ Tap to start';
    el.classList.remove('hidden');
    el.onclick = async () => {
      // Keep the overlay until play() actually paints frames — otherwise users
      // get a black screen with no way to retry.
      el.textContent = '⏳ Starting…';
      let ok = false;
      try {
        ok = await onTap();
      } catch {
        ok = false;
      }
      if (ok) el.classList.add('hidden');
      else el.classList.remove('hidden');
      el.textContent = '▶ Tap to start';
    };
  }

  hideTapToPlay() {
    const el = this.root.querySelector('#tap-to-play');
    if (!el) return;
    el.classList.add('hidden');
    el.textContent = '▶ Tap to start';
    el.onclick = null;
  }

  showTapToUnmute(onTap) {
    const el = this.root.querySelector('#tap-to-play');
    el.textContent = '🔊 Tap for sound';
    el.classList.remove('hidden');
    el.onclick = () => {
      el.classList.add('hidden');
      el.textContent = '▶ Tap to start';
      onTap();
    };
  }

  showCodecBanner(text) {
    const el = this.root.querySelector('#codec-banner');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
  }

  hideCodecBanner() {
    const el = this.root.querySelector('#codec-banner');
    if (!el) return;
    el.classList.add('hidden');
    el.textContent = '';
    this._localDecodeFail = false;
  }

  showDecodeFail(detail) {
    this._localDecodeFail = true;
    this.showCodecBanner(
      detail ||
        'Black screen: Discord can’t decode this file. Use MP4 H.264 + AAC (even size like 1920×1080). HandBrake “Fast 1080p30”.'
    );
  }

  // ---- Main menu / cinema chrome ------------------------------------------
  showMainMenu(handlers) {
    const { renderMainMenu } = handlers;
    const el = this.root.querySelector('#main-menu');
    if (!el || !renderMainMenu) return;
    renderMainMenu(el, {
      snap: this.state,
      me: this.me,
      onJoinParty: () => handlers.onJoinParty?.(),
      onHost: () => handlers.onHost?.(),
      onEnterCode: (code) => handlers.onEnterCode?.(code),
      onExit: () => handlers.onExit?.(),
    });
  }

  hideMainMenu() {
    const el = this.root.querySelector('#main-menu');
    if (!el) return;
    el.classList.add('hidden');
    el.innerHTML = '';
  }

  toggleFullscreen() {
    const frame = this.root.querySelector('.screen') || this.root.querySelector('#theater-video')?.parentElement;
    if (!frame) return;
    if (!document.fullscreenElement) {
      frame.requestFullscreen?.().catch(() => this.toast('Fullscreen not available in this Discord client'));
    } else {
      document.exitFullscreen?.();
    }
  }

  floatReact(kind) {
    const map = { popcorn: '🍿', cheer: '👏', boo: '👻' };
    const emoji = map[kind] || '✨';
    const layer = this.root.querySelector('#float-layer') || this.root.querySelector('.stage');
    const e = document.createElement('div');
    e.className = 'float-react';
    e.textContent = emoji;
    e.style.left = 15 + Math.random() * 70 + '%';
    e.style.bottom = '12%';
    layer.appendChild(e);
    setTimeout(() => e.remove(), 1800);
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
