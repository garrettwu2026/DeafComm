import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  const PORT = 3000;

  // Socket.io logic
  io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join-room', (roomId) => {
      socket.join(roomId);
      console.log(`[Socket] ${socket.id} joined room ${roomId}`);
      // Notify the room that someone else joined
      socket.to(roomId).emit('peer-joined', socket.id);
    });

    socket.on('send-transcription', (data) => {
      // data: { roomId: string, text: string, isFinal: boolean }
      if (!data.roomId) return;
      
      console.log(`[Relay] Room ${data.roomId}: "${data.text.substring(0, 20)}..."`);
      
      socket.to(data.roomId).emit('receive-transcription', {
        text: data.text,
        isFinal: data.isFinal,
        timestamp: Date.now()
      });
    });

    socket.on('disconnect', () => {
      console.log('User disconnected:', socket.id);
    });
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
