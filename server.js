const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const keyToSocket = new Map(); // key -> socket.id

io.on('connection', (socket) => {
  console.log('socket connected', socket.id);

  socket.on('register-key', (key) => {
    console.log('register-key', key, socket.id);
    keyToSocket.set(key, socket.id);
    socket.data.key = key;
    socket.emit('registered', key);
  });

  socket.on('link-request', ({ targetKey, fromKey }) => {
    const targetSocketId = keyToSocket.get(targetKey);
    if (targetSocketId) {
      io.to(targetSocketId).emit('incoming-link-request', { fromKey });
    } else {
      socket.emit('link-error', { message: 'Target key not found' });
    }
  });

  socket.on('link-response', ({ targetKey, accepted }) => {
    const targetSocketId = keyToSocket.get(targetKey);
    if (targetSocketId) {
      io.to(targetSocketId).emit('link-response', { accepted, fromKey: socket.data.key });
    }
  });

  // WebRTC signaling forwarding
  socket.on('webrtc-offer', ({ targetKey, sdp }) => {
    const targetSocketId = keyToSocket.get(targetKey);
    if (targetSocketId) {
      io.to(targetSocketId).emit('webrtc-offer', { sdp, fromKey: socket.data.key });
    }
  });

  socket.on('webrtc-answer', ({ targetKey, sdp }) => {
    const targetSocketId = keyToSocket.get(targetKey);
    if (targetSocketId) {
      io.to(targetSocketId).emit('webrtc-answer', { sdp, fromKey: socket.data.key });
    }
  });

  socket.on('ice-candidate', ({ targetKey, candidate }) => {
    const targetSocketId = keyToSocket.get(targetKey);
    if (targetSocketId) {
      io.to(targetSocketId).emit('ice-candidate', { candidate, fromKey: socket.data.key });
    }
  });

  socket.on('disconnect', () => {
    console.log('disconnect', socket.id);
    if (socket.data.key) keyToSocket.delete(socket.data.key);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on :${PORT}`));
