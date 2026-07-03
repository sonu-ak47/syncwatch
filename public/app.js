const socket = io();

// ---------- Screens ----------
const screens = {
  entry: document.getElementById('screen-entry'),
  waiting: document.getElementById('screen-waiting'),
  player: document.getElementById('screen-player'),
};
function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.add('hidden'));
  screens[name].classList.remove('hidden');
}

let roomCode = null;
let myName = '';
let peerName = '';

// ---------- Name persistence ----------
const nameInput = document.getElementById('input-name');
nameInput.value = localStorage.getItem('syncwatch-name') || '';

function getName() {
  const val = nameInput.value.trim().slice(0, 24) || 'Guest';
  localStorage.setItem('syncwatch-name', val);
  return val;
}

// Prefill room code from a shared invite link like ?room=ABCDE
const urlParams = new URLSearchParams(location.search);
const invitedCode = urlParams.get('room');
if (invitedCode) document.getElementById('input-code').value = invitedCode.toUpperCase();

// ---------- Entry screen ----------
document.getElementById('btn-create').addEventListener('click', () => {
  myName = getName();
  socket.emit('create-room', { name: myName }, (res) => {
    if (!res.ok) return;
    roomCode = res.code;
    document.getElementById('room-code-text').textContent = res.code.split('').join(' ');
    showScreen('waiting');
  });
});

document.getElementById('form-join').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = document.getElementById('input-code').value.trim().toUpperCase();
  if (!code) return;
  myName = getName();
  socket.emit('join-room', { code, name: myName }, (res) => {
    if (!res.ok) {
      document.getElementById('entry-error').textContent = res.error;
      return;
    }
    roomCode = res.code;
    peerName = res.peerName || '';
    enterPlayerScreen();
    setPeerConnected(true);
    if (res.queue) { queueState = res.queue; renderQueue(); }
  });
});

document.getElementById('input-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase();
});

// ---------- Waiting screen ----------
document.getElementById('btn-copy').addEventListener('click', () => {
  navigator.clipboard.writeText(roomCode);
  const btn = document.getElementById('btn-copy');
  btn.textContent = 'Copied!';
  setTimeout(() => (btn.textContent = 'Copy code'), 1400);
});
document.getElementById('btn-copy-link').addEventListener('click', () => {
  const link = `${location.origin}${location.pathname}?room=${roomCode}`;
  navigator.clipboard.writeText(link);
  const btn = document.getElementById('btn-copy-link');
  btn.textContent = 'Copied!';
  setTimeout(() => (btn.textContent = 'Copy invite link'), 1400);
});

socket.on('peer-joined', (data) => {
  peerName = (data && data.name) || 'Guest';
  if (screens.waiting.classList.contains('hidden') === false) {
    enterPlayerScreen();
  }
  setPeerConnected(true);
});

socket.on('peer-left', () => {
  peerName = '';
  setPeerConnected(false);
});

socket.on('kicked', () => {
  alert('The other person removed you from the room.');
  resetToEntry();
});

function enterPlayerScreen() {
  document.getElementById('topbar-code').textContent = roomCode;
  showScreen('player');
}

function resetToEntry() {
  if (player && player.destroy) { player.destroy(); }
  player = null;
  currentMediaId = null;
  currentMediaType = null;
  lastKnownState = null;
  queueState = [];
  document.getElementById('queue-list').querySelectorAll('.queue-item').forEach((n) => n.remove());
  document.getElementById('chat-log').innerHTML = '';
  roomCode = null;
  peerName = '';
  document.getElementById('entry-error').textContent = '';
  showScreen('entry');
}

function setPeerConnected(connected) {
  const node = document.getElementById('peer-node');
  const pulse = document.getElementById('sync-pulse');
  const status = document.getElementById('peer-status');
  const transport = document.getElementById('transport');
  const nameTag = document.getElementById('peer-name-tag');
  const kickBtn = document.getElementById('btn-remove-peer');
  node.classList.toggle('connected', connected);
  pulse.classList.toggle('live', connected);
  transport.setAttribute('aria-disabled', String(!connected));
  kickBtn.disabled = !connected;
  nameTag.textContent = connected && peerName ? `with ${peerName}` : '';
  if (connected) {
    status.classList.add('hidden');
  } else {
    status.classList.remove('hidden');
    status.textContent = 'The other person left. Waiting for them to reconnect…';
  }
}

