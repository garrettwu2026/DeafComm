import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, Square, Settings, History, ArrowLeft, Trash2, FlipVertical, MessageSquare, Share, Loader2, Monitor } from 'lucide-react';
import { io, Socket } from 'socket.io-client';
import { QRCodeSVG } from 'qrcode.react';

type View = 'main' | 'settings' | 'history';
type RecognitionEngine = 'web-speech' | 'whisper' | 'whisper-stream';

interface HistoryItem {
  id: string;
  text: string;
  date: number;
}

export default function App() {
  const [view, setView] = useState<View>('main');
  const [apiKey, setApiKey] = useState('');
  const [recognitionEngine, setRecognitionEngine] = useState<RecognitionEngine>('whisper');
  const [isMirrorMode, setIsMirrorMode] = useState(false);
  const [isContinuousMode, setIsContinuousMode] = useState(false);
  const [isChatView, setIsChatView] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [fontSize, setFontSize] = useState(48);
  const [isVibrationEnabled, setIsVibrationEnabled] = useState(true);
  
  // Casting states
  const [isCasting, setIsCasting] = useState(false);
  const [castSessionId, setCastSessionId] = useState('');
  const [isReceiverMode, setIsReceiverMode] = useState(false);
  const [receiverText, setReceiverText] = useState('');
  const [showQR, setShowQR] = useState(false);
  const [isSocketConnected, setIsSocketConnected] = useState(false);
  const socketRef = useRef<Socket | null>(null);
  const lastEmittedTextRef = useRef<string>('');

  const [isRecording, setIsRecording] = useState(false);
  const [currentText, setCurrentText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const [vadStatus, setVadStatus] = useState<'listening' | 'silence' | 'stopping'>('listening');

  // Refs for recording and VAD
  const isRecordingRef = useRef(false);
  const recordingModeRef = useRef<RecognitionEngine | null>(null);
  const isContinuousModeRef = useRef(false);
  const currentTextRef = useRef('');
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recognitionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const streamIntervalRef = useRef<any>(null);
  const isInterimProcessingRef = useRef(false);
  
  // Refs for Audio Visualizer & VAD
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastAudioTimeRef = useRef<number>(Date.now());
  const hasSpokenRef = useRef<boolean>(false);
  const vadStatusRef = useRef<'listening' | 'silence' | 'stopping'>('listening');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesEndRefTop = useRef<HTMLDivElement>(null);

  // Ref for Screen Wake Lock
  const wakeLockRef = useRef<any>(null);

  // Request Screen Wake Lock
  const requestWakeLock = async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
      }
    } catch (err) {
      console.log('Wake Lock error:', err);
    }
  };

  useEffect(() => {
    requestWakeLock();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (wakeLockRef.current) {
        wakeLockRef.current.release();
      }
    };
  }, []);

  useEffect(() => {
    const handleResize = () => {
      if (canvasRef.current) {
        canvasRef.current.width = window.innerWidth;
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Load settings on mount
  useEffect(() => {
    const savedKey = localStorage.getItem('openai_api_key') || '';
    const savedMirror = localStorage.getItem('mirror_mode') === 'true';
    const savedContinuous = localStorage.getItem('continuous_mode') === 'true';
    const savedChatView = localStorage.getItem('chat_view_mode') === 'true';
    const savedHistory = JSON.parse(localStorage.getItem('transcription_history') || '[]');
    const savedFontSize = parseInt(localStorage.getItem('font_size') || '48', 10);
    const savedVibration = localStorage.getItem('vibration_enabled') !== 'false';
    const savedEngine = localStorage.getItem('recognition_engine') || (localStorage.getItem('use_web_speech') === 'true' ? 'web-speech' : 'whisper');
    
    setApiKey(savedKey);
    setRecognitionEngine(savedEngine as RecognitionEngine);
    setIsMirrorMode(savedMirror);
    setIsContinuousMode(savedContinuous);
    isContinuousModeRef.current = savedContinuous;
    setIsChatView(savedChatView);
    setHistory(savedHistory);
    setFontSize(savedFontSize);
    setIsVibrationEnabled(savedVibration);

    // Check for receiver mode
    const urlParams = new URLSearchParams(window.location.search);
    const session = urlParams.get('session');
    if (session) {
      setIsReceiverMode(true);
      setCastSessionId(session);
    }
  }, []);

  // Handle Socket Connection
  useEffect(() => {
    if ((isReceiverMode || isCasting) && castSessionId) {
      // Use explicit transports and path if needed, though default usually works
      // Added reconnection logic and status tracking
      socketRef.current = io({
        transports: ['polling', 'websocket'], // Start with polling, upgrade to websocket
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000
      });

      const socket = socketRef.current;

      socket.on('connect', () => {
        console.log('Socket Connected:', socket.id);
        setIsSocketConnected(true);
        socket.emit('join-room', castSessionId);
      });

      socket.on('disconnect', () => {
        console.log('Socket Disconnected');
        setIsSocketConnected(false);
      });

      socket.on('connect_error', (error) => {
        console.error('Socket Connection Error:', error);
      });

      if (isReceiverMode) {
        socket.on('receive-transcription', (data: { text: string }) => {
          setReceiverText(data.text);
        });
      }

      return () => {
        socket.disconnect();
        socketRef.current = null;
        setIsSocketConnected(false);
      };
    }
  }, [isReceiverMode, isCasting, castSessionId]);

  // Sync current text to socket
  useEffect(() => {
    if (isCasting && socketRef.current && isSocketConnected && currentText !== lastEmittedTextRef.current) {
      socketRef.current.emit('send-transcription', {
        roomId: castSessionId,
        text: currentText,
        isFinal: !isProcessing
      });
      lastEmittedTextRef.current = currentText;
    }
  }, [currentText, isProcessing, isCasting, castSessionId, isSocketConnected]);

  // Auto-scroll for chat view and big text
  useEffect(() => {
    if (view === 'main') {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      messagesEndRefTop.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [history, currentText, isChatView, view]);

  // Save settings when they change
  const saveSettings = (key: string, engine: RecognitionEngine, mirror: boolean, continuous: boolean, size: number, vibration: boolean) => {
    // If mode changed, stop current recording to prevent state mismatch
    if (engine !== recognitionEngine && isRecordingRef.current) {
      stopRecording();
    }

    localStorage.setItem('openai_api_key', key);
    localStorage.setItem('recognition_engine', engine);
    // Also save legacy flag for compatibility if needed
    localStorage.setItem('use_web_speech', String(engine === 'web-speech'));
    localStorage.setItem('mirror_mode', String(mirror));
    localStorage.setItem('continuous_mode', String(continuous));
    localStorage.setItem('font_size', String(size));
    localStorage.setItem('vibration_enabled', String(vibration));
    
    setApiKey(key);
    setRecognitionEngine(engine);
    setIsMirrorMode(mirror);
    setIsContinuousMode(continuous);
    isContinuousModeRef.current = continuous;
    setFontSize(size);
    setIsVibrationEnabled(vibration);
  };

  const triggerVibration = useCallback((pattern: number | number[]) => {
    if (isVibrationEnabled && 'vibrate' in navigator) {
      try {
        navigator.vibrate(pattern);
      } catch (e) {
        console.error('Vibration failed', e);
      }
    }
  }, [isVibrationEnabled]);

  const saveToHistory = (text: string) => {
    if (!text.trim()) return;
    const newItem: HistoryItem = {
      id: Date.now().toString(),
      text,
      date: Date.now(),
    };
    const newHistory = [newItem, ...history].slice(0, 50); // Keep last 50
    setHistory(newHistory);
    localStorage.setItem('transcription_history', JSON.stringify(newHistory));
  };

  const clearHistory = () => {
    if (window.confirm('確定要清除所有歷史紀錄嗎？')) {
      setHistory([]);
      localStorage.removeItem('transcription_history');
    }
  };

  const toggleChatView = () => {
    const newValue = !isChatView;
    setIsChatView(newValue);
    localStorage.setItem('chat_view_mode', String(newValue));
  };

  const exportHistory = async () => {
    if (history.length === 0) return;
    const textContent = history.map(item => `[${new Date(item.date).toLocaleString('zh-TW')}]\n${item.text}`).join('\n\n');
    
    if (navigator.share) {
      try {
        await navigator.share({
          title: '聽障溝通助手 - 對話紀錄',
          text: textContent,
        });
      } catch (err) {
        console.log('Share canceled or failed:', err);
      }
    } else {
      const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `對話紀錄_${new Date().toLocaleDateString('zh-TW').replace(/\//g, '')}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const updateCurrentText = (text: string) => {
    setCurrentText(text);
    currentTextRef.current = text;
  };

  const toggleCasting = () => {
    if (isCasting) {
      setIsCasting(false);
      setCastSessionId('');
    } else {
      const newSessionId = Math.random().toString(36).substring(2, 8).toUpperCase();
      setCastSessionId(newSessionId);
      setIsCasting(true);
      setShowQR(true);
    }
  };

  const stopRecording = useCallback((isAutoStop = false) => {
    if (!isRecordingRef.current) return;
    
    setIsRecording(false);
    isRecordingRef.current = false;
    
    const activeMode = recordingModeRef.current;
    recordingModeRef.current = null;

    setAudioLevel(0);
    setVadStatus('listening');
    vadStatusRef.current = 'listening';
    
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    if (streamIntervalRef.current) clearInterval(streamIntervalRef.current);
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(console.error);
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    
    if (activeMode === 'web-speech' && recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current.onend = null; // Prevent auto-restart
      recognitionRef.current = null;
      if (currentTextRef.current) {
        saveToHistory(currentTextRef.current);
      }
      // If continuous mode and auto-stopped, restart after a brief delay
      if (isAutoStop && isContinuousModeRef.current) {
        setTimeout(() => {
          if (!isRecordingRef.current) startRecording();
        }, 500);
      }
    } else if ((activeMode === 'whisper' || activeMode === 'whisper-stream') && mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
        // Don't set to null immediately, let onstop handle the final blob
      } else {
        mediaRecorderRef.current = null;
      }
    }
  }, [history]); // Removed recognitionEngine dependency as we use activeMode ref

  const setupAudioAnalysis = (stream: MediaStream) => {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;

    const audioCtx = new AudioContextClass();
    const analyser = audioCtx.createAnalyser();
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);
    analyser.fftSize = 256;
    
    audioContextRef.current = audioCtx;
    analyserRef.current = analyser;
    lastAudioTimeRef.current = Date.now();
    hasSpokenRef.current = false;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const updateLevel = () => {
      if (!isRecordingRef.current) return;
      
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) {
        sum += dataArray[i];
      }
      const average = sum / bufferLength;
      setAudioLevel(average);

      // Draw Waveform on Canvas
      if (canvasRef.current) {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          const width = canvas.width;
          const height = canvas.height;
          ctx.clearRect(0, 0, width, height);
          
          const barWidth = (width / bufferLength) * 2.5;
          let x = 0;
          
          for (let i = 0; i < bufferLength; i++) {
            const barHeight = (dataArray[i] / 255) * height;
            
            // Create gradient
            const gradient = ctx.createLinearGradient(0, height, 0, 0);
            gradient.addColorStop(0, '#3b82f6'); // blue-500
            gradient.addColorStop(1, '#ef4444'); // red-500
            
            ctx.fillStyle = gradient;
            ctx.fillRect(x, height - barHeight, barWidth, barHeight);
            
            x += barWidth + 1;
          }
        }
      }

      // VAD (Voice Activity Detection) Logic
      let currentVadStatus: 'listening' | 'silence' | 'stopping' = 'listening';
      
      if (average > 15) { // Threshold for detecting voice
        lastAudioTimeRef.current = Date.now();
        hasSpokenRef.current = true;
        currentVadStatus = 'listening';
      } else {
        const silenceDuration = Date.now() - lastAudioTimeRef.current;
        
        if (hasSpokenRef.current) {
          if (silenceDuration > 2500) {
            stopRecording(true);
            return;
          } else if (silenceDuration > 1500) {
            currentVadStatus = 'stopping';
          } else {
            currentVadStatus = 'silence';
          }
        } else {
          if (silenceDuration > 10000) {
            stopRecording(true);
            return;
          }
        }
      }

      if (vadStatusRef.current !== currentVadStatus) {
        vadStatusRef.current = currentVadStatus;
        setVadStatus(currentVadStatus);
      }

      animationFrameRef.current = requestAnimationFrame(updateLevel);
    };
    updateLevel();
  };

  const startRecording = async () => {
    if (!apiKey && recognitionEngine !== 'web-speech') {
      alert('請先至設定輸入 OpenAI API Key，或切換為內建 Web Speech 模式。');
      setView('settings');
      return;
    }

    // Ensure any previous recording is fully stopped before starting a new one
    if (isRecordingRef.current) {
      stopRecording();
      // Wait a brief moment to allow resources to be released
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    updateCurrentText('');
    setIsRecording(true);
    isRecordingRef.current = true;
    recordingModeRef.current = recognitionEngine;
    isInterimProcessingRef.current = false;
    triggerVibration(50);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      setupAudioAnalysis(stream);

      if (recognitionEngine === 'web-speech') {
        // Use Web Speech API for real-time streaming
        const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
        if (!SpeechRecognition) {
          alert('您的瀏覽器不支援語音辨識串流，請關閉串流模式改用 Whisper。');
          stopRecording();
          return;
        }

        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'zh-TW';

        recognition.onresult = (event: any) => {
          let finalTranscript = '';
          let interimTranscript = '';
          let hasFinal = false;

          for (let i = event.resultIndex; i < event.results.length; ++i) {
            if (event.results[i].isFinal) {
              finalTranscript += event.results[i][0].transcript;
              hasFinal = true;
            } else {
              interimTranscript += event.results[i][0].transcript;
            }
          }
          updateCurrentText(finalTranscript + interimTranscript);
          if (hasFinal) triggerVibration([100, 50, 100]);
          
          // Reset silence timer when speech is recognized
          lastAudioTimeRef.current = Date.now();
          hasSpokenRef.current = true;
        };

        recognition.onerror = (event: any) => {
          console.error('Speech recognition error', event.error);
          triggerVibration(500);
          if (event.error !== 'no-speech') {
            stopRecording();
          }
        };

        recognition.onend = () => {
          if (isRecordingRef.current) {
            try {
              recognition.start(); // Restart if still recording
            } catch (e) {
              console.error(e);
            }
          }
        };

        recognitionRef.current = recognition;
        recognition.start();

      } else {
        // Use MediaRecorder for Whisper AI API (Single Phrase or Realtime Whisper stream)
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        audioChunksRef.current = [];

        mediaRecorder.ondataavailable = async (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
            
            // If in streaming Whisper mode, dispatch interim fetch
            if (recognitionEngine === 'whisper-stream' && mediaRecorder.state === 'recording' && !isInterimProcessingRef.current) {
              const currentChunks = [...audioChunksRef.current];
              const audioBlob = new Blob(currentChunks, { type: 'audio/webm' });
              
              if (audioBlob.size > 1000) { // Enough data to transcribe
                isInterimProcessingRef.current = true;
                const interimFormData = new FormData();
                interimFormData.append('file', audioBlob, 'interim.webm');
                interimFormData.append('model', 'whisper-1');
                interimFormData.append('language', 'zh');
                interimFormData.append('prompt', '請使用繁體中文（台灣）輸出。這是一段繁體中文的語音對話。');

                try {
                  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${apiKey}` },
                    body: interimFormData
                  });
                  if (response.ok) {
                    const data = await response.json();
                    let transcribedText = data.text.trim();

                    const hallucinations = [
                      '請不吝點贊訂閱轉發',
                      '打賞支持',
                      '明鏡與點點',
                      '謝謝大家',
                      '字幕由 Amara.org 社群提供',
                      '字幕由Amara.org社区提供',
                      '大家下次再見',
                      '請訂閱我的頻道'
                    ];

                    if (!hallucinations.some(h => transcribedText.includes(h))) {
                      if (transcribedText) {
                         setCurrentText(transcribedText);
                         currentTextRef.current = transcribedText;
                      }
                    }
                  }
                } catch (e) {
                  console.error('Interim whisper fetch failed', e);
                } finally {
                  isInterimProcessingRef.current = false;
                }
              }
            }
          }
        };

        mediaRecorder.onstop = async () => {
          // Clear interval if any
          if (streamIntervalRef.current) clearInterval(streamIntervalRef.current);
          
          // Only process if this is the active media recorder (or if it was just cleared by stopRecording)
          if (mediaRecorderRef.current !== mediaRecorder && mediaRecorderRef.current !== null) return;
          
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          
          // Clean up the ref if it's still pointing to this recorder
          if (mediaRecorderRef.current === mediaRecorder) {
            mediaRecorderRef.current = null;
          }
          
          await transcribeWithWhisper(audioBlob);
          
          // If continuous mode is on, restart recording after Whisper finishes
          if (isContinuousModeRef.current && !isRecordingRef.current) {
            setTimeout(() => {
              if (!isRecordingRef.current) startRecording();
            }, 500);
          }
        };

        mediaRecorder.start();

        // Start interval for requesting data in whisper-stream mode
        if (recognitionEngine === 'whisper-stream') {
          streamIntervalRef.current = setInterval(() => {
            if (mediaRecorder.state === 'recording') {
              mediaRecorder.requestData();
            }
          }, 1500); // Trigger data availability every 1.5s
        }
      }
    } catch (err) {
      console.error('Error accessing microphone:', err);
      alert('無法存取麥克風，請確認權限。');
      stopRecording();
    }
  };

  const transcribeWithWhisper = async (audioBlob: Blob) => {
    if (!audioBlob || audioBlob.size < 100) {
      setIsProcessing(false);
      return;
    }
    
    setIsProcessing(true);
    const formData = new FormData();
    formData.append('file', audioBlob, 'audio.webm');
    formData.append('model', 'whisper-1');
    formData.append('language', 'zh');
    formData.append('prompt', '請使用繁體中文（台灣）輸出。這是一段繁體中文的語音對話。');

    try {
      const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        },
        body: formData
      });

      if (!response.ok) {
        const errorData = await response.json();
        const errMsg = errorData.error?.message || 'API 請求失敗';
        
        // API Key Error Handling
        if (response.status === 401 || errMsg.toLowerCase().includes('api key')) {
          alert('OpenAI API Key 無效或已過期，請重新檢查設定。');
          setApiKey(''); // Clear invalid key
          localStorage.removeItem('openai_api_key');
          setView('settings');
          updateCurrentText('API Key 錯誤');
          setIsProcessing(false);
          return;
        }
        throw new Error(errMsg);
      }

      const data = await response.json();
      const transcribedText = data.text.trim();

      // Whisper Hallucination Filter
      const hallucinations = [
        '請不吝點贊訂閱轉發打賞支持明鏡與點點欄目',
        '點贊訂閱轉發',
        '謝謝大家',
        '字幕由 Amara.org 社群提供',
        '字幕由Amara.org社区提供',
        '大家下次再見',
        '大家下次再见',
        '請訂閱我的頻道',
        '请订阅我的频道'
      ];

      if (hallucinations.some(h => transcribedText.includes(h)) && transcribedText.length < 30) {
        console.log('Filtered Whisper hallucination:', transcribedText);
        updateCurrentText('');
        setIsProcessing(false);
        return;
      }

      if (transcribedText) {
        updateCurrentText(transcribedText);
        saveToHistory(transcribedText);
        triggerVibration([100, 50, 100]);
      } else {
        updateCurrentText('');
      }
    } catch (error: any) {
      console.error('Whisper API Error:', error);
      updateCurrentText(`錯誤: ${error.message}`);
      triggerVibration(500);
    } finally {
      setIsProcessing(false);
    }
  };

  const toggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  // Render Receiver View
  if (isReceiverMode) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center p-8 text-white relative">
        <div className="absolute top-6 left-6 flex items-center space-x-2 opacity-50">
          <div className={`w-3 h-3 rounded-full ${isSocketConnected ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`} />
          <span className="text-xs font-mono">{isSocketConnected ? 'Connected' : 'Disconnected'}</span>
        </div>
        <div className="max-w-4xl w-full text-center">
          <p className="font-medium leading-tight select-none" style={{ fontSize: `${fontSize}px` }}>
            {receiverText || (isSocketConnected ? '連線成功，等待主螢幕傳送文字...' : '正在嘗試連線到主螢幕...')}
          </p>
        </div>
        <div className="fixed bottom-6 right-6 opacity-30">
          <span className="text-xs font-mono">Room: {castSessionId}</span>
        </div>
      </div>
    );
  }

  // Render Settings View
  if (view === 'settings') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col p-6 pt-[calc(1.5rem+env(safe-area-inset-top))]">
        <div className="flex items-center mb-8">
          <button onClick={() => setView('main')} className="p-2 rounded-full hover:bg-gray-200 transition">
            <ArrowLeft className="w-8 h-8 text-gray-700" />
          </button>
          <h1 className="text-3xl font-bold ml-4 text-gray-900">設定</h1>
        </div>

        <div className="space-y-8 max-w-md mx-auto w-full">
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
            <label className="block text-lg font-medium text-gray-700 mb-2">
              OpenAI API Key
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => saveSettings(e.target.value, recognitionEngine, isMirrorMode, isContinuousMode, fontSize, isVibrationEnabled)}
              placeholder="sk-..."
              className="w-full p-4 text-lg border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
            />
            <p className="text-sm text-gray-500 mt-2">
              金鑰將加密儲存於您的設備中，不會上傳至其他伺服器。
            </p>
          </div>

          <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
            <h3 className="text-lg font-medium text-gray-900 mb-4">語音辨識引擎</h3>
            
            <div className="space-y-3">
              <label className="flex items-start cursor-pointer group">
                <div className="flex items-center h-6">
                  <input
                    type="radio"
                    name="recognitionEngine"
                    checked={recognitionEngine === 'whisper'}
                    onChange={() => saveSettings(apiKey, 'whisper', isMirrorMode, isContinuousMode, fontSize, isVibrationEnabled)}
                    className="w-5 h-5 text-blue-600 border-gray-300 focus:ring-blue-500"
                  />
                </div>
                <div className="ml-3">
                  <span className="block text-base font-medium text-gray-900">單句模式 (Whisper AI)</span>
                  <span className="block text-sm text-gray-500 mt-1">準確度極高，有標點符號。需等整句話講完才會顯示文字，最省資源。</span>
                </div>
              </label>

              <label className="flex items-start cursor-pointer group">
                <div className="flex items-center h-6">
                  <input
                    type="radio"
                    name="recognitionEngine"
                    checked={recognitionEngine === 'whisper-stream'}
                    onChange={() => saveSettings(apiKey, 'whisper-stream', isMirrorMode, isContinuousMode, fontSize, isVibrationEnabled)}
                    className="w-5 h-5 text-blue-600 border-gray-300 focus:ring-blue-500"
                  />
                </div>
                <div className="ml-3">
                  <span className="block text-base font-medium text-gray-900">gpt-realtime-whisper (串流辨識)</span>
                  <span className="block text-sm text-gray-500 mt-1">結合 Whisper 極高準確度與串流即時顯示。邊講話邊上字，會消耗較多 API 額度。</span>
                </div>
              </label>

              <label className="flex items-start cursor-pointer group">
                <div className="flex items-center h-6">
                  <input
                    type="radio"
                    name="recognitionEngine"
                    checked={recognitionEngine === 'web-speech'}
                    onChange={() => saveSettings(apiKey, 'web-speech', isMirrorMode, isContinuousMode, fontSize, isVibrationEnabled)}
                    className="w-5 h-5 text-blue-600 border-gray-300 focus:ring-blue-500"
                  />
                </div>
                <div className="ml-3">
                  <span className="block text-base font-medium text-gray-900">內建即時串流 (Web Speech)</span>
                  <span className="block text-sm text-gray-500 mt-1">免 API Key，文字逐字顯示速度極快，但準確度中等且無標點符號。</span>
                </div>
              </label>
            </div>
          </div>

          <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex items-center justify-between">
            <div className="pr-4">
              <h3 className="text-lg font-medium text-gray-900">連續聆聽模式</h3>
              <p className="text-sm text-gray-500 mt-1">
                開啟後，當對方講完一句話停頓時，系統會自動重新啟動麥克風繼續收音，全程不需手動按按鈕。
                <br/><span className="text-blue-500">建議搭配「即時串流模式」使用，避免消耗過多 API 額度。</span>
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0">
              <input 
                type="checkbox" 
                className="sr-only peer"
                checked={isContinuousMode}
                onChange={(e) => saveSettings(apiKey, recognitionEngine, isMirrorMode, e.target.checked, fontSize, isVibrationEnabled)}
              />
              <div className="w-14 h-7 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>

          <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex items-center justify-between">
            <div className="pr-4">
              <h3 className="text-lg font-medium text-gray-900">觸覺回饋 (震動提示)</h3>
              <p className="text-sm text-gray-500 mt-1">
                開啟後，在開始收音、辨識完成或發生錯誤時，手機會發出震動提示。(iOS 系統不支援)
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0">
              <input 
                type="checkbox" 
                className="sr-only peer"
                checked={isVibrationEnabled}
                onChange={(e) => saveSettings(apiKey, recognitionEngine, isMirrorMode, isContinuousMode, fontSize, e.target.checked)}
              />
              <div className="w-14 h-7 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>

          <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-medium text-gray-900">字體大小</h3>
              <span className="text-lg font-medium text-blue-600">{fontSize}px</span>
            </div>
            <input 
              type="range" 
              min="24" 
              max="120" 
              step="4"
              value={fontSize}
              onChange={(e) => saveSettings(apiKey, recognitionEngine, isMirrorMode, isContinuousMode, parseInt(e.target.value, 10), isVibrationEnabled)}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
            />
            <div className="flex justify-between text-sm text-gray-500 mt-2">
              <span>小</span>
              <span>大</span>
            </div>
          </div>

          <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex items-center justify-between">
            <div className="pr-4">
              <h3 className="text-lg font-medium text-gray-900">外部螢幕投射</h3>
              <p className="text-sm text-gray-500 mt-1">
                開啟後，其他裝置掃描 QR Code 即可同步看到目前的對話文字。
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0">
              <input 
                type="checkbox" 
                className="sr-only peer"
                checked={isCasting}
                onChange={toggleCasting}
              />
              <div className="w-14 h-7 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-blue-600"></div>
            </label>
          </div>
        </div>
      </div>
    );
  }

  // Render History View
  if (view === 'history') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col p-6 pt-[calc(1.5rem+env(safe-area-inset-top))]">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center">
            <button onClick={() => setView('main')} className="p-2 rounded-full hover:bg-gray-200 transition">
              <ArrowLeft className="w-8 h-8 text-gray-700" />
            </button>
            <h1 className="text-3xl font-bold ml-4 text-gray-900">歷史紀錄</h1>
          </div>
          <div className="flex items-center space-x-2">
            {history.length > 0 && (
              <>
                <button onClick={exportHistory} className="p-2 text-blue-500 hover:bg-blue-50 rounded-full transition">
                  <Share className="w-8 h-8" />
                </button>
                <button onClick={clearHistory} className="p-2 text-red-500 hover:bg-red-50 rounded-full transition">
                  <Trash2 className="w-8 h-8" />
                </button>
              </>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto space-y-4 max-w-2xl mx-auto w-full pb-10">
          {history.length === 0 ? (
            <div className="text-center text-gray-500 mt-20 text-xl">尚無紀錄</div>
          ) : (
            history.map((item) => (
              <div key={item.id} className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100">
                <p className="text-2xl text-gray-900 leading-relaxed">{item.text}</p>
                <p className="text-sm text-gray-400 mt-4">
                  {new Date(item.date).toLocaleString('zh-TW')}
                </p>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  // Render Main View
  return (
    <div className="min-h-screen bg-black flex flex-col text-white overflow-hidden relative">
      {/* Full-screen Breathing Light Indicator */}
      {isRecording && (
        <div className="absolute inset-0 pointer-events-none z-0">
          <div className="absolute inset-0 animate-rainbow-breathe rounded-lg"></div>
        </div>
      )}

      {/* Top Navigation Bar */}
      <div className="fixed top-0 left-0 right-0 p-6 pt-[calc(1.5rem+env(safe-area-inset-top))] flex justify-between items-center z-30 bg-gradient-to-b from-black via-black/80 to-transparent">
        <button 
          onClick={() => setView('settings')}
          className="p-3 bg-white/10 backdrop-blur-md rounded-full hover:bg-white/20 transition"
        >
          <Settings className="w-8 h-8" />
        </button>
        
        <button 
          onClick={() => saveSettings(apiKey, recognitionEngine, !isMirrorMode, isContinuousMode, fontSize, isVibrationEnabled)}
          className={`p-3 backdrop-blur-md rounded-full transition ${isMirrorMode ? 'bg-blue-500 text-white' : 'bg-white/10 hover:bg-white/20'}`}
        >
          <FlipVertical className="w-8 h-8" />
        </button>

        <button 
          onClick={toggleChatView}
          className={`p-3 backdrop-blur-md rounded-full transition ${isChatView ? 'bg-blue-500 text-white' : 'bg-white/10 hover:bg-white/20'}`}
        >
          <MessageSquare className="w-8 h-8" />
        </button>

        {isCasting && (
          <button 
            onClick={() => setShowQR(true)}
            className="p-3 bg-blue-500 backdrop-blur-md rounded-full text-white animate-pulse"
          >
            <Monitor className="w-8 h-8" />
          </button>
        )}

        <button 
          onClick={() => setView('history')}
          className="p-3 bg-white/10 backdrop-blur-md rounded-full hover:bg-white/20 transition"
        >
          <History className="w-8 h-8" />
        </button>
      </div>

      {/* Text Display Area */}
      <div className="flex-1 flex flex-col w-full pt-24 pb-32 overflow-hidden">
        {isChatView ? (
          isMirrorMode ? (
            <>
              {/* Top Half Chat (Rotated) */}
              <div className="flex-1 overflow-y-auto p-6 border-b border-gray-800 rotate-180 flex flex-col space-y-4">
                {[...history].reverse().map(item => (
                  <div key={item.id} className="bg-gray-800 rounded-2xl p-4 self-start max-w-[90%]">
                    <p className="text-white" style={{ fontSize: `${Math.max(20, fontSize * 0.5)}px` }}>{item.text}</p>
                  </div>
                ))}
                {currentText && currentText !== history[0]?.text && (
                  <div className="bg-blue-600 rounded-2xl p-4 self-start max-w-[90%] animate-pulse">
                    <p className="text-white" style={{ fontSize: `${Math.max(20, fontSize * 0.5)}px` }}>{currentText}</p>
                  </div>
                )}
                {isProcessing && (
                  <div className="bg-blue-600/30 rounded-2xl p-4 self-start max-w-[90%] flex items-center space-x-2">
                    <div className="flex space-x-1">
                      <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                      <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                      <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce"></div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRefTop} />
              </div>
              {/* Bottom Half Chat */}
              <div className="flex-1 overflow-y-auto p-6 flex flex-col space-y-4">
                {[...history].reverse().map(item => (
                  <div key={item.id} className="bg-gray-800 rounded-2xl p-4 self-start max-w-[90%]">
                    <p className="text-white" style={{ fontSize: `${Math.max(20, fontSize * 0.5)}px` }}>{item.text}</p>
                  </div>
                ))}
                {currentText && currentText !== history[0]?.text && (
                  <div className="bg-blue-600 rounded-2xl p-4 self-start max-w-[90%] animate-pulse">
                    <p className="text-white" style={{ fontSize: `${Math.max(20, fontSize * 0.5)}px` }}>{currentText}</p>
                  </div>
                )}
                {isProcessing && (
                  <div className="bg-blue-600/30 rounded-2xl p-4 self-start max-w-[90%] flex items-center space-x-2">
                    <div className="flex space-x-1">
                      <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                      <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                      <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce"></div>
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            </>
          ) : (
            <div className="flex-1 overflow-y-auto p-6 flex flex-col space-y-4">
              {[...history].reverse().map(item => (
                <div key={item.id} className="bg-gray-800 rounded-2xl p-4 self-start max-w-[90%]">
                  <p className="text-white" style={{ fontSize: `${Math.max(20, fontSize * 0.5)}px` }}>{item.text}</p>
                </div>
              ))}
              {currentText && currentText !== history[0]?.text && (
                <div className="bg-blue-600 rounded-2xl p-4 self-start max-w-[90%] animate-pulse">
                  <p className="text-white" style={{ fontSize: `${Math.max(20, fontSize * 0.5)}px` }}>{currentText}</p>
                </div>
              )}
              {isProcessing && (
                <div className="bg-blue-600/30 rounded-2xl p-4 self-start max-w-[90%] flex items-center space-x-2">
                  <div className="flex space-x-1">
                    <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                    <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                    <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce"></div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )
        ) : (
          isMirrorMode ? (
            <>
              {/* Top Half (Rotated 180deg for the other person) */}
              <div className="flex-1 overflow-y-auto p-8 border-b border-gray-800 rotate-180 flex flex-col">
                <div className="my-auto flex flex-col items-center">
                  {isProcessing ? (
                    <div className="flex flex-col items-center space-y-4">
                      <Loader2 className="animate-spin text-blue-500" style={{ width: fontSize, height: fontSize }} />
                      <p className="text-blue-400 font-medium" style={{ fontSize: `${Math.max(16, fontSize * 0.3)}px` }}>正在辨識中...</p>
                    </div>
                  ) : (
                    <p className="font-medium leading-tight text-center text-blue-400" style={{ fontSize: `${fontSize}px` }}>
                      {currentText || '等待說話...'}
                    </p>
                  )}
                  <div ref={messagesEndRefTop} />
                </div>
              </div>
              {/* Bottom Half (Normal for the user) */}
              <div className="flex-1 overflow-y-auto p-8 flex flex-col">
                <div className="my-auto flex flex-col items-center">
                  {isProcessing ? (
                    <div className="flex flex-col items-center space-y-4">
                      <Loader2 className="animate-spin text-blue-500" style={{ width: fontSize, height: fontSize }} />
                      <p className="text-blue-400 font-medium" style={{ fontSize: `${Math.max(16, fontSize * 0.3)}px` }}>正在辨識中...</p>
                    </div>
                  ) : (
                    <p className="font-medium leading-tight text-center text-white" style={{ fontSize: `${fontSize}px` }}>
                      {currentText || '等待說話...'}
                    </p>
                  )}
                  <div ref={messagesEndRef} />
                </div>
              </div>
            </>
          ) : (
            /* Full Screen Normal */
            <div className="flex-1 overflow-y-auto p-8 flex flex-col">
              <div className="my-auto flex flex-col items-center">
                {isProcessing ? (
                  <div className="flex flex-col items-center space-y-4">
                    <Loader2 className="animate-spin text-blue-500" style={{ width: fontSize, height: fontSize }} />
                    <p className="text-blue-400 font-medium" style={{ fontSize: `${Math.max(16, fontSize * 0.3)}px` }}>正在辨識中...</p>
                  </div>
                ) : (
                  <p className="font-medium leading-tight text-center" style={{ fontSize: `${fontSize}px` }}>
                    {currentText || '點擊下方麥克風開始說話'}
                  </p>
                )}
                <div ref={messagesEndRef} />
              </div>
            </div>
          )
        )}
      </div>

      {/* Bottom Microphone Button & Waveform */}
      <div className="absolute bottom-0 left-0 right-0 p-8 pb-[calc(2rem+env(safe-area-inset-bottom))] flex flex-col justify-end items-center bg-gradient-to-t from-black via-black/80 to-transparent">
        
        {/* VAD Status Indicator */}
        <div className="h-8 mb-4 flex items-center justify-center">
          {isRecording && (
            <span className={`text-sm font-medium px-4 py-1.5 rounded-full transition-colors duration-300 ${
              vadStatus === 'listening' ? 'bg-blue-500/20 text-blue-400' :
              vadStatus === 'silence' ? 'bg-gray-500/20 text-gray-400' :
              'bg-red-500/20 text-red-400 animate-pulse'
            }`}>
              {vadStatus === 'listening' ? '正在聆聽...' :
               vadStatus === 'silence' ? '未偵測到聲音' :
               '即將自動停止...'}
            </span>
          )}
        </div>

        {/* Audio Waveform Canvas */}
        <canvas 
          ref={canvasRef} 
          width={window.innerWidth} 
          height={60} 
          className={`w-full h-[60px] mb-6 transition-opacity duration-300 ${isRecording ? 'opacity-100' : 'opacity-0'}`} 
        />

        <button
          onClick={toggleRecording}
          disabled={isProcessing}
          className={`
            relative group flex items-center justify-center w-24 h-24 rounded-full transition-all duration-300 shadow-2xl z-10
            ${isRecording 
              ? 'bg-red-500 hover:bg-red-600' 
              : 'bg-blue-600 hover:bg-blue-700 hover:scale-105'}
            ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}
          `}
        >
          {/* Pulsing Background */}
          {isRecording && (
            <>
              <div 
                className="absolute inset-0 rounded-full bg-red-500 opacity-40 transition-transform duration-75 pointer-events-none"
                style={{ transform: `scale(${1 + audioLevel / 40})` }}
              ></div>
              <div 
                className="absolute inset-0 rounded-full border-2 border-red-400 opacity-60 transition-transform duration-75 pointer-events-none"
                style={{ transform: `scale(${1 + audioLevel / 20})` }}
              ></div>
            </>
          )}

          {isRecording ? (
            <Square className="w-10 h-10 text-white fill-current relative z-10" />
          ) : (
            <Mic className="w-12 h-12 text-white relative z-10" />
          )}
        </button>
      </div>

      {/* QR Code Modal */}
      {showQR && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 backdrop-blur-lg bg-black/60">
          <div className="bg-white rounded-3xl p-8 max-w-sm w-full flex flex-col items-center text-center">
            <h3 className="text-2xl font-bold text-gray-900 mb-2">外部螢幕投射</h3>
            <p className="text-gray-500 mb-6 text-sm">請使用另一台裝置(如 iPad)掃描下方 QR Code 即可連線同步。</p>
            
            <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-inner mb-6">
              <QRCodeSVG 
                value={`${window.location.origin}${window.location.pathname}?session=${castSessionId}`}
                size={200}
                level="H"
                includeMargin={false}
              />
            </div>
            
            <div className="flex items-center space-x-2 bg-gray-100 px-4 py-2 rounded-xl mb-8">
              <div className={`w-2 h-2 rounded-full ${isSocketConnected ? 'bg-green-500' : 'bg-red-500 animate-pulse'}`} />
              <span className="text-xs font-mono text-gray-600">
                {isSocketConnected ? '服務已連線' : '正在連線伺服器...'}
              </span>
            </div>
            
            <button 
              onClick={() => setShowQR(false)}
              className="w-full py-4 bg-blue-600 text-white rounded-2xl font-bold hover:bg-blue-700 transition"
            >
              關閉
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
