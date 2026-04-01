import React, { useState, useEffect, useRef } from 'react';
import { Mic, Square, Settings, History, ArrowLeft, Trash2, FlipVertical } from 'lucide-react';

type View = 'main' | 'settings' | 'history';

interface HistoryItem {
  id: string;
  text: string;
  date: number;
}

export default function App() {
  const [view, setView] = useState<View>('main');
  const [apiKey, setApiKey] = useState('');
  const [isStreamingMode, setIsStreamingMode] = useState(true);
  const [isMirrorMode, setIsMirrorMode] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  
  const [isRecording, setIsRecording] = useState(false);
  const [currentText, setCurrentText] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  // Refs for recording
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recognitionRef = useRef<any>(null);

  // Load settings on mount
  useEffect(() => {
    const savedKey = localStorage.getItem('openai_api_key') || '';
    const savedStreaming = localStorage.getItem('streaming_mode') !== 'false';
    const savedMirror = localStorage.getItem('mirror_mode') === 'true';
    const savedHistory = JSON.parse(localStorage.getItem('transcription_history') || '[]');
    
    setApiKey(savedKey);
    setIsStreamingMode(savedStreaming);
    setIsMirrorMode(savedMirror);
    setHistory(savedHistory);
  }, []);

  // Save settings when they change
  const saveSettings = (key: string, streaming: boolean, mirror: boolean) => {
    localStorage.setItem('openai_api_key', key);
    localStorage.setItem('streaming_mode', String(streaming));
    localStorage.setItem('mirror_mode', String(mirror));
    setApiKey(key);
    setIsStreamingMode(streaming);
    setIsMirrorMode(mirror);
  };

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

  const startRecording = async () => {
    if (!apiKey && !isStreamingMode) {
      alert('請先至設定輸入 OpenAI API Key，或開啟內建串流模式。');
      setView('settings');
      return;
    }

    setCurrentText('');
    setIsRecording(true);

    if (isStreamingMode) {
      // Use Web Speech API for real-time streaming
      const SpeechRecognition = window.SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SpeechRecognition) {
        alert('您的瀏覽器不支援語音辨識串流，請關閉串流模式改用 Whisper。');
        setIsRecording(false);
        return;
      }

      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'zh-TW';

      recognition.onresult = (event: any) => {
        let finalTranscript = '';
        let interimTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          } else {
            interimTranscript += event.results[i][0].transcript;
          }
        }
        setCurrentText(finalTranscript + interimTranscript);
      };

      recognition.onerror = (event: any) => {
        console.error('Speech recognition error', event.error);
        stopRecording();
      };

      recognition.onend = () => {
        if (isRecording) {
          recognition.start(); // Restart if still recording
        }
      };

      recognitionRef.current = recognition;
      recognition.start();

    } else {
      // Use MediaRecorder for Whisper API
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        audioChunksRef.current = [];

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        mediaRecorder.onstop = async () => {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          await transcribeWithWhisper(audioBlob);
          stream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start();
      } catch (err) {
        console.error('Error accessing microphone:', err);
        alert('無法存取麥克風，請確認權限。');
        setIsRecording(false);
      }
    }
  };

  const stopRecording = () => {
    setIsRecording(false);
    
    if (isStreamingMode && recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current.onend = null; // Prevent auto-restart
      if (currentText) {
        saveToHistory(currentText);
      }
    } else if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  const transcribeWithWhisper = async (audioBlob: Blob) => {
    setIsProcessing(true);
    setCurrentText('正在處理語音...');
    
    const formData = new FormData();
    formData.append('file', audioBlob, 'audio.webm');
    formData.append('model', 'whisper-1');
    formData.append('language', 'zh');

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
        throw new Error(errorData.error?.message || 'API 請求失敗');
      }

      const data = await response.json();
      setCurrentText(data.text);
      saveToHistory(data.text);
    } catch (error: any) {
      console.error('Whisper API Error:', error);
      setCurrentText(`錯誤: ${error.message}`);
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

  // Render Settings View
  if (view === 'settings') {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col p-6">
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
              onChange={(e) => saveSettings(e.target.value, isStreamingMode, isMirrorMode)}
              placeholder="sk-..."
              className="w-full p-4 text-lg border border-gray-300 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition"
            />
            <p className="text-sm text-gray-500 mt-2">
              金鑰將加密儲存於您的設備中，不會上傳至其他伺服器。
            </p>
          </div>

          <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-100 flex items-center justify-between">
            <div>
              <h3 className="text-lg font-medium text-gray-900">即時串流模式</h3>
              <p className="text-sm text-gray-500 mt-1">開啟後文字將逐字顯示，減少等待焦慮。(使用內建語音引擎)</p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input 
                type="checkbox" 
                className="sr-only peer"
                checked={isStreamingMode}
                onChange={(e) => saveSettings(apiKey, e.target.checked, isMirrorMode)}
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
      <div className="min-h-screen bg-gray-50 flex flex-col p-6">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center">
            <button onClick={() => setView('main')} className="p-2 rounded-full hover:bg-gray-200 transition">
              <ArrowLeft className="w-8 h-8 text-gray-700" />
            </button>
            <h1 className="text-3xl font-bold ml-4 text-gray-900">歷史紀錄</h1>
          </div>
          {history.length > 0 && (
            <button onClick={clearHistory} className="p-2 text-red-500 hover:bg-red-50 rounded-full transition">
              <Trash2 className="w-8 h-8" />
            </button>
          )}
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
    <div className="min-h-screen bg-black flex flex-col text-white overflow-hidden">
      {/* Top Navigation Bar */}
      <div className="absolute top-0 left-0 right-0 p-6 pt-[calc(1.5rem+env(safe-area-inset-top))] flex justify-between items-center z-10">
        <button 
          onClick={() => setView('settings')}
          className="p-3 bg-white/10 backdrop-blur-md rounded-full hover:bg-white/20 transition"
        >
          <Settings className="w-8 h-8" />
        </button>
        
        <button 
          onClick={() => saveSettings(apiKey, isStreamingMode, !isMirrorMode)}
          className={`p-3 backdrop-blur-md rounded-full transition ${isMirrorMode ? 'bg-blue-500 text-white' : 'bg-white/10 hover:bg-white/20'}`}
        >
          <FlipVertical className="w-8 h-8" />
        </button>

        <button 
          onClick={() => setView('history')}
          className="p-3 bg-white/10 backdrop-blur-md rounded-full hover:bg-white/20 transition"
        >
          <History className="w-8 h-8" />
        </button>
      </div>

      {/* Text Display Area */}
      <div className="flex-1 flex flex-col w-full h-full pt-24 pb-32">
        {isMirrorMode ? (
          <>
            {/* Top Half (Rotated 180deg for the other person) */}
            <div className="flex-1 flex items-center justify-center p-8 border-b border-gray-800 rotate-180">
              <p className="text-[clamp(2rem,5vw,4rem)] font-medium leading-tight text-center text-blue-400">
                {currentText || '等待說話...'}
              </p>
            </div>
            {/* Bottom Half (Normal for the user) */}
            <div className="flex-1 flex items-center justify-center p-8">
              <p className="text-[clamp(2rem,5vw,4rem)] font-medium leading-tight text-center text-white">
                {currentText || '等待說話...'}
              </p>
            </div>
          </>
        ) : (
          /* Full Screen Normal */
          <div className="flex-1 flex items-center justify-center p-8">
            <p className="text-[clamp(2.5rem,6vw,5rem)] font-medium leading-tight text-center">
              {currentText || '點擊下方麥克風開始說話'}
            </p>
          </div>
        )}
      </div>

      {/* Bottom Microphone Button */}
      <div className="absolute bottom-0 left-0 right-0 p-8 pb-[calc(2rem+env(safe-area-inset-bottom))] flex justify-center items-center bg-gradient-to-t from-black via-black/80 to-transparent">
        <button
          onClick={toggleRecording}
          disabled={isProcessing}
          className={`
            relative group flex items-center justify-center w-24 h-24 rounded-full transition-all duration-300 shadow-2xl
            ${isRecording 
              ? 'bg-red-500 hover:bg-red-600 scale-110 animate-pulse' 
              : 'bg-blue-600 hover:bg-blue-700 hover:scale-105'}
            ${isProcessing ? 'opacity-50 cursor-not-allowed' : ''}
          `}
        >
          {isRecording ? (
            <Square className="w-10 h-10 text-white fill-current" />
          ) : (
            <Mic className="w-12 h-12 text-white" />
          )}
          
          {/* Ripple effect when recording */}
          {isRecording && (
            <div className="absolute inset-0 rounded-full border-4 border-red-500 animate-ping opacity-75"></div>
          )}
        </button>
      </div>
    </div>
  );
}

