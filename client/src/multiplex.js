import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Immersive Cinema Multiplex explore (CC0 GLB).
// ONE authoritative <video> → VideoTexture + Web Audio spatialization.
// Mini patron, WASD walk + arrow look, bottom menubar, mobile joystick.

const MODEL_URL = '/models/cinema-multiplex.glb';
const SPEED = 3.4;
const EYE_FP = 1.48;
const EYE_SIT = 1.12;
const REF_DIST = 3;
const MAX_AUDIBLE = 34;
const VOL_SMOOTH = 5;
const RADIUS = 0.24; // slim enough to walk row aisles between seats
const TP_BACK = 2.8;
const TP_HEIGHT = 1.45;

/** Shared Web Audio graph — createMediaElementSource once per <video>. */
let sharedAudio = null;

function wireAudioGraph(audio, spatial) {
  if (!audio) return;
  for (const node of [audio.source, audio.panner, audio.filter, audio.master]) {
    try {
      node?.disconnect();
    } catch {
      /* ignore */
    }
  }
  if (spatial) {
    audio.source.connect(audio.panner);
    audio.panner.connect(audio.filter);
    audio.filter.connect(audio.master);
    audio.master.connect(audio.ctx.destination);
    audio.spatial = true;
  } else {
    audio.source.connect(audio.master);
    audio.master.connect(audio.ctx.destination);
    audio.spatial = false;
    try {
      audio.master.gain.setTargetAtTime(1, audio.ctx.currentTime, 0.02);
      if (audio.filter) audio.filter.frequency.value = 22050;
    } catch {
      /* ignore */
    }
  }
}

function getSharedAudio(videoEl) {
  if (sharedAudio?.video === videoEl) return sharedAudio;
  if (sharedAudio) {
    try {
      sharedAudio.ctx.close();
    } catch {
      /* ignore */
    }
    sharedAudio = null;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || !videoEl) return null;
  try {
    const ctx = new AC();
    const source = ctx.createMediaElementSource(videoEl);
    const panner = ctx.createPanner();
    // Cinema-style: sound projects from the screen toward the seats.
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = REF_DIST;
    panner.maxDistance = MAX_AUDIBLE;
    panner.rolloffFactor = 1.05;
    panner.coneInnerAngle = 140;
    panner.coneOuterAngle = 260;
    panner.coneOuterGain = 0.28;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 18000;
    filter.Q.value = 0.7;
    const master = ctx.createGain();
    master.gain.value = 1;
    sharedAudio = {
      ctx,
      source,
      panner,
      filter,
      master,
      video: videoEl,
      unlocked: false,
      spatial: false,
    };
    wireAudioGraph(sharedAudio, false);
    return sharedAudio;
  } catch (err) {
    console.warn('spatial audio init failed', err);
    return null;
  }
}

/** Stylized theater-goer (procedural — no extra assets). */
function createMiniPatron(accent = 0xc9a227) {
  const root = new THREE.Group();
  root.name = 'mini-patron';

  const jacket = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.55, metalness: 0.12 });
  const pants = new THREE.MeshStandardMaterial({ color: 0x1a1520, roughness: 0.7 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xe8c4a8, roughness: 0.65 });
  const shoe = new THREE.MeshStandardMaterial({ color: 0x2a2030, roughness: 0.8 });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.42, 5, 10), jacket);
  body.position.y = 0.95;
  root.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), skin);
  head.position.y = 1.42;
  root.add(head);

  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), new THREE.MeshStandardMaterial({ color: 0x2a1a12 }));
  hair.position.y = 1.48;
  root.add(hair);

  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.28, 4, 8), pants);
    leg.position.set(side * 0.12, 0.38, 0);
    leg.name = side < 0 ? 'legL' : 'legR';
    root.add(leg);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.08, 0.26), shoe);
    boot.position.set(side * 0.12, 0.05, 0.04);
    root.add(boot);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.28, 4, 8), jacket);
    arm.position.set(side * 0.32, 1.0, 0);
    arm.rotation.z = side * 0.18;
    arm.name = side < 0 ? 'armL' : 'armR';
    root.add(arm);
  }

  // Tiny popcorn tub — theater personality
  const tub = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.06, 0.14, 10),
    new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.45 })
  );
  tub.position.set(0.38, 0.85, 0.12);
  root.add(tub);
  const pop = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshStandardMaterial({ color: 0xffe08a }));
  pop.position.set(0.38, 0.95, 0.12);
  root.add(pop);

  root.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
    }
  });
  return root;
}

