import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

// Walkable Cinema Multiplex + Foyer (CC0). Explore-only — the Activity video
// screen stays 2D; use Fullscreen for edge-to-edge picture. Optional zoom cue
// points at the multiplex screen mesh without projecting the movie onto it.

const MODEL_URL = '/models/cinema-multiplex.glb';
const SPEED = 4.2;
const EYE = 1.65;

export async function openMultiplex(hostEl, { participants = [], meId = null, onClose, onWatch } = {}) {
  hostEl.classList.remove('hidden');
  hostEl.innerHTML = `
    <div class="multiplex">
      <canvas class="multiplex-canvas" id="mx-canvas"></canvas>
      <div class="multiplex-hud">
        <div class="multiplex-title">🎬 Multiplex · explore</div>
        <div class="multiplex-hint">Click to look · WASD move · Esc / Exit to leave · Sit near the screen then Watch</div>
        <div class="multiplex-people" id="mx-people"></div>
        <div class="multiplex-actions">
          <button type="button" class="btn" id="mx-watch">▶ Watch movie</button>
          <button type="button" class="btn" id="mx-exit">Exit</button>
        </div>
      </div>
      <div class="multiplex-blocker" id="mx-blocker">
        <button type="button" class="btn ctl-main" id="mx-enter">🖱 Click to walk around</button>
      </div>
    </div>
  `;

  const canvas = hostEl.querySelector('#mx-canvas');
  const peopleEl = hostEl.querySelector('#mx-people');
  const blocker = hostEl.querySelector('#mx-blocker');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(hostEl.clientWidth, hostEl.clientHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0810);
  scene.fog = new THREE.Fog(0x0a0810, 18, 42);

  const camera = new THREE.PerspectiveCamera(70, hostEl.clientWidth / Math.max(hostEl.clientHeight, 1), 0.08, 80);
  camera.position.set(2.2, EYE, 6.5);

  const hemi = new THREE.HemisphereLight(0xffe6c8, 0x1a1018, 1.1);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff0d8, 1.35);
  key.position.set(4, 8, 2);
  scene.add(key);
  const fill = new THREE.PointLight(0xc9a227, 18, 24);
  fill.position.set(0, 3.2, 0);
  scene.add(fill);

  const controls = new PointerLockControls(camera, canvas);
  scene.add(controls.getObject());

  const keys = Object.create(null);
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

  hostEl.querySelector('#mx-enter').onclick = () => controls.lock();
  controls.addEventListener('lock', () => blocker.classList.add('hidden'));
  controls.addEventListener('unlock', () => blocker.classList.remove('hidden'));

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
        mesh.position.set((Math.random() - 0.5) * 4, EYE * 0.55, 4 + Math.random() * 2);
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

  let screenAnchor = null;
  const loader = new GLTFLoader();
  try {
    const gltf = await new Promise((resolve, reject) => {
      loader.load(MODEL_URL, resolve, undefined, reject);
    });
    const root = gltf.scene;
    root.traverse((obj) => {
      if (obj.isMesh) {
        obj.castShadow = false;
        obj.receiveShadow = false;
        const n = (obj.name || '').toLowerCase();
        if (!screenAnchor && (n.includes('screen') || n.includes('mask') || n.includes('plinth'))) {
          screenAnchor = obj;
        }
      }
    });
    // Model is ~18×10m; park camera in the auditorium looking toward the screen.
    root.position.set(0, 0, 0);
    scene.add(root);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    controls.getObject().position.set(center.x, EYE, center.z + size.z * 0.28);
    if (!screenAnchor) {
      screenAnchor = new THREE.Object3D();
      screenAnchor.position.set(center.x, 1.8, center.z - size.z * 0.35);
      scene.add(screenAnchor);
    }
  } catch (err) {
    console.warn('multiplex load failed', err);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 12),
      new THREE.MeshStandardMaterial({ color: 0x2a1520 })
    );
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
  }

  let raf = 0;
  let last = performance.now();
  const dir = new THREE.Vector3();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();

  function frame(now) {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    if (controls.isLocked) {
      forward.set(0, 0, -1).applyQuaternion(controls.getObject().quaternion);
      forward.y = 0;
      forward.normalize();
      right.set(1, 0, 0).applyQuaternion(controls.getObject().quaternion);
      right.y = 0;
      right.normalize();
      dir.set(0, 0, 0);
      if (keys.KeyW || keys.ArrowUp) dir.add(forward);
      if (keys.KeyS || keys.ArrowDown) dir.sub(forward);
      if (keys.KeyA || keys.ArrowLeft) dir.sub(right);
      if (keys.KeyD || keys.ArrowRight) dir.add(right);
      if (dir.lengthSq() > 0) {
        dir.normalize().multiplyScalar(SPEED * dt);
        controls.getObject().position.add(dir);
      }
      controls.getObject().position.y = EYE;
      // Soft bounds so you stay near the house.
      const p = controls.getObject().position;
      p.x = THREE.MathUtils.clamp(p.x, -8.5, 8.5);
      p.z = THREE.MathUtils.clamp(p.z, -4.5, 8.5);
    }

    // Idle bob for remote avatars
    const t = now * 0.001;
    for (const mesh of avatarById.values()) {
      mesh.position.y = EYE * 0.55 + Math.sin(t + (mesh.userData.phase || 0)) * 0.03;
    }

    const w = hostEl.clientWidth;
    const h = hostEl.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
    }
    renderer.render(scene, camera);
  }
  raf = requestAnimationFrame(frame);

  function nearScreen() {
    if (!screenAnchor) return false;
    const sp = new THREE.Vector3();
    screenAnchor.getWorldPosition(sp);
    return controls.getObject().position.distanceTo(sp) < 6.5;
  }

  hostEl.querySelector('#mx-watch').onclick = () => {
    controls.unlock();
    if (nearScreen()) {
      onWatch?.({ zoom: true });
    } else {
      onWatch?.({ zoom: false });
    }
  };
  hostEl.querySelector('#mx-exit').onclick = () => {
    controls.unlock();
    destroy();
    onClose?.();
  };

  function destroy() {
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', keyDown);
    window.removeEventListener('keyup', keyUp);
    controls.unlock();
    controls.dispose?.();
    renderer.dispose();
    hostEl.classList.add('hidden');
    hostEl.innerHTML = '';
  }

  return {
    destroy,
    setParticipants(list) {
      syncPeople(list);
    },
  };
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
