const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Longer ping tolerance: mobile browsers throttle background tabs and can
// miss a heartbeat or two without actually losing the connection. This keeps
// short blips from ever reaching a real "disconnect" at all.
const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
});

app.use(express.static(path.join(__dirname, 'public')));

// Grace period: if someone's socket drops (wifi blip, phone locked, tab
// backgrounded, host recycling an idle connection), don't tell the other
// person yet — wait to see if they reconnect first.
const RECONNECT_GRACE_MS = 20000;

// In-memory room state:
// { code: { members: Map<clientId, {name, socketId, disconnectTimer}>, lastState, queue } }
const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function cleanName(name) {
  const n = String(name || '').trim().slice(0, 24);
  return n || 'Guest';
}

function otherMember(room, clientId) {
  for (const [id, info] of room.members) {
    if (id !== clientId) return { id, name: info.name };
  }
  return null;
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let myName = 'Guest';
  let myClientId = null;

  function joinOrRejoin(payload, cb) {
    const code = String((payload && payload.code) || '').trim().toUpperCase();
    const name = cleanName(payload && payload.name);
    const clientId = String((payload && payload.clientId) || '').slice(0, 64) || genId();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Room not found. Check the code.' });

    const existing = room.members.get(clientId);
    if (existing) {
      // Same person reconnecting — restore them silently, no "room full" check needed.
      if (existing.disconnectTimer) {
        clearTimeout(existing.disconnectTimer);
        existing.disconnectTimer = null;
      }
      existing.socketId = socket.id;
      existing.name = name;
      socket.join(code);
      currentRoom = code;
      myName = name;
      myClientId = clientId;
      const peer = otherMember(room, clientId);
      cb({ ok: true, code, lastState: room.lastState, queue: room.queue, peerName: peer ? peer.name : null });
      socket.to(code).emit('peer-joined', { name });
      return;
    }

    if (room.members.size >= 2) return cb({ ok: false, error: 'Room is full (2 people max).' });
    const peer = otherMember(room, clientId);
    room.members.set(clientId, { name, socketId: socket.id, disconnectTimer: null });
    socket.join(code);
    currentRoom = code;
    myName = name;
    myClientId = clientId;
    cb({ ok: true, code, lastState: room.lastState, queue: room.queue, peerName: peer ? peer.name : null });
    socket.to(code).emit('peer-joined', { name });
  }

  socket.on('create-room', (payload, cb) => {
    const name = cleanName(payload && payload.name);
    const clientId = String((payload && payload.clientId) || '').slice(0, 64) || genId();
    const code = genCode();
    rooms.set(code, {
      members: new Map([[clientId, { name, socketId: socket.id, disconnectTimer: null }]]),
      lastState: null,
      queue: [],
    });
    socket.join(code);
    currentRoom = code;
    myName = name;
    myClientId = clientId;
    cb({ ok: true, code });
  });

  socket.on('join-room', joinOrRejoin);

  // Relay play/pause/seek/load events with server timestamp for drift correction
  socket.on('sync-event', (payload) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const stamped = { ...payload, serverTime: Date.now() };
    room.lastState = stamped;
    socket.to(currentRoom).emit('sync-event', stamped);
  });

  // Ping/pong for live latency display
  socket.on('ping-check', (t0) => {
    socket.emit('pong-check', t0);
  });

  // Queue: add a video/playlist without interrupting current playback
  socket.on('queue-add', (item) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const entry = {
      id: genId(),
      mediaType: item.mediaType === 'playlist' ? 'playlist' : 'video',
      mediaId: String(item.mediaId || '').slice(0, 64),
      label: String(item.label || 'YouTube video').slice(0, 120),
    };
    room.queue.push(entry);
    io.to(currentRoom).emit('queue-update', room.queue);
  });

  socket.on('queue-remove', (queueId) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.queue = room.queue.filter((q) => q.id !== queueId);
    io.to(currentRoom).emit('queue-update', room.queue);
  });

  // Play a queued item immediately for both people, then drop it from the queue
  socket.on('queue-play-now', (queueId) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const item = room.queue.find((q) => q.id === queueId);
    if (!item) return;
    room.queue = room.queue.filter((q) => q.id !== queueId);
    io.to(currentRoom).emit('queue-update', room.queue);
    const stamped = {
      type: 'load',
      mediaType: item.mediaType,
      mediaId: item.mediaId,
      time: 0,
      serverTime: Date.now(),
    };
    room.lastState = stamped;
    io.to(currentRoom).emit('sync-event', stamped);
  });

  socket.on('chat-message', (msg) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('chat-message', { text: String(msg).slice(0, 500), name: myName });
  });

  // Voluntary leave: frees the seat for someone else without deleting the room
  socket.on('leave-room', () => {
    if (!currentRoom || !myClientId) return;
    const room = rooms.get(currentRoom);
    if (room) {
      const info = room.members.get(myClientId);
      if (info && info.disconnectTimer) clearTimeout(info.disconnectTimer);
      room.members.delete(myClientId);
      socket.to(currentRoom).emit('peer-left', { kicked: false });
      if (room.members.size === 0) rooms.delete(currentRoom);
    }
    socket.leave(currentRoom);
    currentRoom = null;
  });

  // Remove the other person from the room (only meaningful with exactly 2 members)
  socket.on('kick-peer', () => {
    if (!currentRoom || !myClientId) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const peer = otherMember(room, myClientId);
    if (!peer) return;
    const info = room.members.get(peer.id);
    if (info && info.disconnectTimer) clearTimeout(info.disconnectTimer);
    room.members.delete(peer.id);
    if (info && info.socketId) {
      const peerSocket = io.sockets.sockets.get(info.socketId);
      if (peerSocket) {
        peerSocket.leave(currentRoom);
        peerSocket.emit('kicked');
      }
    }
  });

  socket.on('disconnect', () => {
    if (!currentRoom || !myClientId) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const info = room.members.get(myClientId);
    // If a newer connection from the same person already replaced this one, do nothing.
    if (!info || info.socketId !== socket.id) return;
    info.disconnectTimer = setTimeout(() => {
      room.members.delete(myClientId);
      io.to(currentRoom).emit('peer-left', { kicked: false });
      if (room.members.size === 0) rooms.delete(currentRoom);
    }, RECONNECT_GRACE_MS);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SyncWatch running on http://localhost:${PORT}`));