// ---------- Leave / Remove ----------
document.getElementById('btn-leave').addEventListener('click', () => {
  if (!confirm('Leave this room?')) return;
  socket.emit('leave-room');
  resetToEntry();
});
document.getElementById('btn-remove-peer').addEventListener('click', () => {
  if (!peerName) return;
  if (!confirm(`Remove ${peerName} from the room?`)) return;
  socket.emit('kick-peer');
  peerName = '';
  setPeerConnected(false);
});

// ---------- Latency ping ----------
setInterval(() => {
  socket.emit('ping-check', Date.now());
}, 3000);
socket.on('pong-check', (t0) => {
  const rtt = Date.now() - t0;
  document.getElementById('sync-ms').textContent = `${rtt} ms`;
});

// ---------- YouTube player ----------
let player = null;
let currentMediaType = null; // 'video' | 'playlist'
let currentMediaId = null;
let suppressBroadcast = false;
let expectedTime = 0;
let lastKnownState = null; // 1 playing, 2 paused
let lastPlaylistIndex = 0;

function onYouTubeIframeAPIReady() {
  // Player is created lazily on first video load — nothing to do yet.
}

function ensurePlayer(mediaType, mediaId, startSeconds, autoplay, index) {
  currentMediaType = mediaType;
  currentMediaId = mediaId;
  lastPlaylistIndex = index || 0;

  const baseVars = { autoplay: autoplay ? 1 : 0, rel: 0, modestbranding: 1, playsinline: 1 };
  const playerVars = mediaType === 'playlist'
    ? { ...baseVars, listType: 'playlist', list: mediaId, index: index || 0 }
    : { ...baseVars, start: Math.max(0, Math.floor(startSeconds || 0)) };

  if (!player) {
    player = new YT.Player('player-mount', {
      videoId: mediaType === 'video' ? mediaId : undefined,
      playerVars,
      events: {
        onReady: () => watchDrift(),
        onStateChange: onPlayerStateChange,
      },
    });
  } else if (mediaType === 'playlist') {
    player.loadPlaylist({ list: mediaId, index: index || 0 });
  } else {
    player.loadVideoById({ videoId: mediaId, startSeconds: startSeconds || 0 });
    if (!autoplay) setTimeout(() => player.pauseVideo(), 400);
  }
}

function onPlayerStateChange(e) {
  if (suppressBroadcast) return;
  const idx = currentMediaType === 'playlist' && player.getPlaylistIndex ? player.getPlaylistIndex() : 0;
  lastPlaylistIndex = idx;
  if (e.data === YT.PlayerState.PLAYING) {
    lastKnownState = 1;
    broadcast({ type: 'play', time: player.getCurrentTime(), mediaType: currentMediaType, mediaId: currentMediaId, index: idx });
  } else if (e.data === YT.PlayerState.PAUSED) {
    lastKnownState = 2;
    broadcast({ type: 'pause', time: player.getCurrentTime(), mediaType: currentMediaType, mediaId: currentMediaId, index: idx });
  }
  updateTransportIcon();
}

// Poll for local seeks and playlist track changes that aren't play/pause events
function watchDrift() {
  setInterval(() => {
    if (!player || !player.getCurrentTime || suppressBroadcast) return;

    if (currentMediaType === 'playlist' && player.getPlaylistIndex) {
      const idx = player.getPlaylistIndex();
      if (idx !== lastPlaylistIndex) {
        lastPlaylistIndex = idx;
        broadcast({ type: lastKnownState === 1 ? 'play' : 'pause', time: player.getCurrentTime(), mediaType: 'playlist', mediaId: currentMediaId, index: idx });
      }
    }

    if (lastKnownState !== 1) { expectedTime = player.getCurrentTime(); return; }
    const now = player.getCurrentTime();
    const diff = Math.abs(now - expectedTime);
    if (diff > 1.5) {
      broadcast({ type: 'seek', time: now, mediaType: currentMediaType, mediaId: currentMediaId, index: lastPlaylistIndex });
    }
    expectedTime = now + 1; // ~1s tick
    updateTimeReadout();
  }, 1000);
}

