import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    },
    allowEIO3: true,
    pingTimeout: 60000,
    pingInterval: 25000
  });

  const PORT = process.env.PORT || 3000;

  // Socket.io logic
  io.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`);

    socket.on('join-room', (roomId) => {
      if (!roomId) return;
      socket.join(roomId);
      console.log(`[Socket] ${socket.id} joined room ${roomId}`);
      socket.to(roomId).emit('peer-joined', socket.id);
    });

    socket.on('send-transcription', (data) => {
      if (!data.roomId) return;
      socket.to(data.roomId).emit('receive-transcription', {
        text: data.text,
        isFinal: data.isFinal,
        timestamp: Date.now()
      });
    });

    socket.on('disconnect', (reason) => {
      console.log(`[Socket] Disconnected ${socket.id}: ${reason}`);
    });
  });

  // Health check for monitoring
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', connections: io.engine.clientsCount });
  });

  // Vite integration
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer();
