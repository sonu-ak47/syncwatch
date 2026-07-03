const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory room state: { code: { members: Map<socketId, name>, lastState: {...}, queue: [...] } }
const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function genQueueId() {
  return Math.random().toString(36).slice(2, 10);
}

function cleanName(name) {
  const n = String(name || '').trim().slice(0, 24);
  return n || 'Guest';
}

function otherMember(room, socketId) {
  for (const [id, name] of room.members) {
    if (id !== socketId) return { id, name };
  }
  return null;
}

io.on('connection', (socket) => {
  let currentRoom = null;
  let myName = 'Guest';

  socket.on('create-room', (payload, cb) => {
    const name = cleanName(payload && payload.name);
    const code = genCode();
    rooms.set(code, { members: new Map([[socket.id, name]]), lastState: null, queue: [] });
    socket.join(code);
    currentRoom = code;
    myName = name;
    cb({ ok: true, code });
  });

  socket.on('join-room', (payload, cb) => {
    const code = String((payload && payload.code) || '').trim().toUpperCase();
    const name = cleanName(payload && payload.name);
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Room not found. Check the code.' });
    if (room.members.size >= 2) return cb({ ok: false, error: 'Room is full (2 people max).' });
    const peer = otherMember(room, socket.id);
    room.members.set(socket.id, name);
    socket.join(code);
    currentRoom = code;
    myName = name;
    cb({ ok: true, code, lastState: room.lastState, queue: room.queue, peerName: peer ? peer.name : null });
    socket.to(code).emit('peer-joined', { name });
  });

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
      id: genQueueId(),
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
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (room) {
      room.members.delete(socket.id);
      socket.to(currentRoom).emit('peer-left', { kicked: false });
      if (room.members.size === 0) rooms.delete(currentRoom);
    }
    socket.leave(currentRoom);
    currentRoom = null;
  });

  // Remove the other person from the room (only meaningful with exactly 2 members)
  socket.on('kick-peer', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    const peer = otherMember(room, socket.id);
    if (!peer) return;
    room.members.delete(peer.id);
    const peerSocket = io.sockets.sockets.get(peer.id);
    if (peerSocket) {
      peerSocket.leave(currentRoom);
      peerSocket.emit('kicked');
    }
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.members.delete(socket.id);
    socket.to(currentRoom).emit('peer-left', { kicked: false });
    if (room.members.size === 0) rooms.delete(currentRoom);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SyncWatch running on http://localhost:${PORT}`));
