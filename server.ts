import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Modality } from '@google/genai';

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
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
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction: '你是一個聽障溝通助理。你的任務是將說話者的語音精準地轉錄為文字（繁體中文）。注意：你只能輸出轉錄的文字，絕對不能發表任何自己的對話或回答！只做精準字面轉寫。'
          },
          callbacks: {
            onmessage: (message) => {
              console.log('[Gemini Live Incoming]', JSON.stringify(message));
              
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

              // 2. Process real-time model output transcription
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

                if (finalReportText.trim()) {
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
          // Send client Content turnComplete to trigger final generation turn
          session.send({ clientContent: { turnComplete: true } });
        } catch (e) {
          console.error('[Gemini] Error sending turnComplete:', e);
        }
        
        // Wait briefly for the model to output final transcription, then close
        setTimeout(() => {
          try {
            session.close();
          } catch (e) {}
          activeGeminiSessions.delete(socket.id);
          socket.emit('gemini-live-status', 'disconnected');
          console.log(`[Gemini] Live session stopped for socket ${socket.id}`);
        }, 5000);
      } else {
        socket.emit('gemini-live-status', 'disconnected');
      }
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

  // Gemini standard REST transcription route (Highly reliable single-phrase mode)
  app.post('/api/gemini-transcribe', async (req, res) => {
    const { apiKey, audio, mimeType } = req.body;

    if (!apiKey) {
      return res.status(400).json({ error: '缺少 Gemini API Key' });
    }
    if (!audio) {
      return res.status(400).json({ error: '缺少音訊資料' });
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

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            inlineData: {
              data: audio,
              mimeType: mimeType || 'audio/webm'
            }
          },
          '請精準地轉錄這段錄音。你只能輸出轉錄的文字，不要包含任何指導詞或引導指令！'
        ],
        config: {
          systemInstruction: '你是一個聽障溝通助理。請將錄音精準地轉錄為繁體中文（台灣）。注意：你只能輸出轉錄得到的原始文字，絕對不能發表任何自己的對話、回答或任何引導詞！不做解釋，只做精準字面轉寫。'
        }
      });

      const text = response.text || '';
      res.json({ text: text.trim() });
    } catch (err: any) {
      console.error('[Gemini Transcribe Error]:', err);
      res.status(500).json({ error: err.message || '語音轉錄失敗' });
    }
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
