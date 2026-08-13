import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from '../../config.js';
import * as store from '../../media/store.js';
import { VIDEO_EXTS, NON_WEB, ensureDir } from '../../media/store.js';
import { getPlayback } from '../../media/store.js';
import { verifyHostSession } from '../../media/token.js';
import * as sessions from '../../services/sessions.js';
import { getDiscordClient } from '../../bot/clientRef.js';
import { publishPanel, createActivityInvite } from '../../bot/handlers/theater.js';
import { log } from '../../logger.js';

// The /host page + API: how a host adds a video from their device. Two ways in:
//   • operator opens /host and types the admin key (manage the library), or
//   • a host taps "Host a Movie" inside /watch, which opens /host?s=<token> —
//     a one-time, pre-authorised session (no key) that also knows their voice +
//     text channel, so after upload it can START THE WATCH PARTY for them.

export const host = express.Router();

function keyOk(req) {
  const provided = req.get('x-admin-key') || req.query.key || '';
  return provided && provided === config.media.adminKey;
}
function sessionFrom(req) {
  return verifyHostSession(req.query.s || req.get('x-host-session') || (req.body && req.body.s));
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

// List / delete stay admin-only (library management).
host.get('/api/host/list', requireKey, (req, res) => {
  res.json({ videos: store.list(), dir: config.media.dir });
});
host.delete('/api/host/media/:id', requireKey, (req, res) => {
  res.json({ ok: store.remove(req.params.id) });
});

// Upload a video from the device. Auth: admin key OR a valid host session token.
// Raw body stream -> disk (no multipart parser, resumable-friendly).
host.put('/api/host/upload', (req, res) => {
  if (!keyOk(req) && !sessionFrom(req)) return res.status(401).json({ error: 'Not authorised' });
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

// Start the watch party from the host page (uses the one-time session token's
// Discord context — no admin key, no manual channel wiring).
host.post('/api/host/start', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Session expired — re-open “Host a Movie” from /watch.' });
  const video = store.find(req.body?.uid);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  if (!s.voiceChannelId) {
    return res.status(400).json({ error: 'no-voice', message: 'Join a voice channel, then re-open “Host a Movie” from /watch to start a party.' });
  }
  const client = getDiscordClient();
  if (!client) return res.status(503).json({ error: 'Bot is offline — try again in a moment.' });

  try {
    const playback = getPlayback(video);
    sessions.startClanMovie(s.voiceChannelId, { hostId: s.userId, guildId: s.guildId, video, playback });
    const voice = await client.channels.fetch(s.voiceChannelId).catch(() => null);
    const text = s.textChannelId ? await client.channels.fetch(s.textChannelId).catch(() => null) : null;
    const activityUrl = voice ? await createActivityInvite(voice) : null;
    if (text) await publishPanel(text, s.voiceChannelId, activityUrl);
    res.json({ ok: true, name: video.name, activityUrl });
  } catch (err) {
    log.warn('host start:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// The uploader page — dependency-free. Works in two modes:
//   admin mode  (no ?s)  : type key, manage library.
//   session mode (?s=..) : opened from /watch; no key; auto-starts the party.
export function hostPage() {
  const nonWeb = [...NON_WEB].join(', ');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DarkNight — Host a Movie</title><style>
  body{font-family:system-ui,sans-serif;background:#0b0b12;color:#e7e7f0;margin:0;padding:1.5rem}
  .card{max-width:720px;margin:1rem auto;background:#15151f;border:1px solid #2a2a3a;border-radius:16px;padding:1.5rem}
  h1{margin:.2rem 0;color:#c9a227}code{background:#20202c;padding:.1rem .4rem;border-radius:6px;color:#ffd66b}
  input[type=text],input[type=password]{width:100%;padding:.6rem;margin:.3rem 0 .8rem;background:#20202c;border:1px solid #2a2a3a;border-radius:8px;color:#fff}
  .drop{border:2px dashed #3a3a52;border-radius:14px;padding:2rem;text-align:center;color:#9a97b5;cursor:pointer;transition:.2s}
  .drop.hover{border-color:#c9a227;background:#191922}
  .bar{height:10px;background:#20202c;border-radius:6px;overflow:hidden;margin:.6rem 0;display:none}.bar>i{display:block;height:100%;width:0;background:#37c871;transition:.2s}
  a.open{display:inline-block;margin-top:.6rem;background:#5865f2;color:#fff;text-decoration:none;padding:.55rem 1rem;border-radius:10px;font-weight:700}
  ul{list-style:none;padding:0}li{display:flex;justify-content:space-between;align-items:center;background:#1c1c2b;border:1px solid #2a2a3a;border-radius:10px;padding:.5rem .8rem;margin:.3rem 0}
  li button{background:#3a1c22;color:#ff9ea6;border:1px solid #5a2630;border-radius:8px;padding:.3rem .6rem;cursor:pointer}
  small{color:#9a97b5}
</style></head><body><div class="card">
  <h1>🎬 Host a Movie</h1>
  <p id="mode">Add a video from this device. Best format: <b>MP4 (H.264/AAC)</b> or WebM. Won’t play in browsers: <code>${nonWeb}</code>.</p>
  <div id="keywrap"><label>Admin key</label><input type="password" id="key" placeholder="HOST_ADMIN_KEY (or SESSION_SECRET)"/></div>
  <label>Category (optional)</label>
  <input type="text" id="cat" placeholder="Library" value="Library"/>
  <div class="drop" id="drop">📁 Click or drop a video file here</div>
  <input type="file" id="file" accept="video/*" style="display:none"/>
  <div class="bar" id="barwrap"><i id="bar"></i></div>
  <p id="status"><small>Choose a file to begin.</small></p>
  <div id="listwrap"><h3>In your library</h3><ul id="list"></ul></div>
</div>
<script>
const $=s=>document.querySelector(s);
const S=new URLSearchParams(location.search).get('s');
const keyEl=$('#key');
if(S){ // session mode: opened from /watch — no key, auto-start the party
  $('#keywrap').style.display='none';
  $('#listwrap').style.display='none';
  $('#mode').innerHTML='Pick a movie from this device — it’ll upload and <b>start the watch party</b> in your voice channel. Best: MP4 (H.264/AAC) or WebM.';
} else {
  keyEl.value=localStorage.getItem('dnkey')||'';
  keyEl.onchange=()=>{localStorage.setItem('dnkey',keyEl.value);refresh();};
  refresh();
}
const drop=$('#drop'),file=$('#file');
drop.onclick=()=>file.click();
['dragover','dragenter'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add('hover');}));
['dragleave','drop'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove('hover');}));
drop.addEventListener('drop',ev=>{if(ev.dataTransfer.files[0])upload(ev.dataTransfer.files[0]);});
file.onchange=()=>{if(file.files[0])upload(file.files[0]);};
function auth(){ return S ? ('s='+encodeURIComponent(S)) : ('key='+encodeURIComponent((keyEl.value||'').trim())); }
function setStatus(html){ $('#status').innerHTML='<small>'+html+'</small>'; }
function upload(f){
  if(!S && !(keyEl.value||'').trim()){ setStatus('Enter your admin key first.'); return; }
  const url='/api/host/upload?'+auth()+'&name='+encodeURIComponent(f.name)+'&category='+encodeURIComponent($('#cat').value||'Library');
  const xhr=new XMLHttpRequest(); xhr.open('PUT',url);
  $('#barwrap').style.display='block';
  xhr.upload.onprogress=e=>{if(e.lengthComputable)$('#bar').style.width=(e.loaded/e.total*100)+'%';};
  xhr.onload=()=>{
    let r={}; try{r=JSON.parse(xhr.responseText);}catch{}
    $('#bar').style.width='0';
    if(!r.ok){ setStatus('⚠️ '+(r.error||'Upload failed')); return; }
    if(S){ setStatus('✅ Uploaded — starting the party…'); startParty(r.video.uid); }
    else { setStatus('✅ Added “'+r.video.name+'”.'); refresh(); }
  };
  xhr.onerror=()=>setStatus('⚠️ Network error');
  setStatus('Uploading '+f.name+'…');
  xhr.send(f);
}
async function startParty(uid){
  try{
    const r=await fetch('/api/host/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({s:S,uid})});
    const j=await r.json();
    if(j.ok){
      let html='🎉 <b>Party started</b> for “'+j.name+'”! Head back to Discord and open the Theater in your voice channel.';
      if(j.activityUrl) html+='<br><a class="open" href="'+j.activityUrl+'" target="_blank" rel="noopener">▶ Open Theater</a>';
      setStatus(html);
    } else { setStatus('⚠️ '+(j.message||j.error||'Could not start the party')); }
  }catch{ setStatus('⚠️ Could not reach the bot to start the party.'); }
}
async function refresh(){
  const key=(keyEl.value||'').trim(); if(!key)return;
  const r=await fetch('/api/host/list?key='+encodeURIComponent(key)); if(!r.ok){$('#list').innerHTML='';return;}
  const {videos}=await r.json();
  $('#list').innerHTML=videos.map(v=>'<li><span>🎬 '+v.name+' <small>'+(v.webPlayable?'':'⚠️ not web-playable')+'</small></span><button onclick="del(\\''+v.uid+'\\')">Delete</button></li>').join('')||'<li><small>No videos yet.</small></li>';
}
async function del(id){const key=(keyEl.value||'').trim();await fetch('/api/host/media/'+id+'?key='+encodeURIComponent(key),{method:'DELETE'});refresh();}
</script></body></html>`;
}
