/**
 * Concession mini-games (Phaser 4) — docked mini-window while the movie plays.
 *
 *  🥤 Catch Soda    — move the cup; catch matching color, avoid wrong cans
 *  🍿 Catch Popcorn — move the bag; catch kernels, dodge soda spills
 */

import Phaser from 'phaser';
import { prefs } from './prefs.js';

const FLAVORS = [
  { key: 'cola', hex: 0xc0392b, label: 'Cola' },
  { key: 'lime', hex: 0x27ae60, label: 'Lime' },
  { key: 'blue', hex: 0x2980b9, label: 'Blue Ice' },
  { key: 'orange', hex: 0xe67e22, label: 'Orange' },
  { key: 'grape', hex: 0x8e44ad, label: 'Grape' },
];

const MODE_INFO = {
  soda: {
    title: 'Fill the Soda',
    hint: 'Catch the matching color can — wrong flavors splash you!',
    emoji: '🥤',
  },
  popcorn: {
    title: 'Fill the Popcorn',
    hint: 'Catch kernels 🍿 — dodge the soda spills!',
    emoji: '🍿',
  },
};

const pick = (arr) => arr[(Math.random() * arr.length) | 0];

class CatchScene extends Phaser.Scene {
  constructor() {
    super('catch');
  }

  init(data = {}) {
    this.mode = data.mode === 'popcorn' ? 'popcorn' : 'soda';
    this.target = data.target || pick(FLAVORS);
    this.onScore = data.onScore || (() => {});
    this.onFill = data.onFill || (() => {});
    this.onOver = data.onOver || (() => {});
  }

  create() {
    const W = this.scale.width;
    const H = this.scale.height;
    this.score = 0;
    this.lives = 3;
    this.fill = 0;
    this.needed = 8;
    this.fallSpeed = 150;
    this.alive = true;
    this.paddleHalf = this.mode === 'soda' ? 28 : 34;

    this.cameras.main.setBackgroundColor('#0a0a12');

    for (let i = 0; i < 14; i++) {
      const dot = this.add.circle(
        Phaser.Math.Between(8, W - 8),
        Phaser.Math.Between(50, H - 90),
        Phaser.Math.Between(1, 2),
        0xc9a227,
        0.4
      );
      this.tweens.add({
        targets: dot,
        alpha: { from: 0.15, to: 0.7 },
        duration: 700 + Math.random() * 1400,
        yoyo: true,
        repeat: -1,
      });
    }

    this.add.rectangle(W / 2, H - 16, W, 32, 0x1a1210).setDepth(1);

    const info = MODE_INFO[this.mode];
    this.titleText = this.add
      .text(W / 2, 14, `${info.emoji} Catch ${this.target.label}!`, {
        fontFamily: 'system-ui,sans-serif',
        fontSize: '14px',
        color: '#ffd66b',
        fontStyle: 'bold',
      })
      .setOrigin(0.5, 0)
      .setDepth(8);

    this.hud = this.add
      .text(8, 8, '', {
        fontFamily: 'system-ui,sans-serif',
        fontSize: '11px',
        color: '#e8e8f0',
      })
      .setDepth(8);

    this.add.rectangle(W / 2, 40, W - 20, 8, 0x222230).setDepth(8);
    this.fillBar = this.add
      .rectangle(10, 40, 4, 8, this.target.hex)
      .setOrigin(0, 0.5)
      .setDepth(9);

    this.paddle = this.add.container(W / 2, H - 46).setDepth(5);
    if (this.mode === 'soda') {
      const cup = this.add.rectangle(0, 0, 52, 38, 0xf4f4f4);
      this.stripe = this.add.rectangle(0, -6, 52, 8, this.target.hex);
      const rim = this.add.rectangle(0, -20, 56, 5, 0xdddddd);
      this.straw = this.add.rectangle(12, -32, 4, 20, this.target.hex);
      this.paddle.add([cup, this.stripe, rim, this.straw]);
    } else {
      const bag = this.add.rectangle(0, 4, 62, 42, 0xc0392b);
      const s1 = this.add.rectangle(-16, 4, 9, 42, 0xffffff);
      const s2 = this.add.rectangle(0, 4, 9, 42, 0xffffff);
      const s3 = this.add.rectangle(16, 4, 9, 42, 0xffffff);
      const top = this.add.rectangle(0, -20, 68, 9, 0xffffff);
      this.paddle.add([bag, s1, s2, s3, top]);
    }

    this.falling = this.add.group();
    this.cursors = this.input.keyboard?.createCursorKeys();
    this.wasd = this.input.keyboard?.addKeys({
      A: Phaser.Input.Keyboard.KeyCodes.A,
      D: Phaser.Input.Keyboard.KeyCodes.D,
    });

    this.input.on('pointermove', (p) => {
      if (!this.alive) return;
      this.paddle.x = Phaser.Math.Clamp(p.x, 28, W - 28);
    });

    this.spawnTimer = this.time.addEvent({
      delay: 850,
      loop: true,
      callback: () => this.spawnFalling(),
    });

    this.time.addEvent({
      delay: 7000,
      loop: true,
      callback: () => {
        this.fallSpeed = Math.min(340, this.fallSpeed + 16);
        if (this.spawnTimer) {
          this.spawnTimer.delay = Math.max(360, this.spawnTimer.delay - 35);
        }
      },
    });

    this.refreshHud();
  }

