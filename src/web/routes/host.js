import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from '../../config.js';
import * as store from '../../media/store.js';
import { VIDEO_EXTS, NON_WEB, ensureDir } from '../../media/store.js';
import { getPlayback } from '../../media/store.js';
import * as temp from '../../media/temp.js';
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

// ---- Temporary per-party session (hybrid host) -----------------------------
// Step 1: create a temp session for this voice channel and START the party
// immediately (pointing playback at the temp file), so viewers can join before
// the upload finishes. Returns the session id to stream into.
host.post('/api/host/session', express.json(), async (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Session expired — re-open “Host a Movie” from /watch.' });
  if (!s.voiceChannelId) {
    return res.status(400).json({ error: 'no-voice', message: 'Join a voice channel, then re-open “Host a Movie” from /watch.' });
  }
  const client = getDiscordClient();
  if (!client) return res.status(503).json({ error: 'Bot is offline — try again in a moment.' });

  const session = temp.create({ channelId: s.voiceChannelId, name: req.body?.name, size: req.body?.size, addedBy: s.userId });
  try {
    const playback = {
      ...temp.getPlayback(session),
      webPlayable: session.webPlayable !== false,
      converting: Boolean(session.converting),
      codecTip: session.codecTip || null,
    };
    const video = { uid: session.id, name: req.body?.title ? String(req.body.title) : session.name, category: req.body?.category || 'Now Playing' };
    sessions.startClanMovie(s.voiceChannelId, { hostId: s.userId, guildId: s.guildId, video, playback });
    const voice = await client.channels.fetch(s.voiceChannelId).catch(() => null);
    const text = s.textChannelId ? await client.channels.fetch(s.textChannelId).catch(() => null) : null;
    const activityUrl = voice ? await createActivityInvite(voice) : null;
    if (text) await publishPanel(text, s.voiceChannelId, activityUrl);
    res.json({
      ok: true,
      sessionId: session.id,
      name: session.name,
      activityUrl,
      webPlayable: session.webPlayable !== false,
      converting: Boolean(session.converting),
      codecTip: session.codecTip || null,
      suspectConvert: Boolean(session.suspectConvert),
      size: session.total,
    });
  } catch (err) {
    temp.scrub(session.id);
    log.warn('host session start:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Where a resumable upload should continue from (the host page polls this after
// a connection hiccup, then re-PUTs the remainder with ?offset=).
host.get('/api/host/session/:id/offset', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Not authorised' });
  const session = temp.find(req.params.id);
  if (!session) return res.json({ exists: false });
  res.json({ exists: true, receivedBytes: session.receivedBytes, complete: session.complete });
});

// After upload finishes, host page polls this for codec probe / remux status.
host.get('/api/host/session/:id/probe', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Not authorised' });
  const session = temp.find(req.params.id);
  if (!session) return res.json({ exists: false });
  res.json({
    exists: true,
    complete: session.complete,
    webPlayable: session.webPlayable !== false,
    converting: Boolean(session.converting),
    codecTip: session.codecTip || null,
    webReady: Boolean(session.webFile) || Boolean(session.kind === 'hls' && session.hlsDir),
    streamKind: session.kind || 'file',
    probe: session.probe
      ? {
          videoCodec: session.probe.videoCodec,
          audioCodec: session.probe.audioCodec,
          width: session.probe.width,
          height: session.probe.height,
          webPlayable: session.probe.webPlayable,
        }
      : null,
  });
});

// Step 2: stream the file bytes into the temp session (long-running). The range
// route serves what has arrived so far while this is in flight. Supports resume:
// ?offset=<bytes> appends from that point (must equal what we already have).
host.put('/api/host/session/:id/data', (req, res) => {
  const s = sessionFrom(req);
  if (!s) return res.status(401).json({ error: 'Not authorised' });
  const session = temp.find(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  if (session.channelId && s.voiceChannelId && session.channelId !== s.voiceChannelId) {
    return res.status(403).json({ error: 'Wrong channel' });
  }

  const offset = parseInt(req.query.offset, 10) || 0;
  if (offset !== session.receivedBytes) {
    // Client is out of sync — tell it where we actually are so it can resume.
    return res.status(409).json({ error: 'offset-mismatch', receivedBytes: session.receivedBytes });
  }
  const append = offset > 0;
  if (!append) session.receivedBytes = 0;

  const maxBytes = config.media.maxUploadMb * 1024 * 1024;
  const ws = temp.openWrite(session, { append });
  temp.markConnected(session);
  let aborted = false;
  let ended = false;

  req.on('data', (chunk) => {
    if (aborted) return;
    if (session.receivedBytes + chunk.length > maxBytes) {
      aborted = true;
      req.destroy();
      ws.destroy();
      temp.scrub(session.id);
      if (!res.headersSent) res.status(413).json({ error: `Too large (> ${config.media.maxUploadMb} MB).` });
      return;
    }
    // Pause until the chunk is durably written, so the reader never sees bytes
    // that aren't on disk yet, and we get natural backpressure.
    req.pause();
    ws.write(chunk, () => {
      temp.advance(session, chunk.length);
      req.resume();
    });
  });
  req.on('end', () => {
    if (aborted) return;
    ended = true;
    ws.end(() => {
      // Chunked uploads: only finish (probe/HLS) when the declared size is fully
      // on disk. A mid-file chunk end must NOT mark the movie complete.
      const done =
        session.total > 0 ? session.receivedBytes >= session.total : true;
      if (done) temp.finish(session);
      if (!res.headersSent) {
        res.json({
          ok: true,
          bytes: session.receivedBytes,
          complete: Boolean(session.complete || done),
        });
      }
    });
  });
  // Host tab closed / network dropped before finishing — preserve everything,
  // just flag the feed so viewers see a notice and the host can resume.
  req.on('close', () => {
    if (ended || aborted) return;
    ws.end(() => {});
    temp.markDisconnected(session);
  });
  req.on('error', () => {
    if (!aborted && !ended) {
      ws.destroy();
      temp.markDisconnected(session);
    }
  });
  ws.on('error', (err) => {
    if (aborted || ended) return;
    aborted = true;
    log.warn('temp write:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Write failed' });
  });
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
  <p id="mode">Add a video from this device. Best format: <b>MP4 (H.264 video + AAC audio)</b> or WebM. Even resolution (e.g. 1920×1080). Won’t play in browsers: <code>${nonWeb}</code>. MovieBox / “Pro” rips are often <b>H.265</b> — those show a black screen in Discord.</p>
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
  $('#mode').innerHTML='Pick a movie from this device — the party <b>starts right away</b> and it streams while it uploads. Your file stays on your device; the server copy is temporary and deleted when the party ends. <b>Keep this tab open</b> while watching.<br><br><b>Must be Discord-safe:</b> MP4 with <b>H.264 + AAC</b> (or WebM). Even width/height (1920×1080). <b>.mp4 alone is not enough</b> — MovieBox/HEVC/H.265 used to play black — the server now auto-builds a Discord HLS stream after upload so playback can start before the whole movie finishes converting. HandBrake “Fast 1080p30” is still the fastest path.';
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
  if(S) return hostSession(f); // temporary per-party session (streams while it plays)
  if(!(keyEl.value||'').trim()){ setStatus('Enter your admin key first.'); return; }
  adminUpload(f);
}
// Admin mode: permanent library upload (waits for the whole file).
function adminUpload(f){
  const url='/api/host/upload?'+auth()+'&name='+encodeURIComponent(f.name)+'&category='+encodeURIComponent($('#cat').value||'Library');
  const xhr=new XMLHttpRequest(); xhr.open('PUT',url);
  $('#barwrap').style.display='block';
  xhr.upload.onprogress=e=>{if(e.lengthComputable)$('#bar').style.width=(e.loaded/e.total*100)+'%';};
  xhr.onload=()=>{ let r={}; try{r=JSON.parse(xhr.responseText);}catch{} $('#bar').style.width='0';
    if(!r.ok){ setStatus('⚠️ '+(r.error||'Upload failed')); return; }
    setStatus('✅ Added “'+r.video.name+'”.'); refresh(); };
  xhr.onerror=()=>setStatus('⚠️ Network error');
  setStatus('Uploading '+f.name+'…'); xhr.send(f);
}
// Session mode: create a TEMPORARY party file, start the party immediately, then
// stream the file up in the background so viewers watch as it uploads. The upload
// is resumable — a network hiccup auto-continues from the server's offset without
// restarting the movie.
var SID=null, FILE=null, hostMsg='', retries=0;
async function hostSession(f){
  setStatus('Setting up your theater…');
  let meta={};
  try{
    meta=await fetch('/api/host/session',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({s:S,name:f.name,size:f.size,category:$('#cat').value||'Now Playing'})}).then(r=>r.json());
  }catch{ setStatus('⚠️ Could not reach the bot.'); return; }
  if(!meta.ok){ setStatus('⚠️ '+(meta.message||meta.error||'Could not start the party')); return; }
  SID=meta.sessionId; FILE=f; retries=0;
  hostMsg='🎉 <b>Party started</b> — “'+meta.name+'”! Prefer launching from Discord: voice channel → <b>Activities</b> → DarkNight (same window). <b>Keep this tab open</b> while it streams.';
  if(meta.activityUrl) hostMsg+='<br><a class="open" href="'+meta.activityUrl+'" target="_blank" rel="noopener">▶ Open Theater invite</a> <small>(invite links may open another Discord window — that’s Discord, not a bug)</small>';
  if(meta.converting || meta.suspectConvert){
    hostMsg+='<br><small>🛡️ MovieBox/large file detected — Discord playback is <b>held</b> until a safe HLS stream is ready (avoids the black screen). Upload finishes first, then the first segments unlock the Theater.</small>';
    if(meta.codecTip) hostMsg+='<br><small>'+esc(meta.codecTip)+'</small>';
  } else if(meta.webPlayable===false){
    hostMsg+='<br><small>⚠️ This container may not play in browsers — use MP4 H.264/AAC.</small>';
  }
  setStatus(hostMsg);
  $('#barwrap').style.display='block';
  streamFrom(0);
}
// Upload in fixed chunks so multi‑GB MovieBox files don't die on a single giant
// PUT (Railway/proxy idle timeouts). Server only runs probe/HLS when bytes >= size.
var CHUNK=8*1024*1024;
function streamFrom(offset){
  const end=Math.min(offset+CHUNK, FILE.size);
  const blob=FILE.slice(offset, end);
  const xhr=new XMLHttpRequest();
  xhr.open('PUT','/api/host/session/'+SID+'/data?s='+encodeURIComponent(S)+'&offset='+offset);
  xhr.upload.onprogress=e=>{ if(e.lengthComputable){ retries=0; $('#bar').style.width=((offset+e.loaded)/FILE.size*100)+'%'; } };
  xhr.onload=()=>{
    if(xhr.status<200 || xhr.status>=300){ resumeSoon(); return; }
    let r={}; try{r=JSON.parse(xhr.responseText);}catch{}
    const next=(r.bytes!=null)?r.bytes:end;
    $('#bar').style.width=(next/FILE.size*100)+'%';
    retries=0;
    if(r.complete || next>=FILE.size){
      $('#bar').style.width='100%';
      setStatus(hostMsg+'<br><small>✅ Fully uploaded — optimizing for Discord…</small>');
      pollProbe(0);
      return;
    }
    setStatus(hostMsg+'<br><small>📡 Uploading… '+Math.floor(next/FILE.size*100)+'% ('+Math.floor(next/1048576)+' / '+Math.floor(FILE.size/1048576)+' MB). Keep this tab open.</small>');
    streamFrom(next);
  };
  xhr.onerror=()=>resumeSoon();
  xhr.onabort=()=>resumeSoon();
  xhr.send(blob);
}
async function pollProbe(n){
  // Large MovieBox converts can take a while before the first HLS segments appear.
  if(n>480){ setStatus(hostMsg+'<br><small>✅ Uploaded. Open the Theater and press ▶. If still black, re-encode to H.264+AAC.</small>'); return; }
  try{
    const r=await fetch('/api/host/session/'+SID+'/probe?s='+encodeURIComponent(S)).then(x=>x.json());
    if(!r.exists){ setStatus('The party has ended.'); return; }
    if(r.converting && !r.webReady){
      setStatus(hostMsg+'<br><small>⚙️ Building Discord HLS stream… first segments unlock the Theater soon (full-movie encode continues in background). Keep this tab open.</small>');
      setTimeout(()=>pollProbe(n+1),2500);
      return;
    }
    if(r.webReady || r.probe){
      let msg=hostMsg+'<br><small>✅ '+(r.streamKind==='hls'?'Discord stream ready (HLS)':'Ready')+''+(r.probe?(' · '+esc(r.probe.videoCodec||'?')+' / '+esc(r.probe.audioCodec||'?')+' · '+(r.probe.width||'?')+'×'+(r.probe.height||'?')):'')+'</small>';
      if(r.codecTip) msg+='<br><small style="color:#ffb0b0">⚠️ '+esc(r.codecTip)+'</small>';
      else if(r.webPlayable===false) msg+='<br><small style="color:#ffb0b0">⚠️ This file likely won’t paint in Discord — re-encode to H.264 + AAC.</small>';
      else msg+='<br><small>Open the Theater and press ▶ if it isn’t already playing.</small>';
      setStatus(msg);
      return;
    }
  }catch{}
  setTimeout(()=>pollProbe(n+1),1500);
}
function esc(s){ return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function resumeSoon(){
  if(++retries>30){ setStatus(hostMsg+'<br><small>⚠️ Upload stopped. Pick the file again to resume.</small>'); return; }
  setStatus(hostMsg+'<br><small>⚠️ Connection hiccup — resuming upload…</small>');
  setTimeout(async ()=>{
    try{
      const r=await fetch('/api/host/session/'+SID+'/offset?s='+encodeURIComponent(S)).then(x=>x.json());
      if(!r.exists){ setStatus('The party has ended.'); return; }
      if(r.complete){ $('#bar').style.width='100%'; setStatus(hostMsg+'<br><small>✅ Fully uploaded — optimizing for Discord…</small>'); pollProbe(0); return; }
      streamFrom(r.receivedBytes);
    }catch{ resumeSoon(); }
  }, 1500);
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