export async function openMultiplex(
  hostEl,
  {
    participants = [],
    meId = null,
    videoEl = null,
    posterUrl = null,
    movieTitle = '',
    onClose,
    onWatch,
    onAudioUnlock,
  } = {}
) {
  hostEl.classList.remove('hidden');
  hostEl.innerHTML = `
    <div class="multiplex">
      <canvas class="multiplex-canvas" id="mx-canvas"></canvas>
      <div class="multiplex-top" id="mx-top">
        <div class="multiplex-title">🎬 Multiplex</div>
        <div class="multiplex-status" id="mx-status">
          <span id="mx-movie-flag">🎬 Movie Playing</span>
          <button type="button" class="mx-audio-flag" id="mx-audio-flag">🔇 Enable audio</button>
        </div>
        <div class="multiplex-hint" id="mx-hint"></div>
        <div class="multiplex-people" id="mx-people"></div>
      </div>
      <nav class="mx-menubar" id="mx-menubar" aria-label="Multiplex menu">
        <button type="button" class="mx-mb-item" id="mx-view" title="First / third person"><span>👁</span><em>View</em></button>
        <button type="button" class="mx-mb-item" id="mx-dim" title="Dim house lights"><span>💡</span><em>Lights</em></button>
        <button type="button" class="mx-mb-item" id="mx-vol-toggle" title="Volume"><span>🔊</span><em>Volume</em></button>
        <button type="button" class="mx-mb-item" id="mx-seats" title="Seat map"><span>🪑</span><em>Seats</em></button>
        <button type="button" class="mx-mb-item mx-mb-primary" id="mx-watch" title="Watch movie"><span>▶</span><em>Watch</em></button>
        <button type="button" class="mx-mb-item" id="mx-exit" title="Exit multiplex"><span>🚪</span><em>Exit</em></button>
      </nav>
      <div class="multiplex-vol hidden" id="mx-vol">
        <label>Theater volume <input type="range" id="mx-vol-slider" min="0" max="200" value="100" /></label>
        <span id="mx-vol-val">100%</span>
      </div>
      <div class="multiplex-touch" id="mx-touch" aria-hidden="true">
        <div class="mx-stick" id="mx-stick"><div class="mx-knob" id="mx-knob"></div></div>
        <div class="mx-lookzone" id="mx-lookzone"></div>
      </div>
      <div class="multiplex-seatmap hidden" id="mx-seatmap">
        <div class="mx-seatmap-head">
          <strong>Pick a seat · sit & watch</strong>
          <button type="button" class="btn" id="mx-seatmap-close">✕</button>
        </div>
        <div class="mx-screen-label">SCREEN</div>
        <div class="mx-seat-grid" id="mx-seat-grid"></div>
        <p class="mx-seat-hint">Tap a seat to sit facing the movie · Esc / ✕ closes</p>
      </div>
    </div>
  `;

  const canvas = hostEl.querySelector('#mx-canvas');
  const peopleEl = hostEl.querySelector('#mx-people');
  const audioFlag = hostEl.querySelector('#mx-audio-flag');
  const volPanel = hostEl.querySelector('#mx-vol');
  const volSlider = hostEl.querySelector('#mx-vol-slider');
  const volVal = hostEl.querySelector('#mx-vol-val');
  const viewBtn = hostEl.querySelector('#mx-view');
  const watchBtn = hostEl.querySelector('#mx-watch');
  const menubar = hostEl.querySelector('#mx-menubar');

  const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  hostEl.querySelector('#mx-touch').classList.toggle('show', isTouch);
  const walkHint = isTouch
    ? 'Joystick walks · drag right side to look'
    : 'WASD walk · ←→↑↓ look · drag canvas · Esc frees cursor';
  hostEl.querySelector('#mx-hint').textContent = walkHint;
  if (movieTitle) {
    hostEl.querySelector('#mx-movie-flag').textContent = `🎬 ${movieTitle}`;
  }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(hostEl.clientWidth, hostEl.clientHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0810);
  scene.fog = new THREE.Fog(0x0a0810, 22, 48);

  const camera = new THREE.PerspectiveCamera(70, hostEl.clientWidth / Math.max(hostEl.clientHeight, 1), 0.08, 80);

  const hemi = new THREE.HemisphereLight(0xffe6c8, 0x1a1018, 0.85);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff0d8, 0.9);
  key.position.set(-2, 8, 2);
  scene.add(key);
  const fill = new THREE.PointLight(0xc9a227, 12, 28);
  fill.position.set(-2, 3.2, 0);
  scene.add(fill);
  let dimmed = false;

  const screenGlow = new THREE.PointLight(0xffffff, 0, 18);
  screenGlow.position.set(-13.2, 2.1, -1);
  scene.add(screenGlow);

  // ---- Player root (feet) + mini character + camera pivot ----
  const playerRoot = new THREE.Group();
  playerRoot.position.set(-9.2, 0, 0);
  scene.add(playerRoot);

  const character = createMiniPatron(0xc9a227);
  playerRoot.add(character);

  const yaw = new THREE.Object3D();
  playerRoot.add(yaw);
  const pitchObj = new THREE.Object3D();
  yaw.add(pitchObj);
  pitchObj.add(camera);

  let thirdPerson = true; // default 3rd so you see your mini patron
  let looking = false; // pointer-lock optional
  let dragging = false; // click-drag look without lock
  let sitting = false;
  let pitch = 0;
  let walkPhase = 0;
  let savedThirdPerson = true;

  function setViewLabel(icon, label, title) {
    viewBtn.innerHTML = `<span>${icon}</span><em>${label}</em>`;
    viewBtn.title = title;
  }

  function applyCameraMode() {
    if (sitting) {
      // Seat POV — first-person eye line toward the screen
      character.visible = false;
      camera.position.set(0, EYE_SIT, 0.05);
      camera.rotation.set(0, 0, 0);
      pitch = THREE.MathUtils.clamp(pitch, -0.45, 0.35);
      pitchObj.rotation.x = pitch;
      setViewLabel('👁', 'Seat', 'Seated POV');
      return;
    }
    if (thirdPerson) {
      character.visible = true;
      camera.position.set(0, TP_HEIGHT, TP_BACK);
      camera.rotation.set(0, 0, 0);
      pitch = THREE.MathUtils.clamp(pitch, -0.55, 0.35);
      pitchObj.rotation.x = pitch;
      setViewLabel('👁', '1st', 'Switch to first person');
    } else {
      character.visible = false;
      camera.position.set(0, EYE_FP, 0);
      camera.rotation.set(0, 0, 0);
      pitch = THREE.MathUtils.clamp(pitch, -1.15, 1.15);
      pitchObj.rotation.x = pitch;
      setViewLabel('👁', '3rd', 'Switch to third person');
    }
  }
  applyCameraMode();
  yaw.rotation.y = Math.PI / 2; // face screen (−X)

  const keys = Object.create(null);
  const touchMove = { x: 0, y: 0 };
  const lookDelta = { x: 0, y: 0 };
  // Orionn-style smoothed walk velocity (WASD only — arrows look)
  const walkVel = { x: 0, y: 0 };
  const ARROW_LOOK = 1.55; // rad/sec

  const onKey = (e, down) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/i.test(e.target.tagName)) return;
    keys[e.code] = down;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
      e.preventDefault();
    }
    if (down && e.code === 'KeyV') {
      thirdPerson = !thirdPerson;
      applyCameraMode();
    }
    if (down && e.code === 'KeyC' && sitting) standUp();
    if (down && e.code === 'Escape') {
      hostEl.querySelector('#mx-seatmap')?.classList.add('hidden');
      volPanel?.classList.add('hidden');
      setLooking(false);
    }
  };
  const keyDown = (e) => onKey(e, true);
  const keyUp = (e) => onKey(e, false);
  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);

  // ---- Look: free drag on canvas + optional pointer lock (WASD never gated) ----
  function setLooking(on) {
    looking = on;
    if (!on && document.pointerLockElement === canvas) {
      document.exitPointerLock?.();
    }
  }

  async function beginLookLock() {
    await unlockAudio();
    if (isTouch) {
      setLooking(true);
      return;
    }
    try {
      await canvas.requestPointerLock?.();
    } catch {
      setLooking(true);
    }
  }

  // Drag-to-look (no lock required) — feels like controlling a mini character
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.target !== canvas) return;
    dragging = true;
    canvas.setPointerCapture?.(e.pointerId);
    unlockAudio();
  });
  canvas.addEventListener('pointerup', (e) => {
    dragging = false;
    try {
      canvas.releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
  });
  canvas.addEventListener('pointercancel', () => {
    dragging = false;
  });
  canvas.addEventListener('dblclick', () => beginLookLock());

  document.addEventListener('pointerlockchange', onPointerLock);
  function onPointerLock() {
    const locked = document.pointerLockElement === canvas;
    setLooking(locked);
  }
  const onMouseMove = (e) => {
    const active = looking || dragging;
    if (!active || isTouch) return;
    const sens = looking ? 0.0022 : 0.003;
    yaw.rotation.y -= e.movementX * sens;
    const pMax = sitting ? 0.35 : thirdPerson ? 0.35 : 1.15;
    const pMin = sitting ? -0.45 : thirdPerson ? -0.55 : -1.15;
    pitch = THREE.MathUtils.clamp(pitch - e.movementY * (sens * 0.85), pMin, pMax);
    pitchObj.rotation.x = pitch;
  };
  document.addEventListener('mousemove', onMouseMove);

  setupTouchControls(hostEl, touchMove, lookDelta, () => {
    unlockAudio();
  });

  // ---- Other guests ----
  const avatarRoot = new THREE.Group();
  scene.add(avatarRoot);
  const avatarById = new Map();

  function syncPeople(list) {
    const seen = new Set();
    for (const p of list || []) {
      if (!p?.id || p.id === meId) continue;
      seen.add(p.id);
      let mesh = avatarById.get(p.id);
      if (!mesh) {
        mesh = createMiniPatron(0x7aa2ff);
        mesh.scale.setScalar(0.95);
        mesh.userData.phase = Math.random() * Math.PI * 2;
        mesh.position.set(-8.5 + Math.random(), floorY(-8.5), (Math.random() - 0.5) * 2.5);
        const label = makeLabel(p.name || 'Guest');
        label.position.y = 1.7;
        mesh.add(label);
        avatarRoot.add(mesh);
        avatarById.set(p.id, mesh);
      }
    }
    for (const [id, mesh] of avatarById) {
      if (!seen.has(id)) {
        avatarRoot.remove(mesh);
        avatarById.delete(id);
      }
    }
    if (peopleEl) {
      const names = (list || []).filter((p) => p.inside !== false).map((p) => p.name || 'Guest');
      peopleEl.textContent = names.length ? `In the house: ${names.join(' · ')}` : 'You’re exploring alone';
    }
  }
  syncPeople(participants);

  // ---- Collision map (mini-game style) ----
  const walls = [];
  const seatColliders = [];

  function addWall(minX, minZ, maxX, maxZ) {
    walls.push({ min: [minX, minZ], max: [maxX, maxZ] });
  }

  // Outer shell
  addWall(-14.2, -6.25, -13.7, 4.15); // west (screen wall)
  addWall(-14.2, 3.75, 4.1, 4.2); // north
  addWall(-14.2, -6.35, 4.1, -5.85); // south
  addWall(3.7, -6.25, 4.2, 4.15); // east

  // Screen surface
  addWall(-13.55, -4.3, -13.15, 2.3);

  // Auditorium ↔ foyer divider with CENTER aisle door gap (z ≈ -1.1 … 1.1)
  addWall(-4.25, -6.2, -3.65, -1.15);
  addWall(-4.25, 1.15, -3.65, 4.05);

  function collide(pos, radius = RADIUS) {
    let x = pos.x;
    let z = pos.z;
    const boxes = sitting ? walls : walls.concat(seatColliders);
    for (const w of boxes) {
      const cx = THREE.MathUtils.clamp(x, w.min[0], w.max[0]);
      const cz = THREE.MathUtils.clamp(z, w.min[1], w.max[1]);
      const dx = x - cx;
      const dz = z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 < radius * radius && d2 > 1e-8) {
        const d = Math.sqrt(d2);
        const push = (radius - d) / d;
        x += dx * push;
        z += dz * push;
      } else if (d2 <= 1e-8 && x >= w.min[0] && x <= w.max[0] && z >= w.min[1] && z <= w.max[1]) {
        const left = x - w.min[0];
        const right = w.max[0] - x;
        const bottom = z - w.min[1];
        const top = w.max[1] - z;
        const m = Math.min(left, right, bottom, top);
        if (m === left) x = w.min[0] - radius;
        else if (m === right) x = w.max[0] + radius;
        else if (m === bottom) z = w.min[1] - radius;
        else z = w.max[1] + radius;
      }
    }
    x = THREE.MathUtils.clamp(x, -13.85, 3.85);
    z = THREE.MathUtils.clamp(z, -6.0, 3.95);
    pos.x = x;
    pos.z = z;
  }

  // Height samples from GLB (front seats low → back seats high → foyer).
  const heightSamples = []; // { x, y } sorted by x

  function floorY(x) {
    if (!heightSamples.length) {
      // Correct stadium rise: screen (west/−X) low, foyer (east) high then flat.
      if (x >= -4.2) return 0;
      const t = THREE.MathUtils.clamp((x - -12.2) / (-5.2 - -12.2), 0, 1);
      return t * 1.55;
    }
    if (x <= heightSamples[0].x) return heightSamples[0].y;
    if (x >= heightSamples[heightSamples.length - 1].x) return heightSamples[heightSamples.length - 1].y;
    for (let i = 0; i < heightSamples.length - 1; i++) {
      const a = heightSamples[i];
      const b = heightSamples[i + 1];
      if (x >= a.x && x <= b.x) {
        const u = (x - a.x) / Math.max(1e-6, b.x - a.x);
        return a.y + (b.y - a.y) * u;
      }
    }
    return 0;
  }

  // ---- Load GLB + screen + door + seat colliders ----
  let screenMesh = null;
  let videoTex = null;
  let screenMat = null;
  const posterSlots = [];
  let seatAnchors = buildSeatAnchors();
  const liveSeats = []; // { id, x, y, z, sitY } from GLB

  try {
    const loader = new GLTFLoader();
    const gltf = await new Promise((resolve, reject) => {
      loader.load(MODEL_URL, resolve, undefined, reject);
    });
    const root = gltf.scene;
    const cinemaScreenParts = [];
    let doorBox = null;
    const rowHeights = new Map(); // round(x,1) -> floor Y under that row
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.castShadow = false;
      obj.receiveShadow = false;
      const n = (obj.name || '').toLowerCase();
      if (
        /poster-light-box.*(?:stand3|wall2)$/.test(n) ||
        (/poster-light-box-(?:stand|wall)\d+$/.test(obj.name) && /3$|wall2$/.test(n))
      ) {
        posterSlots.push(obj);
      }
      if (n.includes('cinema-screen-and-masking')) cinemaScreenParts.push(obj);
      if (n.includes('exit-door') && n.includes('teal')) {
        obj.updateWorldMatrix(true, false);
        const b = new THREE.Box3().setFromObject(obj);
        if (!doorBox) doorBox = b.clone();
        else doorBox.union(b);
      }
      // Foyer props you shouldn't walk through (concessions, counters, kiosks)
      if (
        !n.includes('kiosk-screen') &&
        (n.includes('concessions-counter') ||
          n.includes('popcorn-kettle') ||
          n.includes('popcorn-warmer') ||
          n.includes('nacho-and-hot-dog') ||
          n.includes('box-office-counter') ||
          (n.includes('ticket-kiosk') && /\/[0-4]$/.test(n)) ||
          n.includes('ticket-tear-podium') ||
          n.includes('foyer-bench'))
      ) {
        obj.updateWorldMatrix(true, false);
        const b = new THREE.Box3().setFromObject(obj);
        const size = b.getSize(new THREE.Vector3());
        // One solid footprint per chunk — skip tiny garnish meshes
        if (size.y > 0.35 && size.x * size.z > 0.35) {
          walls.push({
            min: [b.min.x - 0.05, b.min.z - 0.05],
            max: [b.max.x + 0.05, b.max.z + 0.05],
          });
        }
      }
      // Real seat meshes → grounded colliders + sit anchors
      if (/\/seat-\d+$/.test(n) || /seat-\d+$/.test(n)) {
        obj.updateWorldMatrix(true, false);
        const b = new THREE.Box3().setFromObject(obj);
        const c = b.getCenter(new THREE.Vector3());
        const size = b.getSize(new THREE.Vector3());
        // Platform under the cushion (don't float)
        const floor = b.min.y;
        const sitY = b.max.y - 0.08;
        const key = Math.round(c.x * 2) / 2;
        if (!rowHeights.has(key) || floor < rowHeights.get(key)) rowHeights.set(key, floor);
        liveSeats.push({
          id: obj.name,
          x: c.x,
          y: floor,
          z: c.z,
          sitY,
          // Tight collider — leave walkable gaps between chairs
          min: [c.x - Math.min(0.22, size.x * 0.35), c.z - Math.min(0.17, size.z * 0.35)],
          max: [c.x + Math.min(0.22, size.x * 0.35), c.z + Math.min(0.17, size.z * 0.35)],
        });
      }
      if (n.includes('aisle-step') || n.includes('aisle-floor') || n.includes('foyer-floor') || n === 'cinema-multiplex-and-foyer-floor') {
        obj.updateWorldMatrix(true, false);
        const b = new THREE.Box3().setFromObject(obj);
        const c = b.getCenter(new THREE.Vector3());
        const key = Math.round(c.x * 2) / 2;
        const y = b.min.y;
        if (!rowHeights.has(key) || y < rowHeights.get(key)) rowHeights.set(key, y);
      }
    });
    scene.add(root);

    // Build interpolated floor from measured row heights
    const sortedKeys = [...rowHeights.keys()].sort((a, b) => a - b);
    for (const k of sortedKeys) heightSamples.push({ x: k, y: rowHeights.get(k) });
    // Ensure foyer lands at ~0
    if (!heightSamples.some((s) => s.x > -3)) heightSamples.push({ x: -2, y: 0 }, { x: 2, y: 0 });
    heightSamples.sort((a, b) => a.x - b.x);

    // Prefer live seats for map + colliders
    if (liveSeats.length >= 8) {
      seatColliders.length = 0;
      for (const s of liveSeats) {
        seatColliders.push({ min: s.min, max: s.max });
      }
      seatAnchors = seatsToRows(liveSeats);
    }

    // Widen door gap using real exit-door bounds if found; keep center aisle open.
    if (doorBox) {
      const c = doorBox.getCenter(new THREE.Vector3());
      const s = doorBox.getSize(new THREE.Vector3());
      const half = Math.max(s.z * 0.55, 0.85) + 0.2;
      // Clear previous divider walls (the two we added for foyer split) and rebuild.
      for (let i = walls.length - 1; i >= 0; i--) {
        const w = walls[i];
        if (w.min[0] > -4.5 && w.max[0] < -3.4) walls.splice(i, 1);
      }
      const gaps = [
        [c.z - half, c.z + half],
        [-1.15, 1.15], // center aisle always walkable
      ].sort((a, b) => a[0] - b[0]);
      // Merge overlapping gaps
      const merged = [];
      for (const g of gaps) {
        if (!merged.length || g[0] > merged[merged.length - 1][1]) merged.push([...g]);
        else merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], g[1]);
      }
      let cursor = -6.2;
      for (const [gz0, gz1] of merged) {
        if (gz0 - cursor > 0.35) addWall(-4.25, cursor, -3.65, gz0);
        cursor = Math.max(cursor, gz1);
      }
      if (4.05 - cursor > 0.35) addWall(-4.25, cursor, -3.65, 4.05);
    }

    screenMat = new THREE.MeshBasicMaterial({
      color: 0x22222a,
      toneMapped: false,
      side: THREE.DoubleSide,
    });

    if (cinemaScreenParts.length) {
      const box = new THREE.Box3();
      for (const m of cinemaScreenParts) {
        m.updateWorldMatrix(true, false);
        box.expandByObject(m);
        m.visible = false;
      }
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const screenW = Math.max(size.z, 4) * 0.96;
      const screenH = Math.max(size.y, 2.2) * 0.9;
      screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(screenW, screenH), screenMat);
      screenMesh.position.set(box.max.x + 0.05, center.y, center.z);
      screenMesh.rotation.y = Math.PI / 2;
      screenMesh.renderOrder = 2;
      scene.add(screenMesh);
      screenMesh.userData.screenAnchor = screenMesh.position.clone();
      screenGlow.position.copy(screenMesh.position);
      screenGlow.position.x += 0.4;
    }

    if (!screenMesh) {
      screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 3.9), screenMat);
      screenMesh.position.set(-13.35, 2.05, -1.0);
      screenMesh.rotation.y = Math.PI / 2;
      scene.add(screenMesh);
      screenGlow.position.copy(screenMesh.position);
      screenGlow.position.x += 0.45;
    }

    // Fallback seat colliders only when GLB seats weren't found
    if (!seatColliders.length) {
      for (const row of seatAnchors) {
        for (const s of row.seats) {
          seatColliders.push({
            min: [s.x - 0.2, s.z - 0.16],
            max: [s.x + 0.2, s.z + 0.16],
          });
        }
      }
    }

    // Spawn mid-auditorium on the measured floor (center aisle)
    playerRoot.position.set(-9.2, floorY(-9.2), -0.95);
    applyPosters(posterSlots, posterUrl);
  } catch (err) {
    console.warn('multiplex load failed', err);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(20, 12), new THREE.MeshStandardMaterial({ color: 0x2a1520 }));
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
  }

  // Fallback seat colliders if GLB failed before they were built
  if (!seatColliders.length) {
    for (const row of seatAnchors) {
      for (const s of row.seats) {
        seatColliders.push({
          min: [s.x - 0.2, s.z - 0.16],
          max: [s.x + 0.2, s.z + 0.16],
        });
      }
    }
  }

  function screenWorldPos(out = new THREE.Vector3()) {
    if (!screenMesh) return out.set(-13.35, 2.05, -1);
    if (screenMesh.userData?.screenAnchor) return out.copy(screenMesh.userData.screenAnchor);
    screenMesh.getWorldPosition(out);
    return out;
  }

  let videoBound = false;
  function bindVideo() {
    if (!videoEl || !screenMesh || videoBound) return videoBound;
    try {
      if (!videoEl.videoWidth) {
        videoEl.addEventListener('loadeddata', () => bindVideo(), { once: true });
        return false;
      }
      videoTex = new THREE.VideoTexture(videoEl);
      videoTex.colorSpace = THREE.SRGBColorSpace;
      videoTex.minFilter = THREE.LinearFilter;
      videoTex.magFilter = THREE.LinearFilter;
      videoTex.generateMipmaps = false;
      fitVideoToScreen(videoEl, screenMat, videoTex, screenMesh);
      videoBound = true;
      return true;
    } catch (err) {
      console.warn('VideoTexture failed — keeping 2D player', err);
      return false;
    }
  }
  bindVideo();

  // ---- Spatial audio (HRTF + cone + lobby muffling — better fit than SoundHub for one live movie) ----
  let userVol = 1;
  let smoothedGain = 0;

  async function unlockAudio() {
    if (!videoEl) return false;
    const audio = getSharedAudio(videoEl);
    if (!audio) {
      audioFlag.textContent = '🔊 Device audio (spatial unavailable)';
      return false;
    }
    try {
      videoEl.muted = false;
      videoEl.volume = 1;
      if (audio.ctx.state === 'suspended') await audio.ctx.resume();
      wireAudioGraph(audio, true);
      videoEl.play?.().catch(() => {});
      audio.unlocked = true;
      audioFlag.textContent = '🔊 Spatial Audio';
      audioFlag.classList.add('on');
      onAudioUnlock?.();
      return true;
    } catch (err) {
      console.warn('audio unlock failed', err);
      audioFlag.textContent = '🔇 Tap again to enable audio';
      return false;
    }
  }

  audioFlag.onclick = (e) => {
    e.stopPropagation();
    unlockAudio();
  };

  function updateSpatial(dt) {
    const audio = sharedAudio;
    if (!audio?.unlocked || !screenMesh) return;
    const listener = audio.ctx.listener;
    const ear = new THREE.Vector3();
    camera.getWorldPosition(ear);
    const sp = screenWorldPos();
    const fwd = new THREE.Vector3();
    camera.getWorldDirection(fwd);
    const up = new THREE.Vector3(0, 1, 0);

    if (listener.positionX) {
      const t = audio.ctx.currentTime;
      listener.positionX.setValueAtTime(ear.x, t);
      listener.positionY.setValueAtTime(ear.y, t);
      listener.positionZ.setValueAtTime(ear.z, t);
      listener.forwardX.setValueAtTime(fwd.x, t);
      listener.forwardY.setValueAtTime(fwd.y, t);
      listener.forwardZ.setValueAtTime(fwd.z, t);
      listener.upX.setValueAtTime(up.x, t);
      listener.upY.setValueAtTime(up.y, t);
      listener.upZ.setValueAtTime(up.z, t);
      audio.panner.positionX.setValueAtTime(sp.x, t);
      audio.panner.positionY.setValueAtTime(sp.y, t);
      audio.panner.positionZ.setValueAtTime(sp.z, t);
      // Screen faces +X (toward seats)
      audio.panner.orientationX.setValueAtTime(1, t);
      audio.panner.orientationY.setValueAtTime(0, t);
      audio.panner.orientationZ.setValueAtTime(0, t);
    } else {
      listener.setPosition(ear.x, ear.y, ear.z);
      listener.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
      audio.panner.setPosition(sp.x, sp.y, sp.z);
      audio.panner.setOrientation(1, 0, 0);
    }

    const dist = ear.distanceTo(sp);
    let target = distanceGain(dist) * userVol;
    // Lobby / outside muffling
    let cutoff = 16000;
    if (playerRoot.position.x > -3.5) {
      target *= 0.2;
      cutoff = 900;
    }
    if (playerRoot.position.x > 0.5) {
      target *= 0.4;
      cutoff = 450;
    }
    if (dist > 18) cutoff = Math.min(cutoff, 1200);
    const a = 1 - Math.exp(-VOL_SMOOTH * dt);
    smoothedGain += (target - smoothedGain) * a;
    audio.master.gain.setTargetAtTime(smoothedGain, audio.ctx.currentTime, 0.05);
    audio.filter.frequency.setTargetAtTime(cutoff, audio.ctx.currentTime, 0.08);

    screenGlow.intensity = videoEl && !videoEl.paused ? 4.5 + Math.sin(performance.now() * 0.002) * 0.4 : 0.6;
  }

  function distanceGain(d) {
    if (d <= REF_DIST) return 1;
    if (d >= MAX_AUDIBLE) return 0;
    const t = (d - REF_DIST) / (MAX_AUDIBLE - REF_DIST);
    return Math.max(0, Math.pow(1 - t, 1.4));
  }

  // ---- Seat map ----
  function sitInSeat(seat) {
    setLooking(false);
    dragging = false;
    savedThirdPerson = thirdPerson;
    sitting = true;
    const ground = seat.y != null ? seat.y : floorY(seat.x);
    // Feet on tier; camera uses EYE_SIT for true seat POV
    playerRoot.position.set(seat.x, ground, seat.z);
    yaw.rotation.y = Math.PI / 2; // face screen
    pitch = -0.05;
    pitchObj.rotation.x = pitch;
    character.position.set(0, 0, 0);
    character.rotation.set(0, 0, 0);
    applyCameraMode(); // forces seated FP POV
    hostEl.querySelector('#mx-seatmap').classList.add('hidden');
    unlockAudio();
    hostEl.querySelector('#mx-hint').textContent = isTouch
      ? 'Seat POV · drag to look · joystick / C to stand'
      : 'Seat POV · ←→↑↓ look · WASD / C to stand';
  }

  function standUp() {
    if (!sitting) return;
    sitting = false;
    thirdPerson = savedThirdPerson;
    character.position.set(0, 0, 0);
    character.rotation.set(0, 0, 0);
    // Step into nearest aisle so we don't spawn inside the seat collider
    const aisleTargets = [-0.95, 0.0, 0.95];
    let best = aisleTargets[0];
    let bestD = Infinity;
    for (const z of aisleTargets) {
      const d = Math.abs(playerRoot.position.z - z);
      if (d < bestD) {
        bestD = d;
        best = z;
      }
    }
    playerRoot.position.z = best;
    collide(playerRoot.position);
    playerRoot.position.y = floorY(playerRoot.position.x);
    applyCameraMode();
    hostEl.querySelector('#mx-hint').textContent = walkHint;
  }

  buildSeatMap(hostEl, seatAnchors, (seat) => sitInSeat(seat));

  // ---- UI ----
  viewBtn.onclick = (e) => {
    e.stopPropagation();
    if (sitting) {
      // Standing preference for next stand-up; stay in seat POV while seated
      savedThirdPerson = !savedThirdPerson;
      setViewLabel('👁', savedThirdPerson ? '→3rd' : '→1st', 'Camera after stand');
      return;
    }
    thirdPerson = !thirdPerson;
    applyCameraMode();
  };
  const dimBtn = hostEl.querySelector('#mx-dim');
  dimBtn.onclick = (e) => {
    e.stopPropagation();
    dimmed = !dimmed;
    hemi.intensity = dimmed ? 0.25 : 0.85;
    key.intensity = dimmed ? 0.2 : 0.9;
    fill.intensity = dimmed ? 3 : 12;
    scene.background = new THREE.Color(dimmed ? 0x050308 : 0x0a0810);
    dimBtn.classList.toggle('active', dimmed);
    dimBtn.innerHTML = dimmed ? '<span>🌙</span><em>Dim</em>' : '<span>💡</span><em>Lights</em>';
  };
  hostEl.querySelector('#mx-vol-toggle').onclick = (e) => {
    e.stopPropagation();
    setLooking(false);
    volPanel.classList.toggle('hidden');
  };
  volSlider.oninput = () => {
    userVol = Number(volSlider.value) / 100;
    volVal.textContent = `${volSlider.value}%`;
  };
  hostEl.querySelector('#mx-seats').onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setLooking(false);
    hostEl.querySelector('#mx-seatmap').classList.toggle('hidden');
  };
  hostEl.querySelector('#mx-seatmap-close').onclick = () => {
    hostEl.querySelector('#mx-seatmap').classList.add('hidden');
  };

  function doWatch(zoom) {
    setLooking(false);
    if (sharedAudio) wireAudioGraph(sharedAudio, false);
    onWatch?.({ zoom: Boolean(zoom) });
  }
  watchBtn.onclick = (e) => {
    e.stopPropagation();
    doWatch(nearScreen() || sitting);
  };
  hostEl.querySelector('#mx-exit').onclick = (e) => {
    e.stopPropagation();
    setLooking(false);
    destroy();
    onClose?.();
  };

  // Stop menubar / top chrome from capturing look / pointer lock
  const stopUi = (e) => e.stopPropagation();
  hostEl.querySelector('#mx-top').addEventListener('click', stopUi);
  hostEl.querySelector('#mx-top').addEventListener('mousedown', stopUi);
  menubar.addEventListener('click', stopUi);
  menubar.addEventListener('mousedown', stopUi);
  volPanel.addEventListener('click', stopUi);
  volPanel.addEventListener('mousedown', stopUi);

  function nearScreen() {
    if (!screenMesh) return false;
    return playerRoot.position.distanceTo(screenWorldPos()) < 7.5;
  }

  // ---- Frame loop ----
  let raf = 0;
  let last = performance.now();
  const dir = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // Pitch limits for look (mouse / arrows / touch)
    const pMax = sitting ? 0.35 : thirdPerson ? 0.35 : 1.15;
    const pMin = sitting ? -0.45 : thirdPerson ? -0.55 : -1.15;

    // Touch look deltas
    if (isTouch && (lookDelta.x || lookDelta.y)) {
      yaw.rotation.y -= lookDelta.x * 0.0035;
      pitch = THREE.MathUtils.clamp(pitch - lookDelta.y * 0.0028, pMin, pMax);
      pitchObj.rotation.x = pitch;
      lookDelta.x = 0;
      lookDelta.y = 0;
    }

    // PC arrow keys look around (not move) — no on-screen arrows
    if (!isTouch) {
      let lookX = 0;
      let lookY = 0;
      if (keys.ArrowLeft) lookX -= 1;
      if (keys.ArrowRight) lookX += 1;
      if (keys.ArrowUp) lookY -= 1;
      if (keys.ArrowDown) lookY += 1;
      if (lookX || lookY) {
        yaw.rotation.y -= lookX * ARROW_LOOK * dt;
        pitch = THREE.MathUtils.clamp(pitch - lookY * ARROW_LOOK * 0.75 * dt, pMin, pMax);
        pitchObj.rotation.x = pitch;
      }
    }

    // Orionn-style smoothed WASD (+ touch stick) — arrows do not walk
    let tx = (keys.KeyD ? 1 : 0) + (keys.KeyA ? -1 : 0) + (touchMove.x || 0);
    let ty = (keys.KeyW ? 1 : 0) + (keys.KeyS ? -1 : 0) + (-(touchMove.y || 0));
    const tLen = Math.hypot(tx, ty);
    if (tLen > 1) {
      tx /= tLen;
      ty /= tLen;
    }
    const accel = 3.2 * dt;
    const approach = (cur, tgt) => {
      const d = tgt - cur;
      if (Math.abs(d) <= accel) return tgt;
      return cur + accel * Math.sign(d);
    };
    walkVel.x = approach(walkVel.x, tx);
    walkVel.y = approach(walkVel.y, ty);

    const moving = Math.hypot(walkVel.x, walkVel.y) > 0.02;
    if (sitting && (moving || keys.KeyW || keys.KeyA || keys.KeyS || keys.KeyD || touchMove.x || touchMove.y)) {
      standUp();
    } else if (moving && !sitting) {
      forward.set(0, 0, -1).applyQuaternion(yaw.quaternion);
      forward.y = 0;
      forward.normalize();
      right.set(1, 0, 0).applyQuaternion(yaw.quaternion);
      right.y = 0;
      right.normalize();
      dir.set(0, 0, 0);
      dir.addScaledVector(forward, walkVel.y);
      dir.addScaledVector(right, walkVel.x);
      if (dir.lengthSq() > 0) {
        dir.normalize().multiplyScalar(SPEED * dt * Math.min(1, Math.hypot(walkVel.x, walkVel.y)));
        playerRoot.position.add(dir);
        collide(playerRoot.position);
        walkPhase += dt * 10;
        const swing = Math.sin(walkPhase) * 0.35;
        const legL = character.getObjectByName('legL');
        const legR = character.getObjectByName('legR');
        const armL = character.getObjectByName('armL');
        const armR = character.getObjectByName('armR');
        if (legL) legL.rotation.x = swing;
        if (legR) legR.rotation.x = -swing;
        if (armL) armL.rotation.x = -swing * 0.6;
        if (armR) armR.rotation.x = swing * 0.6;
      }
    } else {
      walkPhase = 0;
      ['legL', 'legR', 'armL', 'armR'].forEach((n) => {
        const o = character.getObjectByName(n);
        if (o) o.rotation.x = 0;
      });
    }

    // Smooth tier steps — stay grounded, no float/pop
    if (!sitting) {
      const targetY = floorY(playerRoot.position.x);
      playerRoot.position.y += (targetY - playerRoot.position.y) * Math.min(1, 14 * dt);
    }

    if (videoTex && videoEl && !videoEl.paused) videoTex.needsUpdate = true;
    updateSpatial(dt);

    const showNear = nearScreen() && !sitting;
    watchBtn.classList.toggle('mx-near', showNear);

    const t = now * 0.001;
    for (const mesh of avatarById.values()) {
      mesh.position.y = floorY(mesh.position.x) + Math.sin(t + (mesh.userData.phase || 0)) * 0.02;
    }

    const w = hostEl.clientWidth;
    const h = hostEl.clientHeight;
    if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
    }
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  function destroy() {
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', keyDown);
    window.removeEventListener('keyup', keyUp);
    document.removeEventListener('pointerlockchange', onPointerLock);
    document.removeEventListener('mousemove', onMouseMove);
    if (document.pointerLockElement === canvas) document.exitPointerLock?.();
    if (videoTex) {
      videoTex.dispose();
      videoTex = null;
    }
    if (screenMat) {
      screenMat.map = null;
      screenMat.dispose();
    }
    if (sharedAudio) wireAudioGraph(sharedAudio, false);
    renderer.dispose();
    hostEl.classList.add('hidden');
    hostEl.innerHTML = '';
  }

  return {
    destroy,
    setParticipants(list) {
      syncPeople(list);
    },
    setPoster(url) {
      applyPosters(posterSlots, url);
    },
    setMovieTitle(title) {
      const flag = hostEl.querySelector('#mx-movie-flag');
      if (flag) flag.textContent = title ? `🎬 Movie Playing · ${title}` : '🎬 Movie Playing';
    },
    refreshVideo() {
      videoBound = false;
      if (videoTex) {
        videoTex.dispose();
        videoTex = null;
      }
      bindVideo();
    },
  };
}