  spawnFalling() {
    if (!this.alive) return;
    const W = this.scale.width;
    const x = Phaser.Math.Between(26, W - 26);
    let item;

    if (this.mode === 'popcorn') {
      if (Math.random() < 0.72) {
        item = this.add.circle(x, -16, 9, 0xffeaa7).setStrokeStyle(2, 0xd4a017);
        item.setData('good', true);
      } else {
        item = this.add.circle(x, -16, 11, 0x3498db).setAlpha(0.9);
        item.setData('good', false);
      }
    } else {
      const flavor = Math.random() < 0.48 ? this.target : pick(FLAVORS);
      item = this.add.rectangle(x, -16, 20, 32, flavor.hex).setStrokeStyle(2, 0xffffff);
      item.setData('good', flavor.key === this.target.key);
      item.setData('flavor', flavor);
    }

    item.setData('vy', this.fallSpeed + Phaser.Math.Between(-15, 35));
    item.setDepth(4);
    this.falling.add(item);
  }

  refreshHud() {
    this.hud.setText(`⭐ ${this.score}   ❤️ ${this.lives}   Fill ${this.fill}/${this.needed}`);
    const pct = Math.min(1, this.fill / this.needed);
    this.fillBar.width = Math.max(4, (this.scale.width - 20) * pct);
  }

  burst(x, y, color) {
    const c = this.add.circle(x, y, 6, color, 0.9).setDepth(10);
    this.tweens.add({
      targets: c,
      scale: 2.8,
      alpha: 0,
      duration: 260,
      onComplete: () => c.destroy(),
    });
  }

  hitGood(item) {
    this.score += 10;
    this.fill += 1;
    this.onScore(this.score);
    this.burst(item.x, item.y, 0xffd66b);
    this.refreshHud();
    if (this.fill >= this.needed) this.levelUp();
  }

  hitBad(item) {
    this.lives -= 1;
    this.cameras.main.shake(110, 0.012);
    this.burst(item.x, item.y, 0xff6b6b);
    this.refreshHud();
    if (this.lives <= 0) this.gameOver();
  }

  levelUp() {
    this.fill = 0;
    this.needed = Math.min(14, this.needed + 2);
    this.target = pick(FLAVORS);
    const info = MODE_INFO[this.mode];
    this.titleText.setText(`${info.emoji} Catch ${this.target.label}!`);
    this.fillBar.setFillStyle(this.target.hex);
    if (this.mode === 'soda') {
      this.stripe?.setFillStyle(this.target.hex);
      this.straw?.setFillStyle(this.target.hex);
    }
    this.onFill(this.target);
    this.refreshHud();
    this.flash(`New flavor: ${this.target.label}!`);
  }

  flash(msg) {
    const t = this.add
      .text(this.scale.width / 2, this.scale.height / 2 - 36, msg, {
        fontFamily: 'system-ui,sans-serif',
        fontSize: '15px',
        color: '#ffd66b',
        backgroundColor: '#00000099',
        padding: { x: 8, y: 5 },
      })
      .setOrigin(0.5)
      .setDepth(20);
    this.tweens.add({
      targets: t,
      y: t.y - 28,
      alpha: 0,
      duration: 900,
      onComplete: () => t.destroy(),
    });
  }

  gameOver() {
    if (!this.alive) return;
    this.alive = false;
    const best = prefs.setConcessionBest(this.score);
    this.onOver(this.score, best);
    this.add
      .rectangle(this.scale.width / 2, this.scale.height / 2, this.scale.width, this.scale.height, 0x000000, 0.55)
      .setDepth(30);
    this.add
      .text(
        this.scale.width / 2,
        this.scale.height / 2,
        `Spill!\nScore ${this.score}\nBest ${best}\n\nHit ↻ Replay`,
        {
          fontFamily: 'system-ui,sans-serif',
          fontSize: '16px',
          color: '#ffffff',
          align: 'center',
        }
      )
      .setOrigin(0.5)
      .setDepth(31);
  }

