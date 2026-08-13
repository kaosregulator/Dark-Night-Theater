import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from '../../config.js';
import * as store from '../../media/store.js';
import { VIDEO_EXTS, NON_WEB, ensureDir } from '../../media/store.js';
import { log } from '../../logger.js';

// The /host page + its API: how a host adds a video from their device. The page
// is a tiny self-contained uploader; the API streams the file to disk (no cloud
// storage) and registers it so /watch can play it.

export const host = express.Router();

function keyOk(req) {
  const provided = req.get('x-admin-key') || req.query.key || '';
  return provided && provided === config.media.adminKey;
}
function requireKey(req, res, next) {
  if (!keyOk(req)) return res.status(401).json({ error: 'Bad admin key' });
  next();
}
function sanitize(name) {
  return path.basename(String(name || 'video'))
    .replace(/[^a-zA-Z0-9._ -]/g, '_')
    .slice(0, 120);
}

// List current library (for the host page).
host.get('/api/host/list', requireKey, (req, res) => {
  res.json({ videos: store.list(), dir: config.media.dir });
});

// Delete a video (removes the file too).
host.delete('/api/host/media/:id', requireKey, (req, res) => {
  res.json({ ok: store.remove(req.params.id) });
});

// Upload a video from the device. Raw body stream -> disk (resumable-friendly,
// no multipart parser needed). PUT /api/host/upload?name=Movie.mp4&category=...
host.put('/api/host/upload', requireKey, (req, res) => {
  ensureDir();
  const clean = sanitize(req.query.name);
  const ext = path.extname(clean).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) {
    return res.status(400).json({ error: `Unsupported type "${ext}". Use MP4/WebM (MKV/AVI won't play in browsers).` });
  }
  const maxBytes = config.media.maxUploadMb * 1024 * 1024;
  const declared = Number(req.headers['content-length'] || 0);
  if (declared && declared > maxBytes) {
    return res.status(413).json({ error: `Too large (> ${config.media.maxUploadMb} MB).` });
  }

  // Avoid filename collisions.
  let file = clean;
  let n = 1;
  while (fs.existsSync(path.join(config.media.dir, file))) {
    file = `${path.basename(clean, ext)} (${n++})${ext}`;
  }
  const dest = path.join(config.media.dir, file);
  const out = fs.createWriteStream(dest);
  let bytes = 0;
  let aborted = false;

  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes && !aborted) {
      aborted = true;
      req.destroy();
      out.destroy();
      fs.rm(dest, { force: true }, () => {});
      res.status(413).json({ error: `Too large (> ${config.media.maxUploadMb} MB).` });
    }
  });
  req.pipe(out);
  out.on('finish', () => {
    if (aborted) return;
    const video = store.register({
      file,
      name: req.query.title ? String(req.query.title) : undefined,
      category: req.query.category ? String(req.query.category) : 'Library',
      size: bytes,
    });
    log.info(`Host uploaded "${video.name}" (${(bytes / 1048576).toFixed(0)} MB)`);
    res.json({ ok: true, video });
  });
  out.on('error', (err) => {
    if (aborted) return;
    log.warn('upload write error:', err.message);
    res.status(500).json({ error: 'Write failed' });
  });
});