function updateTimeReadout() {
  if (!player || !player.getDuration) return;
  const cur = player.getCurrentTime() || 0;
  const dur = player.getDuration() || 0;
  document.getElementById('time-readout').textContent = `${fmt(cur)} / ${fmt(dur)}`;
}
function fmt(s) {
  s = Math.floor(s);
  const m = Math.floor(s / 60);
  const sec = String(s % 60).padStart(2, '0');
  return `${m}:${sec}`;
}

function broadcast(payload) {
  socket.emit('sync-event', payload);
}

socket.on('sync-event', (payload) => applyRemote(payload));

function applyRemote(payload) {
  const { type, time, mediaType, mediaId, index, serverTime } = payload;
  const latencySec = Math.max(0, (Date.now() - serverTime) / 1000);
  suppressBroadcast = true;

  const mediaChanged = mediaId && (mediaId !== currentMediaId || mediaType !== currentMediaType);
  const playlistTrackChanged = mediaType === 'playlist' && !mediaChanged && typeof index === 'number' && index !== lastPlaylistIndex;

  if (mediaChanged) {
    ensurePlayer(mediaType, mediaId, time, type !== 'pause', index);
    lastKnownState = type === 'pause' ? 2 : 1;
  } else if (playlistTrackChanged && player && player.playVideoAt) {
    lastPlaylistIndex = index;
    player.playVideoAt(index);
    if (type === 'pause') setTimeout(() => player.pauseVideo(), 400);
    lastKnownState = type === 'pause' ? 2 : 1;
  } else if (player) {
    if (type === 'play') {
      player.seekTo(time + latencySec, true);
      player.playVideo();
      lastKnownState = 1;
    } else if (type === 'pause') {
      player.seekTo(time, true);
      player.pauseVideo();
      lastKnownState = 2;
    } else if (type === 'seek') {
      player.seekTo(time + (lastKnownState === 1 ? latencySec : 0), true);
    }
  }
  updateTransportIcon();
  setTimeout(() => (suppressBroadcast = false), 800);
}

function updateTransportIcon() {
  const btn = document.getElementById('btn-playpause');
  btn.textContent = lastKnownState === 1 ? '⏸' : '▶';
}

// ---------- Load form: "Play now" and "Add to queue" ----------
document.getElementById('form-load').addEventListener('submit', (e) => {
  e.preventDefault();
  playInputNow();
});
document.getElementById('btn-queue-add').addEventListener('click', () => {
  queueAddFromInput();
});

async function playInputNow() {
  const input = document.getElementById('input-url');
  const raw = input.value.trim();
  const media = extractMedia(raw);
  if (!media) {
    alert("Couldn't find a YouTube video or playlist in that link.");
    return;
  }
  suppressBroadcast = true;
  ensurePlayer(media.type, media.id, 0, true, 0);
  lastKnownState = 1;
  setTimeout(() => (suppressBroadcast = false), 800);
  broadcast({ type: 'load', time: 0, mediaType: media.type, mediaId: media.id, index: 0 });
  input.value = '';
}

async function queueAddFromInput() {
  const input = document.getElementById('input-url');
  const raw = input.value.trim();
  const media = extractMedia(raw);
  if (!media) {
    alert("Couldn't find a YouTube video or playlist in that link.");
    return;
  }
  const label = await fetchTitle(raw, media.type);
  socket.emit('queue-add', { mediaType: media.type, mediaId: media.id, label });
  input.value = '';
}

// Parses a plain video ID, a youtu.be/watch link, a /shorts/ link, or a full playlist link/ID.
function extractMedia(input) {
  if (/^(PL|UU|FL|RD|OL)[a-zA-Z0-9_-]{10,}$/.test(input)) return { type: 'playlist', id: input };
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return { type: 'video', id: input };
  try {
    const url = new URL(input);
    const list = url.searchParams.get('list');
    if (list && (url.pathname === '/playlist' || !url.searchParams.get('v'))) {
      return { type: 'playlist', id: list };
    }
    if (url.hostname.includes('youtu.be')) return { type: 'video', id: url.pathname.slice(1) };
    if (url.pathname.startsWith('/shorts/')) return { type: 'video', id: url.pathname.split('/')[2] };
    const v = url.searchParams.get('v');
    if (v) return { type: 'video', id: v };
    if (list) return { type: 'playlist', id: list };
  } catch (_) { /* not a URL */ }
  return null;
}

