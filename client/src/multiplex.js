import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// Immersive Cinema Multiplex explore (CC0 GLB).
// ONE authoritative <video> from the Activity player → VideoTexture on the
// theater screen + Web Audio spatialization from the same element (no second
// decode / no duplicate audio).

const MODEL_URL = '/models/cinema-multiplex.glb';
const SPEED = 4.0;
const EYE = 1.65;
const REF_DIST = 3;
const MAX_AUDIBLE = 32;
const VOL_SMOOTH = 6; // higher = snappier, lower = smoother

/** Shared Web Audio graph — createMediaElementSource may run once per <video>. */
let sharedAudio = null;

function wireAudioGraph(audio, spatial) {
  if (!audio) return;
  try {
    audio.source.disconnect();
  } catch {
    /* ignore */
  }
  try {
    audio.panner.disconnect();
  } catch {
    /* ignore */
  }
  try {
    audio.master.disconnect();
  } catch {
    /* ignore */
  }
  if (spatial) {
    audio.source.connect(audio.panner);
    audio.panner.connect(audio.master);
    audio.master.connect(audio.ctx.destination);
    audio.spatial = true;
  } else {
    // Flat 2D path — no distance attenuation when leaving Explore.
    audio.source.connect(audio.master);
    audio.master.connect(audio.ctx.destination);
    audio.spatial = false;
    try {
      audio.master.gain.setTargetAtTime(1, audio.ctx.currentTime, 0.02);
    } catch {
      /* ignore */
    }
  }
}