function fitVideoToScreen(video, mat, tex, mesh) {
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const videoAspect = vw / vh;
  let planeAspect = 16 / 9;
  const params = mesh.geometry?.parameters;
  if (params?.width && params?.height) {
    planeAspect = params.width / params.height;
  } else {
    mesh.updateWorldMatrix(true, false);
    const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
    planeAspect = Math.max(size.x, size.z, 0.01) / Math.max(size.y, 0.01);
  }
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  if (videoAspect > planeAspect) {
    const scale = planeAspect / videoAspect;
    tex.repeat.set(1, scale);
    tex.offset.set(0, (1 - scale) / 2);
  } else {
    const scale = videoAspect / planeAspect;
    tex.repeat.set(scale, 1);
    tex.offset.set((1 - scale) / 2, 0);
  }
  mat.map = tex;
  mat.color.set(0xffffff);
  mat.needsUpdate = true;
}

function applyPosters(slots, url) {
  if (!slots?.length) return;
  if (!url) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 768;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a1018';
    ctx.fillRect(0, 0, 512, 768);
    ctx.fillStyle = '#c9a227';
    ctx.font = 'bold 42px Outfit, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('NOW PLAYING', 256, 360);
    ctx.fillStyle = '#9a97b5';
    ctx.font = '28px Outfit, sans-serif';
    ctx.fillText('Add a poster on Host', 256, 410);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    for (const mesh of slots) {
      const mat = mesh.material?.clone?.() || new THREE.MeshBasicMaterial();
      mat.map = tex;
      mat.color = new THREE.Color(0xffffff);
      mat.needsUpdate = true;
      mesh.material = mat;
    }
    return;
  }
  new THREE.TextureLoader().load(
    url,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      for (const mesh of slots) {
        const mat = mesh.material?.clone?.() || new THREE.MeshBasicMaterial();
        mat.map = tex;
        mat.color = new THREE.Color(0xffffff);
        mat.needsUpdate = true;
        mesh.material = mat;
      }
    },
    undefined,
    () => applyPosters(slots, null)
  );
}