// Best-effort title via YouTube's public oEmbed endpoint (no API key needed). Falls back gracefully.
async function fetchTitle(url, mediaType) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (res.ok) {
      const data = await res.json();
      if (data.title) return data.title;
    }
  } catch (_) { /* offline oEmbed lookup failed, use fallback below */ }
  return mediaType === 'playlist' ? 'YouTube playlist' : 'YouTube video';
}

// ---------- Queue ----------
let queueState = [];
socket.on('queue-update', (queue) => {
  queueState = queue;
  renderQueue();
});

function renderQueue() {
  const list = document.getElementById('queue-list');
  const empty = document.getElementById('queue-empty');
  list.querySelectorAll('.queue-item').forEach((n) => n.remove());
  if (queueState.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  queueState.forEach((item) => {
    const li = document.createElement('li');
    li.className = 'queue-item';
    li.innerHTML = `
      <span class="q-badge">${item.mediaType === 'playlist' ? 'list' : 'video'}</span>
      <span class="q-label">${escapeHtml(item.label)}</span>
      <button class="q-play" title="Play now">▶</button>
      <button class="q-remove" title="Remove">✕</button>
    `;
    li.querySelector('.q-play').addEventListener('click', () => socket.emit('queue-play-now', item.id));
    li.querySelector('.q-remove').addEventListener('click', () => socket.emit('queue-remove', item.id));
    list.appendChild(li);
  });
}

// ---------- Custom play/pause button ----------
document.getElementById('btn-playpause').addEventListener('click', () => {
  if (!player) return;
  if (lastKnownState === 1) player.pauseVideo();
  else player.playVideo();
});

// ---------- Chat ----------
document.getElementById('form-chat').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('input-chat');
  const text = input.value.trim();
  if (!text) return;
  appendChat(text, 'You', true);
  socket.emit('chat-message', text);
  input.value = '';
});
socket.on('chat-message', (msg) => appendChat(msg.text, msg.name || 'Them', false));

function appendChat(text, who, self) {
  const log = document.getElementById('chat-log');
  const div = document.createElement('div');
  div.className = 'msg' + (self ? ' self' : '');
  div.innerHTML = `<span class="who">${escapeHtml(who)}</span>${escapeHtml(text)}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ---------- Mute toggle ----------
document.getElementById('btn-mute').addEventListener('click', () => {
  if (!player || !player.isMuted) return;
  const btn = document.getElementById('btn-mute');
  if (player.isMuted()) { player.unMute(); btn.textContent = '🔊'; }
  else { player.mute(); btn.textContent = '🔇'; }
});

// ---------- Picture-in-Picture (moves the live player into a floating window) ----------
const stageEl = document.querySelector('.stage');
const stageParent = stageEl.parentNode;
const stageNextSibling = stageEl.nextSibling;
let pipWindow = null;

document.getElementById('btn-pip').addEventListener('click', togglePiP);

async function togglePiP() {
  if (pipWindow) { pipWindow.close(); return; }
  if (!('documentPictureInPicture' in window)) {
    alert('Picture-in-picture needs a Chromium browser — Chrome or Edge on desktop, or Chrome on Android.');
    return;
  }
  pipWindow = await window.documentPictureInPicture.requestWindow({ width: 420, height: 236 });

  // Carry over styling so the moved player still looks right in the floating window
  [...document.styleSheets].forEach((sheet) => {
    try {
      const css = [...sheet.cssRules].map((r) => r.cssText).join('');
      const style = pipWindow.document.createElement('style');
      style.textContent = css;
      pipWindow.document.head.appendChild(style);
    } catch (_) {
      const link = pipWindow.document.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      pipWindow.document.head.appendChild(link);
    }
  });
  pipWindow.document.body.style.margin = '0';
  pipWindow.document.body.style.background = '#000';
  pipWindow.document.body.appendChild(stageEl);

  pipWindow.addEventListener('pagehide', () => {
    stageParent.insertBefore(stageEl, stageNextSibling);
    pipWindow = null;
  });
}