// The uploader page. Kept dependency-free and self-contained.
export function hostPage() {
  const nonWeb = [...NON_WEB].join(', ');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DarkNight — Host a Movie</title><style>
  body{font-family:system-ui,sans-serif;background:#0b0b12;color:#e7e7f0;margin:0;padding:1.5rem}
  .card{max-width:720px;margin:1rem auto;background:#15151f;border:1px solid #2a2a3a;border-radius:16px;padding:1.5rem}
  h1{margin:.2rem 0;color:#c9a227}code{background:#20202c;padding:.1rem .4rem;border-radius:6px;color:#ffd66b}
  input,button{font:inherit}input[type=text],input[type=password]{width:100%;padding:.6rem;margin:.3rem 0 .8rem;background:#20202c;border:1px solid #2a2a3a;border-radius:8px;color:#fff}
  .drop{border:2px dashed #3a3a52;border-radius:14px;padding:2rem;text-align:center;color:#9a97b5;cursor:pointer;transition:.2s}
  .drop.hover{border-color:#c9a227;background:#191922}
  button.primary{background:#c9a227;color:#1a1500;border:0;padding:.6rem 1rem;border-radius:10px;font-weight:700;cursor:pointer}
  .bar{height:10px;background:#20202c;border-radius:6px;overflow:hidden;margin:.6rem 0}.bar>i{display:block;height:100%;width:0;background:#37c871;transition:.2s}
  ul{list-style:none;padding:0}li{display:flex;justify-content:space-between;align-items:center;background:#1c1c2b;border:1px solid #2a2a3a;border-radius:10px;padding:.5rem .8rem;margin:.3rem 0}
  li button{background:#3a1c22;color:#ff9ea6;border:1px solid #5a2630;border-radius:8px;padding:.3rem .6rem;cursor:pointer}
  small{color:#9a97b5}
</style></head><body><div class="card">
  <h1>🎬 Host a Movie</h1>
  <p>Add a video from this device. It’s served locally with range support and appears in <code>/watch</code>. Best format: <b>MP4 (H.264/AAC)</b> or WebM. These won’t play in browsers: <code>${nonWeb}</code>.</p>
  <label>Admin key</label>
  <input type="password" id="key" placeholder="HOST_ADMIN_KEY (or SESSION_SECRET)"/>
  <label>Category (optional)</label>
  <input type="text" id="cat" placeholder="Library" value="Library"/>
  <div class="drop" id="drop">📁 Click or drop a video file here to upload</div>
  <input type="file" id="file" accept="video/*" style="display:none"/>
  <div class="bar" id="barwrap" style="display:none"><i id="bar"></i></div>
  <p id="status"><small>Enter your admin key, then choose a file.</small></p>
  <h3>In your library</h3><ul id="list"></ul>
</div>
<script>
const $=s=>document.querySelector(s);
const keyEl=$('#key'); keyEl.value=localStorage.getItem('dnkey')||'';
keyEl.onchange=()=>{localStorage.setItem('dnkey',keyEl.value);refresh();};
const drop=$('#drop'),file=$('#file');
drop.onclick=()=>file.click();
['dragover','dragenter'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add('hover');}));
['dragleave','drop'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove('hover');}));
drop.addEventListener('drop',ev=>{if(ev.dataTransfer.files[0])upload(ev.dataTransfer.files[0]);});
file.onchange=()=>{if(file.files[0])upload(file.files[0]);};
function upload(f){
  const key=keyEl.value.trim(); if(!key){$('#status').innerHTML='<small>Enter your admin key first.</small>';return;}
  const url='/api/host/upload?key='+encodeURIComponent(key)+'&name='+encodeURIComponent(f.name)+'&category='+encodeURIComponent($('#cat').value||'Library');
  const xhr=new XMLHttpRequest(); xhr.open('PUT',url);
  $('#barwrap').style.display='block';
  xhr.upload.onprogress=e=>{if(e.lengthComputable)$('#bar').style.width=(e.loaded/e.total*100)+'%';};
  xhr.onload=()=>{try{const r=JSON.parse(xhr.responseText);$('#status').innerHTML='<small>'+(r.ok?('✅ Added "'+r.video.name+'"'):('⚠️ '+r.error))+'</small>';}catch{$('#status').innerHTML='<small>⚠️ Upload failed</small>';}$('#bar').style.width='0';refresh();};
  xhr.onerror=()=>{$('#status').innerHTML='<small>⚠️ Network error</small>';};
  xhr.send(f);
  $('#status').innerHTML='<small>Uploading '+f.name+'…</small>';
}
async function refresh(){
  const key=keyEl.value.trim(); if(!key)return;
  const r=await fetch('/api/host/list?key='+encodeURIComponent(key)); if(!r.ok){$('#list').innerHTML='';return;}
  const {videos}=await r.json();
  $('#list').innerHTML=videos.map(v=>'<li><span>🎬 '+v.name+' <small>'+(v.webPlayable?'':'⚠️ not web-playable')+'</small></span><button onclick="del(\\''+v.uid+'\\')">Delete</button></li>').join('')||'<li><small>No videos yet.</small></li>';
}
async function del(id){const key=keyEl.value.trim();await fetch('/api/host/media/'+id+'?key='+encodeURIComponent(key),{method:'DELETE'});refresh();}
refresh();
</script></body></html>`;
}
