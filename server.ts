import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Modality } from '@google/genai';

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

  const PORT = Number(process.env.PORT) || 3000;
  const activeGeminiSessions = new Map<string, any>();

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

    // Gemini 3.1 Flash Live Preview Bridge
    socket.on('start-gemini-live', async (data) => {
      const { apiKey, roomId } = data;
      console.log(`[Socket] Starting Gemini Live for socket ${socket.id}, room ${roomId}`);
      
      const existingSession = activeGeminiSessions.get(socket.id);
      if (existingSession) {
        try {
          existingSession.close();
        } catch (e) {}
        activeGeminiSessions.delete(socket.id);
      }

      if (!apiKey) {
        socket.emit('gemini-live-error', '缺少 Gemini API Key');
        return;
      }

      try {
        const ai = new GoogleGenAI({
          apiKey: apiKey,
          httpOptions: {
            headers: {
              'User-Agent': 'aistudio-build',
            }
          }
        });

        let accumulatedText = '';
        let lastInputText = '';

        const session = await ai.live.connect({
          model: 'gemini-3.1-flash-live-preview',
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: 'Aoede'
                }
              }
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction: '你是一個聽障溝通助理。你的任務是將說話者的語音精準地轉錄為文字（繁體中文），同時感知說話者的語氣與情緒，並在合適的地方（例如句尾或語氣轉折處）加上最能呈現該情緒的 Emoji（例如開心用😊、生氣用😠、悲傷用😭、驚訝用😮、疑惑用🤔等）。注意：你只能輸出轉錄的文字和情緒 Emoji，絕對不能發表任何自己的對話或回答！只做精準字面轉寫並加上情緒 Emoji。'
          },
          callbacks: {
            onmessage: (message) => {
              // 1. Process real-time user input transcription (immediate feedback)
              const inputTrans = message.serverContent?.inputTranscription;
              if (inputTrans && inputTrans.text) {
                lastInputText = inputTrans.text;
                console.log(`[Gemini Live] Input transcription: ${lastInputText}`);
                
                socket.emit('gemini-live-chunk', {
                  text: lastInputText,
                  isFinal: false
                });

                if (roomId) {
                  io.to(roomId).emit('receive-transcription', {
                    text: lastInputText,
                    isFinal: false,
                    timestamp: Date.now()
                  });
                }
              }

              // 2. Process real-time model output transcription (refined with emotion analysis and emoji)
              const outputTrans = message.serverContent?.outputTranscription;
              if (outputTrans && outputTrans.text) {
                accumulatedText += outputTrans.text;
                console.log(`[Gemini Live] Output transcription chunk: ${outputTrans.text}`);
                
                socket.emit('gemini-live-chunk', {
                  text: accumulatedText,
                  isFinal: false
                });

                if (roomId) {
                  io.to(roomId).emit('receive-transcription', {
                    text: accumulatedText,
                    isFinal: false,
                    timestamp: Date.now()
                  });
                }
              }

              // 3. Fallback to model turn parts (though when responseModalities is AUDIO, text doesn't show here)
              const parts = message.serverContent?.modelTurn?.parts;
              if (parts) {
                for (const part of parts) {
                  if (part.text) {
                    accumulatedText += part.text;
                    console.log(`[Gemini Live] ModelTurn part text: ${part.text}`);
                    socket.emit('gemini-live-chunk', {
                      text: accumulatedText,
                      isFinal: false
                    });

                    if (roomId) {
                      io.to(roomId).emit('receive-transcription', {
                        text: accumulatedText,
                        isFinal: false,
                        timestamp: Date.now()
                      });
                    }
                  }
                }
              }

              // 4. Handle turn complete to finalize transcription
              if (message.serverContent?.turnComplete) {
                const finalReportText = accumulatedText || lastInputText || '';
                console.log(`[Gemini Live] Turn complete. Final text: "${finalReportText}"`);

                socket.emit('gemini-live-chunk', {
                  text: finalReportText,
                  isFinal: true
                });

                if (roomId) {
                  io.to(roomId).emit('receive-transcription', {
                    text: finalReportText,
                    isFinal: true,
                    timestamp: Date.now()
                  });
                }

                if (finalReportText.trim()) {
                  socket.emit('gemini-live-final', finalReportText);
                }
                accumulatedText = ''; // Reset
                lastInputText = '';   // Reset
              }
            },
            onclose: () => {
              console.log(`[Gemini] Connection closed for socket ${socket.id}`);
              socket.emit('gemini-live-status', 'disconnected');
            },
            onerror: (err: any) => {
              console.error(`[Gemini] Connection error for socket ${socket.id}:`, err);
              socket.emit('gemini-live-error', `連線錯誤: ${err.message || err}`);
            }
          }
        });

        activeGeminiSessions.set(socket.id, session);
        socket.emit('gemini-live-status', 'connected');
        console.log(`[Gemini] Connected to Live API successfully for socket ${socket.id}`);

      } catch (err: any) {
        console.error(`[Gemini] Failed to start Gemini Live for socket ${socket.id}:`, err);
        socket.emit('gemini-live-error', `初始化失敗: ${err.message || err}`);
      }
    });

    socket.on('gemini-audio', (base64PCM) => {
      const session = activeGeminiSessions.get(socket.id);
      if (session) {
        try {
          session.sendRealtimeInput({
            audio: {
              data: base64PCM,
              mimeType: 'audio/pcm;rate=16000'
            }
          });
        } catch (e: any) {
          console.error(`[Gemini] Error sending audio for socket ${socket.id}:`, e);
          socket.emit('gemini-live-error', `傳送音訊失敗: ${e.message}`);
        }
      }
    });

    socket.on('stop-gemini-live', () => {
      const session = activeGeminiSessions.get(socket.id);
      if (session) {
        try {
          session.close();
        } catch (e) {}
        activeGeminiSessions.delete(socket.id);
      }
      socket.emit('gemini-live-status', 'disconnected');
      console.log(`[Gemini] Live session stopped for socket ${socket.id}`);
    });

    socket.on('disconnect', (reason) => {
      console.log(`[Socket] Disconnected ${socket.id}: ${reason}`);
      const session = activeGeminiSessions.get(socket.id);
      if (session) {
        try {
          session.close();
        } catch (e) {}
        activeGeminiSessions.delete(socket.id);
      }
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