function buildSeatAnchors() {
  const rows = [];
  const xs = [-11.56, -10.46, -9.36, -8.26, -7.16, -6.06];
  const zsL = [-3.63, -2.87, -2.13, -1.37];
  const zsR = [-0.63, 0.13, 0.87, 1.63];
  const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
  xs.forEach((x, ri) => {
    const seats = [];
    [...zsL, ...zsR].forEach((z, si) => {
      seats.push({ id: `${labels[ri]}${si + 1}`, x, z, y: null, row: labels[ri], num: si + 1 });
    });
    rows.push({ label: labels[ri], seats });
  });
  return rows;
}

/** Group live GLB seats into Vantage-style rows for the seat map. */
function seatsToRows(liveSeats) {
  const byX = new Map();
  for (const s of liveSeats) {
    const key = Math.round(s.x * 4) / 4;
    if (!byX.has(key)) byX.set(key, []);
    byX.get(key).push(s);
  }
  const xs = [...byX.keys()].sort((a, b) => a - b); // front (screen) first
  const labels = 'ABCDEFGHIJKLMNOP'.split('');
  return xs.map((x, ri) => {
    const seats = byX
      .get(x)
      .slice()
      .sort((a, b) => a.z - b.z)
      .map((s, si) => ({
        id: `${labels[ri] || ri}${si + 1}`,
        x: s.x,
        y: s.y,
        z: s.z,
        sitY: s.sitY,
        row: labels[ri] || String(ri),
        num: si + 1,
      }));
    return { label: labels[ri] || String(ri), seats };
  });
}