  update(_time, dt) {
    if (!this.alive) return;
    const W = this.scale.width;
    let dx = 0;
    if (this.cursors?.left.isDown || this.wasd?.A.isDown) dx -= 1;
    if (this.cursors?.right.isDown || this.wasd?.D.isDown) dx += 1;
    if (dx) {
      this.paddle.x = Phaser.Math.Clamp(this.paddle.x + dx * 0.34 * dt, 28, W - 28);
    }

    const py = this.paddle.y - 8;
    for (const item of [...this.falling.getChildren()]) {
      item.y += (item.getData('vy') * dt) / 1000;
      if (item.y > py - 16 && item.y < py + 16 && Math.abs(item.x - this.paddle.x) < this.paddleHalf) {
        if (item.getData('good')) this.hitGood(item);
        else this.hitBad(item);
        item.destroy();
        continue;
      }
      if (item.y > this.scale.height + 24) {
        if (item.getData('good') && this.mode === 'soda') {
          this.score = Math.max(0, this.score - 2);
          this.onScore(this.score);
          this.refreshHud();
        }
        item.destroy();
      }
    }
  }
}

/**
 * Open the concession mini-window inside hostEl.
 * @returns {{ destroy: Function }}
 */
export async function openConcession(hostEl, { mode = 'soda', onClose } = {}) {
  hostEl.classList.remove('hidden');
  hostEl.innerHTML = `
    <div class="conc-panel">
      <header class="conc-head">
        <div class="conc-title">🍿 Concession</div>
        <div class="conc-actions">
          <button type="button" class="btn conc-mode" data-mode="soda" title="Soda catch">🥤</button>
          <button type="button" class="btn conc-mode" data-mode="popcorn" title="Popcorn catch">🍿</button>
          <button type="button" class="btn" id="conc-close" title="Close">✕</button>
        </div>
      </header>
      <p class="conc-hint" id="conc-hint"></p>
      <div class="conc-canvas" id="conc-canvas"></div>
      <div class="conc-foot">
        <span id="conc-score">⭐ 0</span>
        <span id="conc-best">🏆 Best ${prefs.concessionBest}</span>
        <button type="button" class="btn" id="conc-replay">↻ Replay</button>
      </div>
    </div>
  `;

  let currentMode = mode;
  let game = null;

  const scoreEl = hostEl.querySelector('#conc-score');
  const bestEl = hostEl.querySelector('#conc-best');
  const hintEl = hostEl.querySelector('#conc-hint');
  const canvas = hostEl.querySelector('#conc-canvas');

  function start(m) {
    currentMode = m === 'popcorn' ? 'popcorn' : 'soda';
    hintEl.textContent = MODE_INFO[currentMode].hint;
    hostEl.querySelectorAll('.conc-mode').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === currentMode);
    });
    if (game) {
      game.destroy(true);
      game = null;
    }
    canvas.innerHTML = '';
    scoreEl.textContent = '⭐ 0';

    game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: canvas,
      width: 320,
      height: 400,
      backgroundColor: '#0a0a12',
      banner: false,
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
        width: 320,
        height: 400,
      },
      scene: [],
      input: { activePointers: 2 },
    });
    game.scene.add('catch', CatchScene, true, {
      mode: currentMode,
      target: pick(FLAVORS),
      onScore: (score) => {
        scoreEl.textContent = `⭐ ${score}`;
      },
      onFill: (t) => {
        hintEl.textContent = `Now catch ${t.label}! ${MODE_INFO[currentMode].hint}`;
      },
      onOver: (score, best) => {
        scoreEl.textContent = `⭐ ${score}`;
        bestEl.textContent = `🏆 Best ${best}`;
      },
    });
  }

  hostEl.querySelector('#conc-close').onclick = () => {
    destroy();
    onClose?.();
  };
  hostEl.querySelector('#conc-replay').onclick = () => start(currentMode);
  hostEl.querySelectorAll('.conc-mode').forEach((b) => {
    b.onclick = () => start(b.dataset.mode);
  });

  start(currentMode);

  function destroy() {
    if (game) {
      game.destroy(true);
      game = null;
    }
    hostEl.classList.add('hidden');
    hostEl.innerHTML = '';
  }

  return { destroy };
}
