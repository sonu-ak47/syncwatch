const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// In-memory room state: { code: { members: Set<socketId>, video: {...}, state: {...} } }
const rooms = new Map();

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('create-room', (_, cb) => {
    const code = genCode();
    rooms.set(code, { members: new Set([socket.id]), lastState: null });
    socket.join(code);
    currentRoom = code;
    cb({ ok: true, code });
  });

  socket.on('join-room', (code, cb) => {
    code = (code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Room not found. Check the code.' });
    if (room.members.size >= 2) return cb({ ok: false, error: 'Room is full (2 people max).' });
    room.members.add(socket.id);
    socket.join(code);
    currentRoom = code;
    cb({ ok: true, code, lastState: room.lastState });
    socket.to(code).emit('peer-joined');
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

  socket.on('chat-message', (msg) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit('chat-message', { text: String(msg).slice(0, 500), self: false });
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    room.members.delete(socket.id);
    socket.to(currentRoom).emit('peer-left');
    if (room.members.size === 0) rooms.delete(currentRoom);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SyncWatch running on http://localhost:${PORT}`));