function buildSeatMap(hostEl, rows, onPick) {
  const grid = hostEl.querySelector('#mx-seat-grid');
  if (!grid) return;
  grid.innerHTML = rows
    .map(
      (row) => `
      <div class="mx-seat-row" data-row="${row.label}">
        <span class="mx-row-lab">${row.label}</span>
        ${row.seats
          .map(
            (s, i) =>
              `<button type="button" class="mx-seat${i === 3 ? ' mx-aisle' : ''}" data-id="${s.id}" title="${s.id}">${s.num}</button>`
          )
          .join('')}
      </div>`
    )
    .join('');
  const flat = rows.flatMap((r) => r.seats);
  grid.querySelectorAll('.mx-seat').forEach((btn) => {
    btn.onclick = () => {
      grid.querySelectorAll('.mx-seat').forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
      const seat = flat.find((s) => s.id === btn.dataset.id);
      if (seat) onPick(seat);
    };
  });
}

function setupTouchControls(hostEl, touchMove, lookDelta, onGesture) {
  const stick = hostEl.querySelector('#mx-stick');
  const knob = hostEl.querySelector('#mx-knob');
  const look = hostEl.querySelector('#mx-lookzone');
  if (!stick || !look) return;

  // DN Cards–style pointer joystick (works in Discord iframes / iOS WebViews)
  let joyId = null;
  let joyCenter = { x: 0, y: 0 };
  const R = 46;
  const setJoy = (clientX, clientY) => {
    const dx = clientX - joyCenter.x;
    const dy = clientY - joyCenter.y;
    const d = Math.hypot(dx, dy) || 1;
    const clamped = Math.min(d, R);
    const nx = (dx / d) * clamped;
    const ny = (dy / d) * clamped;
    knob.style.transform = `translate(${nx}px, ${ny}px)`;
    if (clamped < 8) {
      touchMove.x = 0;
      touchMove.y = 0;
    } else {
      touchMove.x = nx / R;
      touchMove.y = ny / R;
    }
  };
  const resetJoy = () => {
    knob.style.transform = 'translate(0,0)';
    touchMove.x = 0;
    touchMove.y = 0;
    joyId = null;
  };
  stick.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onGesture?.();
    const rect = stick.getBoundingClientRect();
    joyCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    joyId = e.pointerId;
    try {
      stick.setPointerCapture(e.pointerId);
    } catch {
      /* older WebViews */
    }
    setJoy(e.clientX, e.clientY);
  });
  stick.addEventListener('pointermove', (e) => {
    if (joyId !== e.pointerId) return;
    setJoy(e.clientX, e.clientY);
  });
  const endJoy = (e) => {
    if (joyId === e.pointerId) resetJoy();
  };
  stick.addEventListener('pointerup', endJoy);
  stick.addEventListener('pointercancel', endJoy);
  stick.addEventListener('lostpointercapture', () => {
    if (joyId != null) resetJoy();
  });
  const winUp = (e) => {
    if (joyId === e.pointerId) resetJoy();
  };
  window.addEventListener('pointerup', winUp);
  window.addEventListener('pointercancel', winUp);
  window.addEventListener('blur', resetJoy);

  let lookId = null;
  let last = null;
  look.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onGesture?.();
    lookId = e.pointerId;
    last = { x: e.clientX, y: e.clientY };
    try {
      look.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });
  look.addEventListener('pointermove', (e) => {
    if (lookId !== e.pointerId || !last) return;
    lookDelta.x += e.clientX - last.x;
    lookDelta.y += e.clientY - last.y;
    last = { x: e.clientX, y: e.clientY };
  });
  const endLook = (e) => {
    if (lookId === e.pointerId) {
      lookId = null;
      last = null;
    }
  };
  look.addEventListener('pointerup', endLook);
  look.addEventListener('pointercancel', endLook);
}

function makeLabel(text) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(10,8,14,0.72)';
  ctx.fillRect(8, 12, 240, 40);
  ctx.fillStyle = '#ffd66b';
  ctx.font = 'bold 22px Outfit, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(String(text).slice(0, 18), 128, 40);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.4, 0.35, 1);
  return sprite;
}