function getSharedAudio(videoEl) {
  if (sharedAudio?.video === videoEl) return sharedAudio;
  if (sharedAudio) {
    // Different element — tear down carefully.
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
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = REF_DIST;
    panner.maxDistance = MAX_AUDIBLE;
    panner.rolloffFactor = 1.15;
    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 360;
    const master = ctx.createGain();
    master.gain.value = 1;
    sharedAudio = { ctx, source, panner, master, video: videoEl, unlocked: false, spatial: false };
    // Start flat until Explore unlocks spatial mode (avoids dead audio if init fails mid-walk).
    wireAudioGraph(sharedAudio, false);
    return sharedAudio;
  } catch (err) {
    console.warn('spatial audio init failed', err);
    return null;
  }
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
      <div class="multiplex-hud">
        <div class="multiplex-title">🎬 Multiplex · live screen</div>
        <div class="multiplex-status" id="mx-status">
          <span id="mx-movie-flag">🎬 Movie Playing</span>
          <button type="button" class="mx-audio-flag" id="mx-audio-flag">🔇 Click to Enable Theater Audio</button>
        </div>
        <div class="multiplex-hint" id="mx-hint">WASD / touch-drag to walk · look around · Esc exits</div>
        <div class="multiplex-people" id="mx-people"></div>
        <div class="multiplex-actions">
          <button type="button" class="btn" id="mx-dim" title="Dim house lights">💡 Lights</button>
          <button type="button" class="btn" id="mx-vol-toggle" title="Volume">🔊</button>
          <button type="button" class="btn" id="mx-seats" title="Seat map">🪑 Seats</button>
          <button type="button" class="btn" id="mx-watch">▶ Watch movie</button>
          <button type="button" class="btn" id="mx-exit">Exit</button>
        </div>
        <div class="multiplex-vol hidden" id="mx-vol">
          <label>Theater volume <input type="range" id="mx-vol-slider" min="0" max="200" value="100" /></label>
          <span id="mx-vol-val">100%</span>
        </div>
      </div>
      <div class="multiplex-touch" id="mx-touch" aria-hidden="true">
        <div class="mx-stick" id="mx-stick"><div class="mx-knob" id="mx-knob"></div></div>
        <div class="mx-lookzone" id="mx-lookzone"></div>
      </div>
      <div class="multiplex-blocker" id="mx-blocker">
        <button type="button" class="btn ctl-main" id="mx-enter">🖱 Tap / click to walk the theater</button>
      </div>
      <div class="multiplex-seatmap hidden" id="mx-seatmap">
        <div class="mx-seatmap-head">
          <strong>Pick a seat · preview the view</strong>
          <button type="button" class="btn" id="mx-seatmap-close">✕</button>
        </div>
        <div class="mx-screen-label">SCREEN</div>
        <div class="mx-seat-grid" id="mx-seat-grid"></div>
        <p class="mx-seat-hint">Tap a seat to sit · tap again to watch from there</p>
      </div>
      <button type="button" class="btn mx-near-watch hidden" id="mx-near-watch">🎬 Watch Movie</button>
    </div>
  `;

  const canvas = hostEl.querySelector('#mx-canvas');
  const peopleEl = hostEl.querySelector('#mx-people');
  const blocker = hostEl.querySelector('#mx-blocker');
  const audioFlag = hostEl.querySelector('#mx-audio-flag');
  const nearWatchBtn = hostEl.querySelector('#mx-near-watch');
  const volPanel = hostEl.querySelector('#mx-vol');
  const volSlider = hostEl.querySelector('#mx-vol-slider');
  const volVal = hostEl.querySelector('#mx-vol-val');

  const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  hostEl.querySelector('#mx-touch').style.display = isTouch ? 'block' : 'none';
  hostEl.querySelector('#mx-hint').textContent = isTouch
    ? 'Left stick walk · right drag look · Watch when near the screen'
    : 'WASD walk · click canvas to look · Esc / Exit to leave';
  if (movieTitle) {
    hostEl.querySelector('#mx-movie-flag').textContent = `🎬 Movie Playing · ${movieTitle}`;
  }

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(hostEl.clientWidth, hostEl.clientHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0810);
  scene.fog = new THREE.Fog(0x0a0810, 22, 48);

  const camera = new THREE.PerspectiveCamera(70, hostEl.clientWidth / Math.max(hostEl.clientHeight, 1), 0.08, 80);
  camera.position.set(-9.5, EYE, 0);

  const hemi = new THREE.HemisphereLight(0xffe6c8, 0x1a1018, 0.85);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff0d8, 0.9);
  key.position.set(-2, 8, 2);
  scene.add(key);
  const fill = new THREE.PointLight(0xc9a227, 12, 28);
  fill.position.set(-2, 3.2, 0);
  scene.add(fill);
  let dimmed = false;

  // Screen glow — lightweight cinema emission near the projection surface.
  const screenGlow = new THREE.PointLight(0xffffff, 0, 18);
  screenGlow.position.set(-13.2, 2.1, -1);
  scene.add(screenGlow);

  const controls = new PointerLockControls(camera, canvas);
  const playerObj = controls.object || controls.getObject();
  scene.add(playerObj);

  const keys = Object.create(null);
  const touchMove = { x: 0, y: 0 };
  const lookDelta = { x: 0, y: 0 };
  let pitch = 0;

  const onKey = (e, down) => {
    keys[e.code] = down;
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
      e.preventDefault();
    }
  };
  const keyDown = (e) => onKey(e, true);
  const keyUp = (e) => onKey(e, false);
  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);

  // ---- Desktop pointer-lock look ----
  hostEl.querySelector('#mx-enter').onclick = async () => {
    await unlockAudio();
    if (!isTouch) controls.lock();
    else blocker.classList.add('hidden');
  };
  controls.addEventListener('lock', () => blocker.classList.add('hidden'));
  controls.addEventListener('unlock', () => {
    const seatOpen = !hostEl.querySelector('#mx-seatmap')?.classList.contains('hidden');
    if (!isTouch && !seatOpen) blocker.classList.remove('hidden');
  });

  // ---- Touch stick + look zone (youngjin-style) ----
  setupTouchControls(hostEl, touchMove, lookDelta, () => unlockAudio());

  // ---- Avatars ----
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
        const geo = new THREE.CapsuleGeometry(0.22, 0.7, 4, 8);
        const mat = new THREE.MeshStandardMaterial({ color: 0xc9a227, roughness: 0.55, metalness: 0.1 });
        mesh = new THREE.Mesh(geo, mat);
        mesh.userData.phase = Math.random() * Math.PI * 2;
        mesh.position.set(-9 + Math.random(), floorY(-9) + EYE * 0.55, (Math.random() - 0.5) * 3);
        const label = makeLabel(p.name || 'Guest');
        label.position.y = 1.15;
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

  // ---- Collision walls (AABB) — keep stairs/aisles walkable ----
  const walls = [
    // Outer shell
    { min: [-14.2, -6.2], max: [-13.85, 4.1] }, // screen wall (west)
    { min: [-14.2, 3.85], max: [4.05, 4.15] }, // north
    { min: [-14.2, -6.25], max: [4.05, -5.9] }, // south
    { min: [3.85, -6.2], max: [4.15, 4.1] }, // east
    // Screen surface — can't walk through the movie
    { min: [-13.55, -4.2], max: [-13.25, 2.2] },
    // Soft divider between auditorium and foyer (leave aisle gap)
    { min: [-4.15, -6.1], max: [-3.75, -1.2] },
    { min: [-4.15, 1.2], max: [-3.75, 4.0] },
  ];

  function collide(pos, radius = 0.28) {
    let x = pos.x;
    let z = pos.z;
    for (const w of walls) {
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
        // Inside box — push out to nearest face
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
    // World soft clamp
    x = THREE.MathUtils.clamp(x, -13.9, 3.9);
    z = THREE.MathUtils.clamp(z, -6.0, 3.9);
    pos.x = x;
    pos.z = z;
  }

  /** Tier height in auditorium (stairs accessible). */
  function floorY(x) {
    if (x >= -4.2) return 0;
    // Seats rise toward foyer (less negative x)
    const t = THREE.MathUtils.clamp((-4.2 - x) / 8.5, 0, 1);
    return t * 1.55;
  }

  // ---- Load GLB + screen plane + posters ----
  let screenMesh = null;
  let videoTex = null;
  let screenMat = null;
  const posterSlots = [];
  const loader = new GLTFLoader();
  try {
    const gltf = await new Promise((resolve, reject) => {
      loader.load(MODEL_URL, resolve, undefined, reject);
    });
    const root = gltf.scene;
    const cinemaScreenParts = [];
    root.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.castShadow = false;
      obj.receiveShadow = false;
      const n = (obj.name || '').toLowerCase();
      // Thin poster face panels inside light-boxes
      if (
        /poster-light-box.*(?:stand3|wall2)$/.test(n) ||
        (/poster-light-box-(?:stand|wall)\d+$/.test(obj.name) && /3$|wall2$/.test(n))
      ) {
        posterSlots.push(obj);
      }
      // Real projection surface in the CC0 multiplex GLB
      if (n.includes('cinema-screen-and-masking')) {
        cinemaScreenParts.push(obj);
      }
    });
    scene.add(root);

    // Fit a VideoTexture plane to the GLB cinema-screen bounds. Masking frames
    // in the model are hollow / UV'd as borders — painting them directly looks
    // empty — so we hide screen parts and put a solid projection plane in front.
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
      // Screen sits on the west wall: width ≈ Z, height ≈ Y, thin ≈ X.
      const screenW = Math.max(size.z, 4) * 0.96;
      const screenH = Math.max(size.y, 2.2) * 0.9;
      const geo = new THREE.PlaneGeometry(screenW, screenH);
      screenMesh = new THREE.Mesh(geo, screenMat);
      // Nudge toward seats (+X) so the plane clears the wall / masking depth.
      screenMesh.position.set(box.max.x + 0.05, center.y, center.z);
      screenMesh.rotation.y = Math.PI / 2;
      screenMesh.renderOrder = 2;
      scene.add(screenMesh);
      screenMesh.userData.screenAnchor = screenMesh.position.clone();
      screenGlow.position.copy(screenMesh.position);
      screenGlow.position.x += 0.4;
    }

    if (!screenMesh) {
      const geo = new THREE.PlaneGeometry(7.2, 3.9);
      screenMesh = new THREE.Mesh(geo, screenMat);
      screenMesh.position.set(-13.35, 2.05, -1.0);
      screenMesh.rotation.y = Math.PI / 2;
      screenMesh.renderOrder = 2;
      scene.add(screenMesh);
      screenGlow.position.copy(screenMesh.position);
      screenGlow.position.x += 0.45;
    }

    // Start mid-auditorium facing the screen (−X)
    playerObj.position.set(-9.2, floorY(-9.2) + EYE, 0);
    playerObj.rotation.y = Math.PI / 2;
    pitch = 0;
    camera.rotation.x = 0;

    // Apply host poster if provided
    applyPosters(posterSlots, posterUrl);
  } catch (err) {
    console.warn('multiplex load failed', err);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 12),
      new THREE.MeshStandardMaterial({ color: 0x2a1520 })
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
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
        // Wait for metadata once
        videoEl.addEventListener(
          'loadeddata',
          () => {
            bindVideo();
          },
          { once: true }
        );
        return false;
      }
      videoTex = new THREE.VideoTexture(videoEl);
      videoTex.colorSpace = THREE.SRGBColorSpace;
      videoTex.minFilter = THREE.LinearFilter;
      videoTex.magFilter = THREE.LinearFilter;
      videoTex.generateMipmaps = false;
      // Letterbox correctly inside the cinema screen plane
      fitVideoToScreen(videoEl, screenMat, videoTex, screenMesh);
      videoBound = true;
      return true;
    } catch (err) {
      console.warn('VideoTexture failed — keeping 2D player', err);
      return false;
    }
  }
  bindVideo();

  // ---- Spatial audio ----
  let userVol = 1; // 0..2 (slider to 200%)
  let smoothedGain = 0;
  let audioReady = false;

  async function unlockAudio() {
    if (!videoEl) return false;
    const audio = getSharedAudio(videoEl);
    if (!audio) {
      audioFlag.textContent = '🔊 Device audio (spatial unavailable)';
      return false;
    }
    try {
      // MediaElementSource owns output — keep element unmuted at unity volume.
      // ONE decode path: never create a second <audio>/<video> for the movie.
      videoEl.muted = false;
      videoEl.volume = 1;
      if (audio.ctx.state === 'suspended') await audio.ctx.resume();
      wireAudioGraph(audio, true);
      // Ensure playback continues (gesture) — do not restart from 0.
      videoEl.play?.().catch(() => {});
      audio.unlocked = true;
      audioReady = true;
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
    const cam = playerObj;
    const sp = screenWorldPos();
    // Listener = camera
    if (listener.positionX) {
      listener.positionX.setValueAtTime(cam.position.x, audio.ctx.currentTime);
      listener.positionY.setValueAtTime(cam.position.y, audio.ctx.currentTime);
      listener.positionZ.setValueAtTime(cam.position.z, audio.ctx.currentTime);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      listener.forwardX.setValueAtTime(fwd.x, audio.ctx.currentTime);
      listener.forwardY.setValueAtTime(fwd.y, audio.ctx.currentTime);
      listener.forwardZ.setValueAtTime(fwd.z, audio.ctx.currentTime);
      listener.upX.setValueAtTime(up.x, audio.ctx.currentTime);
      listener.upY.setValueAtTime(up.y, audio.ctx.currentTime);
      listener.upZ.setValueAtTime(up.z, audio.ctx.currentTime);
    } else {
      listener.setPosition(cam.position.x, cam.position.y, cam.position.z);
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
      listener.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
    }
    if (audio.panner.positionX) {
      audio.panner.positionX.setValueAtTime(sp.x, audio.ctx.currentTime);
      audio.panner.positionY.setValueAtTime(sp.y, audio.ctx.currentTime);
      audio.panner.positionZ.setValueAtTime(sp.z, audio.ctx.currentTime);
    } else {
      audio.panner.setPosition(sp.x, sp.y, sp.z);
    }

    const dist = cam.position.distanceTo(sp);
    // Extra lobby attenuation when in foyer (x > -4)
    let target = distanceGain(dist) * userVol;
    if (cam.position.x > -3.5) target *= 0.22;
    if (cam.position.x > 0) target *= 0.45;
    const a = 1 - Math.exp(-VOL_SMOOTH * dt);
    smoothedGain += (target - smoothedGain) * a;
    audio.master.gain.setTargetAtTime(smoothedGain, audio.ctx.currentTime, 0.05);

    // Subtle screen glow tied to playback (cheap)
    screenGlow.intensity = videoEl && !videoEl.paused ? 4.5 + Math.sin(performance.now() * 0.002) * 0.4 : 0.6;
  }

  function distanceGain(d) {
    if (d <= REF_DIST) return 1;
    if (d >= MAX_AUDIBLE) return 0;
    // Inverse-ish smooth curve
    const t = (d - REF_DIST) / (MAX_AUDIBLE - REF_DIST);
    return Math.max(0, Math.pow(1 - t, 1.35));
  }

  // ---- Seat map (Vantage-inspired) ----
  const seatAnchors = buildSeatAnchors();
  buildSeatMap(hostEl, seatAnchors, (seat) => {
    // Fly / teleport into seat view
    controls.unlock();
    playerObj.position.set(seat.x, floorY(seat.x) + EYE * 0.85, seat.z);
    // Look toward screen
    camera.lookAt(screenWorldPos());
    pitch = 0;
    hostEl.querySelector('#mx-seatmap').classList.add('hidden');
    unlockAudio();
  });

  // ---- UI wiring ----
  hostEl.querySelector('#mx-dim').onclick = () => {
    dimmed = !dimmed;
    hemi.intensity = dimmed ? 0.25 : 0.85;
    key.intensity = dimmed ? 0.2 : 0.9;
    fill.intensity = dimmed ? 3 : 12;
    scene.background = new THREE.Color(dimmed ? 0x050308 : 0x0a0810);
    hostEl.querySelector('#mx-dim').classList.toggle('active', dimmed);
    hostEl.querySelector('#mx-dim').textContent = dimmed ? '🌙 Dim' : '💡 Lights';
  };
  hostEl.querySelector('#mx-vol-toggle').onclick = () => {
    volPanel.classList.toggle('hidden');
  };
  volSlider.oninput = () => {
    userVol = Number(volSlider.value) / 100;
    volVal.textContent = `${volSlider.value}%`;
  };
  hostEl.querySelector('#mx-seats').onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    controls.unlock();
    const map = hostEl.querySelector('#mx-seatmap');
    map.classList.toggle('hidden');
    blocker.classList.add('hidden');
  };
  hostEl.querySelector('#mx-seatmap-close').onclick = () => {
    hostEl.querySelector('#mx-seatmap').classList.add('hidden');
  };

  function doWatch(zoom) {
    controls.unlock();
    // Restore flat 2D audio before leaving Explore (same element, same position).
    if (sharedAudio) wireAudioGraph(sharedAudio, false);
    onWatch?.({ zoom: Boolean(zoom) });
  }
  hostEl.querySelector('#mx-watch').onclick = () => doWatch(nearScreen());
  nearWatchBtn.onclick = () => doWatch(true);
  hostEl.querySelector('#mx-exit').onclick = () => {
    controls.unlock();
    destroy();
    onClose?.();
  };

  function nearScreen() {
    if (!screenMesh) return false;
    return playerObj.position.distanceTo(screenWorldPos()) < 7.5;
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

    // Look (touch)
    if (isTouch && (lookDelta.x || lookDelta.y)) {
      const obj = playerObj;
      obj.rotation.y -= lookDelta.x * 0.0035;
      pitch = THREE.MathUtils.clamp(pitch - lookDelta.y * 0.0028, -1.2, 1.2);
      camera.rotation.x = pitch;
      lookDelta.x = 0;
      lookDelta.y = 0;
    }

    const moving = controls.isLocked || isTouch;
    if (moving) {
      forward.set(0, 0, -1).applyQuaternion(playerObj.quaternion);
      forward.y = 0;
      forward.normalize();
      right.set(1, 0, 0).applyQuaternion(playerObj.quaternion);
      right.y = 0;
      right.normalize();
      dir.set(0, 0, 0);
      if (keys.KeyW || keys.ArrowUp) dir.add(forward);
      if (keys.KeyS || keys.ArrowDown) dir.sub(forward);
      if (keys.KeyA || keys.ArrowLeft) dir.sub(right);
      if (keys.KeyD || keys.ArrowRight) dir.add(right);
      // Touch stick: y forward, x strafe
      if (touchMove.y || touchMove.x) {
        dir.addScaledVector(forward, -touchMove.y);
        dir.addScaledVector(right, touchMove.x);
      }
      if (dir.lengthSq() > 0) {
        dir.normalize().multiplyScalar(SPEED * dt);
        const p = playerObj.position;
        p.add(dir);
        collide(p);
        p.y = floorY(p.x) + EYE;
      } else {
        const p = playerObj.position;
        p.y = floorY(p.x) + EYE;
      }
    }

    if (videoTex && videoEl && !videoEl.paused) videoTex.needsUpdate = true;
    updateSpatial(dt);

    nearWatchBtn.classList.toggle('hidden', !nearScreen());

    const t = now * 0.001;
    for (const mesh of avatarById.values()) {
      mesh.position.y = floorY(mesh.position.x) + EYE * 0.55 + Math.sin(t + (mesh.userData.phase || 0)) * 0.03;
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
    controls.unlock();
    controls.dispose?.();
    if (videoTex) {
      videoTex.dispose();
      videoTex = null;
    }
    if (screenMat) {
      screenMat.map = null;
      screenMat.dispose();
    }
    // Keep shared AudioContext + MediaElementSource for re-entry; leave flat 2D.
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
  // Prefer PlaneGeometry params; else estimate from world bounds.
  let planeAspect = 16 / 9;
  const params = mesh.geometry?.parameters;
  if (params?.width && params?.height) {
    planeAspect = params.width / params.height;
  } else {
    mesh.updateWorldMatrix(true, false);
    const size = new THREE.Box3().setFromObject(mesh).getSize(new THREE.Vector3());
    const w = Math.max(size.x, size.z, 0.01);
    const h = Math.max(size.y, 0.01);
    planeAspect = w / h;
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
    // Blank but lit placeholder posters
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
  const loader = new THREE.TextureLoader();
  loader.load(
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
  // Approximate 6 tiers × 8 seats from GLB layout (two blocks of 4).
  const rows = [];
  const xs = [-11.56, -10.46, -9.36, -8.26, -7.16, -6.06];
  const zsL = [-3.63, -2.87, -2.13, -1.37];
  const zsR = [-0.63, 0.13, 0.87, 1.63];
  const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
  xs.forEach((x, ri) => {
    const seats = [];
    [...zsL, ...zsR].forEach((z, si) => {
      seats.push({ id: `${labels[ri]}${si + 1}`, x, z, row: labels[ri], num: si + 1 });
    });
    rows.push({ label: labels[ri], seats });
  });
  return rows;
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

  let stickId = null;
  let origin = null;
  stick.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault();
      onGesture?.();
      const t = e.changedTouches[0];
      stickId = t.identifier;
      const r = stick.getBoundingClientRect();
      origin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    { passive: false }
  );
  stick.addEventListener(
    'touchmove',
    (e) => {
      e.preventDefault();
      const t = [...e.touches].find((x) => x.identifier === stickId);
      if (!t || !origin) return;
      const dx = t.clientX - origin.x;
      const dy = t.clientY - origin.y;
      const max = 48;
      const len = Math.hypot(dx, dy) || 1;
      const cx = (dx / len) * Math.min(len, max);
      const cy = (dy / len) * Math.min(len, max);
      knob.style.transform = `translate(${cx}px, ${cy}px)`;
      touchMove.x = cx / max;
      touchMove.y = cy / max;
    },
    { passive: false }
  );
  const endStick = (e) => {
    if (![...e.changedTouches].some((t) => t.identifier === stickId)) return;
    stickId = null;
    origin = null;
    touchMove.x = 0;
    touchMove.y = 0;
    knob.style.transform = 'translate(0,0)';
  };
  stick.addEventListener('touchend', endStick);
  stick.addEventListener('touchcancel', endStick);

  let lookId = null;
  let last = null;
  look.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault();
      onGesture?.();
      const t = e.changedTouches[0];
      lookId = t.identifier;
      last = { x: t.clientX, y: t.clientY };
      hostEl.querySelector('#mx-blocker')?.classList.add('hidden');
    },
    { passive: false }
  );
  look.addEventListener(
    'touchmove',
    (e) => {
      e.preventDefault();
      const t = [...e.touches].find((x) => x.identifier === lookId);
      if (!t || !last) return;
      lookDelta.x += t.clientX - last.x;
      lookDelta.y += t.clientY - last.y;
      last = { x: t.clientX, y: t.clientY };
    },
    { passive: false }
  );
  const endLook = (e) => {
    if (![...e.changedTouches].some((t) => t.identifier === lookId)) return;
    lookId = null;
    last = null;
  };
  look.addEventListener('touchend', endLook);
  look.addEventListener('touchcancel', endLook);
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
