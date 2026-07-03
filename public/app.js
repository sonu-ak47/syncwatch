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

// ---------- Entry screen ----------
document.getElementById('btn-create').addEventListener('click', () => {
  socket.emit('create-room', null, (res) => {
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
  socket.emit('join-room', code, (res) => {
    if (!res.ok) {
      document.getElementById('entry-error').textContent = res.error;
      return;
    }
    roomCode = res.code;
    enterPlayerScreen();
    setPeerConnected(true);
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

socket.on('peer-joined', () => {
  if (screens.waiting.classList.contains('hidden') === false) {
    enterPlayerScreen();
  }
  setPeerConnected(true);
});

socket.on('peer-left', () => {
  setPeerConnected(false);
});

function enterPlayerScreen() {
  document.getElementById('topbar-code').textContent = roomCode;
  showScreen('player');
}

function setPeerConnected(connected) {
  const node = document.getElementById('peer-node');
  const pulse = document.getElementById('sync-pulse');
  const status = document.getElementById('peer-status');
  const transport = document.getElementById('transport');
  node.classList.toggle('connected', connected);
  pulse.classList.toggle('live', connected);
  transport.setAttribute('aria-disabled', String(!connected));
  if (connected) {
    status.classList.add('hidden');
  } else {
    status.classList.remove('hidden');
    status.textContent = 'The other person left. Waiting for them to reconnect…';
  }
}

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
let currentVideoId = null;
let suppressBroadcast = false;
let expectedTime = 0;
let lastKnownState = null; // 1 playing, 2 paused

function onYouTubeIframeAPIReady() {
  // Player is created lazily on first video load — nothing to do yet.
}

function ensurePlayer(videoId, startSeconds, autoplay) {
  currentVideoId = videoId;
  if (!player) {
    player = new YT.Player('player-mount', {
      videoId,
      playerVars: {
        autoplay: autoplay ? 1 : 0,
        start: Math.max(0, Math.floor(startSeconds || 0)),
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
      },
      events: {
        onReady: () => watchDrift(),
        onStateChange: onPlayerStateChange,
      },
    });
  } else {
    player.loadVideoById({ videoId, startSeconds: startSeconds || 0 });
    if (!autoplay) setTimeout(() => player.pauseVideo(), 400);
  }
}

function onPlayerStateChange(e) {
  if (suppressBroadcast) return;
  if (e.data === YT.PlayerState.PLAYING) {
    lastKnownState = 1;
    broadcast({ type: 'play', time: player.getCurrentTime(), videoId: currentVideoId });
  } else if (e.data === YT.PlayerState.PAUSED) {
    lastKnownState = 2;
    broadcast({ type: 'pause', time: player.getCurrentTime(), videoId: currentVideoId });
  }
  updateTransportIcon();
}

// Poll for local seeks (jumps on the timeline that aren't play/pause events)
function watchDrift() {
  setInterval(() => {
    if (!player || !player.getCurrentTime || suppressBroadcast) return;
    if (lastKnownState !== 1) { expectedTime = player.getCurrentTime(); return; }
    const now = player.getCurrentTime();
    const diff = Math.abs(now - expectedTime);
    if (diff > 1.5) {
      broadcast({ type: 'seek', time: now, videoId: currentVideoId });
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
  const { type, time, videoId, serverTime } = payload;
  const latencySec = Math.max(0, (Date.now() - serverTime) / 1000);
  suppressBroadcast = true;

  if (videoId && videoId !== currentVideoId) {
    ensurePlayer(videoId, time, type !== 'pause');
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

// ---------- Load form ----------
document.getElementById('form-load').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = document.getElementById('input-url').value.trim();
  const videoId = extractVideoId(raw);
  if (!videoId) {
    alert("Couldn't find a YouTube video in that link. Paste a full YouTube or YouTube Music URL.");
    return;
  }
  suppressBroadcast = true;
  ensurePlayer(videoId, 0, true);
  lastKnownState = 1;
  setTimeout(() => (suppressBroadcast = false), 800);
  broadcast({ type: 'load', time: 0, videoId });
  document.getElementById('input-url').value = '';
});

function extractVideoId(input) {
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input; // raw video ID
  try {
    const url = new URL(input);
    if (url.hostname.includes('youtu.be')) return url.pathname.slice(1);
    if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2];
    const v = url.searchParams.get('v');
    if (v) return v;
  } catch (_) { /* not a URL */ }
  return null;
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
  appendChat(text, true);
  socket.emit('chat-message', text);
  input.value = '';
});
socket.on('chat-message', (msg) => appendChat(msg.text, false));

function appendChat(text, self) {
  const log = document.getElementById('chat-log');
  const div = document.createElement('div');
  div.className = 'msg' + (self ? ' self' : '');
  div.innerHTML = `<span class="who">${self ? 'you' : 'them'}</span>${escapeHtml(text)}`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}
function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
