// Activity main menu — the idle cinema lobby. Join with a 4-letter code, host
// a movie (opens /host upload), or walk into a party already playing in this
// voice channel. Vanilla DOM so it stays light for Discord mobile.

export function renderMainMenu(el, { snap, me, onJoinParty, onHost, onEnterCode, onExit }) {
  const playing = snap?.mode === 'clan' && snap?.playback?.videoUid;
  const host = (snap?.participants || []).find((p) => p.id === snap?.hostId);
  const inside = (snap?.participants || []).filter((p) => p.inside).length;
  const code = snap?.roomCode || null;
  const locked = Boolean(snap?.codeLocked);

  el.innerHTML = `
    <div class="menu-sky"></div>
    <div class="menu-marquee">
      <div class="menu-neon">DARKNIGHT</div>
      <div class="menu-sub">MINI THEATER</div>
      <div class="menu-lights" aria-hidden="true"></div>
    </div>

    ${
      playing
        ? `<div class="menu-now">
            <div class="menu-now-label">NOW SHOWING</div>
            <div class="menu-now-title">${esc(snap.playback.videoName || 'A movie')}</div>
            <div class="menu-now-meta">
              ${snap.playback.playing ? '▶ Playing' : '⏸ Paused'}
              · 👥 ${inside || snap.participants?.length || 0}
              ${host ? `· Host ${esc(host.name)}` : ''}
              ${code ? `· Code <b>${esc(code)}</b>` : ''}
              ${locked ? '· 🔒 Code required' : '· 🔓 Open door'}
            </div>
          </div>`
        : `<div class="menu-idle">
            <div class="menu-pop">🍿</div>
            <p>The lobby is quiet. Host a movie, or enter a party code.</p>
          </div>`
    }

    <div class="menu-actions">
      ${
        playing
          ? `<button class="menu-btn primary" data-act="join">${locked ? '🔑 Enter with Code' : '🎟️ Join the Party'}</button>`
          : ''
      }
      <button class="menu-btn" data-act="code">🔤 Enter Room Code</button>
      <button class="menu-btn host" data-act="host">📤 Host a Movie</button>
      <button class="menu-btn ghost" data-act="exit">🚪 Exit to Lobby Chill</button>
    </div>

    <div class="menu-code-panel hidden" id="menu-code-panel">
      <label>4-letter party code
        <input id="menu-code-input" maxlength="4" autocomplete="off" spellcheck="false" placeholder="ABCD" />
      </label>
      <button class="menu-btn primary" data-act="code-go">Enter</button>
      <button class="menu-btn ghost" data-act="code-cancel">Cancel</button>
    </div>

    <p class="menu-hint">Tip: hosts share the code from the top bar. Prefer H.264 + AAC MP4 for Discord. Phone says Activity not supported? App owner must enable <b>iOS + Android</b> under Developer Portal → Activities → Settings.</p>
  `;

  el.classList.remove('hidden');

  const codePanel = el.querySelector('#menu-code-panel');
  const codeInput = el.querySelector('#menu-code-input');

  el.querySelectorAll('[data-act]').forEach((btn) => {
    btn.onclick = () => {
      const act = btn.dataset.act;
      if (act === 'join') {
        if (locked) {
          codePanel.classList.remove('hidden');
          codeInput?.focus();
        } else onJoinParty?.();
      } else if (act === 'host') onHost?.();
      else if (act === 'code') {
        codePanel.classList.remove('hidden');
        codeInput.value = '';
        codeInput?.focus();
      } else if (act === 'code-go') onEnterCode?.(codeInput.value);
      else if (act === 'code-cancel') codePanel.classList.add('hidden');
      else if (act === 'exit') onExit?.();
    };
  });

  codeInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onEnterCode?.(codeInput.value);
  });
  codeInput?.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  });
}

export function hideMainMenu(el) {
  if (!el) return;
  el.classList.add('hidden');
  el.innerHTML = '';
}

function esc(s = '') {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
