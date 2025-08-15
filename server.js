const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// If you later host the frontend elsewhere (e.g., GitHub Pages),
// set a strict CORS origin list here.
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Serve static frontend (same origin = easiest on Render)
app.use(express.static(path.join(__dirname, 'public')));

const keyToSocket = new Map(); // key -> socket.id

io.on('connection', (socket) => {
  // Register this device under a short key
  socket.on('register-key', (key) => {
    if (socket.data.key) keyToSocket.delete(socket.data.key);
    socket.data.key = key;
    keyToSocket.set(key, socket.id);
    socket.emit('registered', { key });
  });

  // A wants to link with B
  socket.on('link-request', ({ targetKey, fromKey }) => {
    const targetId = keyToSocket.get(targetKey);
    if (!targetId) return socket.emit('link-error', { message: 'Target key not online.' });
    io.to(targetId).emit('incoming-link-request', { fromKey });
  });

  // B accepts/rejects
  socket.on('link-response', ({ targetKey, accepted }) => {
    const targetId = keyToSocket.get(targetKey);
    if (!targetId) return;
    io.to(targetId).emit('link-response', { accepted, fromKey: socket.data.key });
  });

  // WebRTC signaling relay
  socket.on('webrtc-offer', ({ targetKey, sdp }) => {
    const targetId = keyToSocket.get(targetKey);
    if (targetId) io.to(targetId).emit('webrtc-offer', { sdp, fromKey: socket.data.key });
  });
  socket.on('webrtc-answer', ({ targetKey, sdp }) => {
    const targetId = keyToSocket.get(targetKey);
    if (targetId) io.to(targetId).emit('webrtc-answer', { sdp, fromKey: socket.data.key });
  });
  socket.on('ice-candidate', ({ targetKey, candidate }) => {
    const targetId = keyToSocket.get(targetKey);
    if (targetId) io.to(targetId).emit('ice-candidate', { candidate, fromKey: socket.data.key });
  });

  socket.on('disconnect', () => {
    if (socket.data.key) keyToSocket.delete(socket.data.key);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running on :' + PORT));
