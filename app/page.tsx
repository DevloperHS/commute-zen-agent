'use client';

import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type } from '@google/genai';
import { Headphones, Loader2, Play, Pause, Volume2, X, Search as SearchIcon, Clock, Plus, ArrowLeft, Mic, Square, MessageSquare } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { get, set } from 'idb-keyval';
import { auth, db } from '../lib/firebase';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';
import { collection, doc, setDoc, getDoc, getDocs, query, orderBy, limit } from 'firebase/firestore';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string;
    email?: string | null;
    emailVerified?: boolean;
    isAnonymous?: boolean;
    tenantId?: string | null;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

interface HistoryMeta {
  id: string;
  url: string;
  title: string;
  date: number;
}

interface HistoryItem extends HistoryMeta {
  transcript: string;
  audioBase64: string;
}

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function pcmToWavUrl(base64: string, sampleRate: number = 24000): string {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  const buffer = new ArrayBuffer(44 + bytes.length);
  const view = new DataView(buffer);
  
  // RIFF chunk descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + bytes.length, true);
  writeString(view, 8, 'WAVE');
  
  // fmt sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
  view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
  view.setUint16(22, 1, true); // NumChannels (1 channel)
  view.setUint32(24, sampleRate, true); // SampleRate
  view.setUint32(28, sampleRate * 2, true); // ByteRate
  view.setUint16(32, 2, true); // BlockAlign
  view.setUint16(34, 16, true); // BitsPerSample
  
  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, bytes.length, true);
  
  // Write PCM data
  const pcmData = new Uint8Array(buffer, 44);
  pcmData.set(bytes);
  
  const blob = new Blob([buffer], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

const CustomAudioPlayer = ({ src, transcript }: { src: string, transcript?: string }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  const activeWordRef = useRef<HTMLSpanElement>(null);
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showTranscript, setShowTranscript] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = playbackRate;
    }
  }, [playbackRate, src]);

  const togglePlaybackRate = () => {
    const nextRate = playbackRate === 1 ? 1.5 : playbackRate === 1.5 ? 0.75 : 1;
    setPlaybackRate(nextRate);
    if (audioRef.current) {
      audioRef.current.playbackRate = nextRate;
    }
  };

  const togglePlay = () => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setProgress(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = Number(e.target.value);
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      setProgress(time);
    }
  };

  const formatTime = (time: number) => {
    if (isNaN(time)) return "0:00";
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Calculate word boundaries for character-based interpolation
  const words: string[] = [];
  const wordBoundaries: { word: string, start: number, end: number }[] = [];
  let currentCharCount = 0;
  
  if (transcript) {
    const regex = /\S+/g;
    let match;
    let lastIndex = 0;
    
    while ((match = regex.exec(transcript)) !== null) {
      const word = match[0];
      const spaceBefore = transcript.substring(lastIndex, match.index);
      
      currentCharCount += spaceBefore.length;
      
      const start = currentCharCount;
      const end = start + word.length;
      
      wordBoundaries.push({ word, start, end });
      words.push(word);
      
      currentCharCount = end;
      lastIndex = regex.lastIndex;
    }
  }
  
  const totalChars = Math.max(1, currentCharCount);

  let activeWordIndex = -1;
  if (duration > 0) {
    // Assume ~0.4s silence at start and ~0.4s at end
    const SILENCE_START = 0.4;
    const SILENCE_END = 0.4;
    const activeDuration = Math.max(0.1, duration - SILENCE_START - SILENCE_END);
    const activeProgress = Math.max(0, Math.min(progress - SILENCE_START, activeDuration));
    
    const progressRatio = activeProgress / activeDuration;
    const targetChar = progressRatio * totalChars;
    
    for (let i = 0; i < wordBoundaries.length; i++) {
      // Add a small buffer (0.5) to the end of the word to keep it highlighted slightly longer
      if (targetChar <= wordBoundaries[i].end + 0.5) {
        activeWordIndex = i;
        break;
      }
    }
    if (targetChar > (wordBoundaries[wordBoundaries.length - 1]?.end || 0)) {
      activeWordIndex = wordBoundaries.length - 1;
    }
  }

  // Auto-scroll to active word independently of the main window
  React.useEffect(() => {
    if (showTranscript && activeWordRef.current && transcriptContainerRef.current) {
      const container = transcriptContainerRef.current;
      const activeEl = activeWordRef.current;
      
      // Calculate the relative top position of the active word within the container
      const containerCenter = container.clientHeight / 2;
      const elementTop = activeEl.offsetTop;
      const elementHeight = activeEl.clientHeight;
      
      // Scroll only the transcript container, not the whole page
      container.scrollTo({
        top: elementTop - containerCenter + (elementHeight / 2),
        behavior: 'smooth',
      });
    }
  }, [activeWordIndex, showTranscript]);

  return (
    <div className="w-full flex flex-col items-center gap-8">
      <div className="w-full max-w-md flex flex-col gap-4">
        <audio
          ref={audioRef}
          src={src}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onEnded={() => setIsPlaying(false)}
          autoPlay
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
        />
        
        <div className="flex items-center gap-4">
          <button 
            suppressHydrationWarning
            onClick={togglePlay}
            className="w-12 h-12 flex-shrink-0 flex items-center justify-center rounded-full bg-[#5A5A40] text-[#f5f5f0] hover:bg-[#4a4a35] transition-colors shadow-md"
          >
            {isPlaying ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" className="ml-1" />}
          </button>
          
          <div className="flex-1 flex flex-col gap-2">
            <input 
              suppressHydrationWarning
              type="range" 
              min={0} 
              max={duration || 100} 
              value={progress} 
              onChange={handleSeek}
              className="w-full h-1.5 bg-[#e5e5df] rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-[#5A5A40] [&::-webkit-slider-thumb]:rounded-full focus:outline-none"
            />
            <div className="flex justify-between text-xs text-[#888888] font-mono tracking-wider">
              <span>{formatTime(progress)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>

          <button
            suppressHydrationWarning
            onClick={togglePlaybackRate}
            className="w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-full border border-[#e5e5df] text-[#5A5A40] hover:bg-[#5A5A40]/5 transition-colors text-xs font-bold font-mono"
            title="Playback Speed"
          >
            {playbackRate}x
          </button>
        </div>
      </div>

      {transcript && (
        <div className="w-full flex flex-col items-center gap-4 mt-2">
          <button
            suppressHydrationWarning
            onClick={() => setShowTranscript(!showTranscript)}
            className="flex items-center gap-2 px-4 py-2 rounded-full border border-[#e5e5df] text-[#5A5A40] hover:bg-[#5A5A40]/5 transition-colors text-xs font-medium tracking-wide"
          >
            <span className="text-base">👥</span>
            {showTranscript ? 'Hide Transcript' : 'Follow Along'}
          </button>

          <AnimatePresence>
            {showTranscript && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="w-full overflow-hidden"
              >
                <div className="w-full flex flex-col gap-6 px-4 sm:px-8 pt-4 pb-2">
                  <div className="w-full h-[1px] bg-[#e5e5df] mb-2" />
                  <p className="text-xs uppercase tracking-[0.2em] text-[#888888] font-semibold text-center">Transcript</p>
                  <div 
                    ref={transcriptContainerRef}
                    className="relative prose prose-stone max-w-none w-full max-h-[40vh] overflow-y-auto pr-4"
                  >
                    <p className="text-lg leading-relaxed text-[#444444] font-serif">
                      {words.map((word, i) => {
                        const isActive = i === activeWordIndex;
                        return (
                          <span 
                            key={i} 
                            ref={isActive ? activeWordRef : null}
                            className={`transition-all duration-200 ${isActive ? 'bg-[#5A5A40]/20 text-[#222] rounded px-1 py-0.5 shadow-sm' : 'opacity-60'}`}
                          >
                            {word}{' '}
                          </span>
                        );
                      })}
                    </p>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
};

export default function Page() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  
  const [activeTab, setActiveTab] = useState<'create' | 'history'>('create');
  const [historyIndex, setHistoryIndex] = useState<HistoryMeta[]>([]);
  const [viewingHistoryId, setViewingHistoryId] = useState<string | null>(null);
  
  const [topics, setTopics] = useState('');
  const [isLive, setIsLive] = useState(false);
  
  const [isLoading, setIsLoading] = useState(false);
  const [progressStep, setProgressStep] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [transcript, setTranscript] = useState('');
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [fatalError, setFatalError] = useState<Error | null>(null);

  const liveSessionRef = useRef<any>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const hasCalledFetchNewsRef = useRef<boolean>(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      setIsAuthReady(true);
      if (u) {
        try {
          // Ensure user document exists
          const userDocRef = doc(db, 'users', u.uid);
          const userDocSnap = await getDoc(userDocRef);
          if (!userDocSnap.exists()) {
            await setDoc(userDocRef, {
              uid: u.uid,
              email: u.email || '',
              createdAt: Date.now()
            });
          }
        } catch (err) {
          try {
            handleFirestoreError(err, OperationType.CREATE, `users/${u.uid}`);
          } catch (e) {
            setFatalError(e as Error);
          }
        }
        
        try {
          // Load history index
          const q = query(collection(db, `users/${u.uid}/history`), orderBy('date', 'desc'));
          const snapshot = await getDocs(q);
          const history = snapshot.docs.map(d => d.data() as HistoryMeta);
          setHistoryIndex(history);
        } catch (err) {
          try {
            handleFirestoreError(err, OperationType.GET, `users/${u.uid}/history`);
          } catch (e) {
            setFatalError(e as Error);
          }
        }
      } else {
        setHistoryIndex([]);
      }
    });
    return () => unsubscribe();
  }, []);

  const handleSignIn = async () => {
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      if (err.code === 'auth/popup-closed-by-user') {
        console.log('Sign in cancelled by user.');
      } else {
        console.error("Sign in failed", err);
        setError(err.message || 'Failed to sign in.');
      }
    }
  };

  const handleNewSummary = () => {
    setActiveTab('create');
    setViewingHistoryId(null);
    setTopics('');
    setTranscript('');
    setAudioSrc(null);
    setError('');
  };

  const loadHistoryItem = async (id: string) => {
    setIsLoading(true);
    setError('');
    setTranscript('');
    setAudioSrc(null);
    try {
      if (user) {
        const docRef = doc(db, `users/${user.uid}/history/${id}`);
        const docSnap = await getDoc(docRef);
        if (!docSnap.exists()) throw new Error('Summary not found in history.');
        
        const item = docSnap.data() as HistoryItem;
        setTranscript(item.transcript);
        
        // Fetch audio chunks
        const chunksQuery = query(collection(db, `users/${user.uid}/history/${id}/chunks`), orderBy('index'));
        const chunksSnap = await getDocs(chunksQuery);
        
        let fullBase64 = '';
        chunksSnap.docs.forEach(chunkDoc => {
          fullBase64 += chunkDoc.data().data;
        });
        
        if (fullBase64) {
          setAudioSrc(pcmToWavUrl(fullBase64, 24000));
        } else {
          throw new Error('Audio data not found.');
        }
      } else {
        const item = await get<HistoryItem>(`history-item-${id}`);
        if (!item) throw new Error('Summary not found in history.');
        
        setTranscript(item.transcript);
        setAudioSrc(pcmToWavUrl(item.audioBase64, 24000));
      }
      
      setViewingHistoryId(id);
    } catch (err: any) {
      if (user) {
        try {
          handleFirestoreError(err, OperationType.GET, `users/${user.uid}/history/${id}`);
        } catch (e) {
          setFatalError(e as Error);
        }
      } else {
        console.error(err);
        setError(err.message || 'Failed to load summary.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const startLiveSession = async () => {
    setIsLive(true);
    setError('');
    try {
      const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
      if (!apiKey) throw new Error('Gemini API key is missing. Please ensure it is set in the Secrets panel.');
      const ai = new GoogleGenAI({ apiKey });
      
      audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      nextPlayTimeRef.current = 0;
      hasCalledFetchNewsRef.current = false;
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const source = audioContextRef.current.createMediaStreamSource(stream);
      const processor = audioContextRef.current.createScriptProcessor(4096, 1, 1);
      
      source.connect(processor);
      processor.connect(audioContextRef.current.destination);
      
      const sessionPromise = ai.live.connect({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } }
          },
          systemInstruction: "You are a helpful news assistant for Commute Zen. Ask the user which domains or topics they want news on for their commute. Once they tell you, YOU MUST IMMEDIATELY use the generateCommuteSummary tool to trigger the summary generation. Say 'I am preparing your commute summary now.' and then stop.",
          tools: [{
            functionDeclarations: [{
              name: "generateCommuteSummary",
              description: "Trigger the generation of the commute summary for the specified topics.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  topics: {
                    type: Type.STRING,
                    description: "The topics or domains to fetch news for, e.g. 'Technology and Science'"
                  }
                },
                required: ["topics"]
              }
            }]
          }]
        },
        callbacks: {
          onopen: () => {
            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcm16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) {
                pcm16[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768));
              }
              const base64Data = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
              sessionPromise.then(session => {
                session.sendRealtimeInput({
                  media: { data: base64Data, mimeType: 'audio/pcm;rate=16000' }
                });
              });
            };
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.modelTurn?.parts) {
              for (const part of message.serverContent.modelTurn.parts) {
                if (part.inlineData && part.inlineData.data) {
                  const base64Audio = part.inlineData.data;
                  const pcmData = Uint8Array.from(atob(base64Audio), c => c.charCodeAt(0));
                  const pcm16 = new Int16Array(pcmData.buffer);
                  const audioBuffer = audioContextRef.current!.createBuffer(1, pcm16.length, 24000);
                  const channelData = audioBuffer.getChannelData(0);
                  for (let i = 0; i < pcm16.length; i++) {
                    channelData[i] = pcm16[i] / 32768.0;
                  }
                  const source = audioContextRef.current!.createBufferSource();
                  source.buffer = audioBuffer;
                  source.connect(audioContextRef.current!.destination);
                  
                  const startTime = Math.max(audioContextRef.current!.currentTime, nextPlayTimeRef.current);
                  source.start(startTime);
                  nextPlayTimeRef.current = startTime + audioBuffer.duration;
                }
                
                if (part.text) {
                  console.log("AI Text Response:", part.text);
                }
                
                if (part.functionCall && !hasCalledFetchNewsRef.current) {
                  const call = part.functionCall;
                  if (call.name === "generateCommuteSummary") {
                    hasCalledFetchNewsRef.current = true;
                    const fetchedTopics = (call.args && (call.args as any).topics) ? (call.args as any).topics : "General News";
                    
                    sessionPromise.then(session => {
                      if (call.id) {
                        session.sendToolResponse({
                          functionResponses: [{
                            id: call.id,
                            name: call.name,
                            response: { result: "Success" }
                          }]
                        });
                      }
                    });
                    
                    setTopics(fetchedTopics);
                    handleFetchNews(fetchedTopics);
                    setTimeout(() => stopLiveSession(), 4000);
                  }
                }
              }
            }
            
            if (message.serverContent?.interrupted) {
              nextPlayTimeRef.current = 0;
            }
            
            if (message.toolCall && message.toolCall.functionCalls && message.toolCall.functionCalls.length > 0 && !hasCalledFetchNewsRef.current) {
              const call = message.toolCall.functionCalls[0];
              if (call.name === "generateCommuteSummary") {
                hasCalledFetchNewsRef.current = true;
                const fetchedTopics = (call.args && (call.args as any).topics) ? (call.args as any).topics : "General News";
                
                sessionPromise.then(session => {
                  if (call.id) {
                    session.sendToolResponse({
                      functionResponses: [{
                        id: call.id,
                        name: call.name,
                        response: { result: "Success" }
                      }]
                    });
                  }
                });
                
                setTopics(fetchedTopics);
                handleFetchNews(fetchedTopics);
                setTimeout(() => stopLiveSession(), 4000);
              }
            }
          },
          onclose: () => {
            setIsLive(false);
            stream.getTracks().forEach(track => track.stop());
          },
          onerror: (err) => {
            console.error('Live error:', err);
            setError('Live session error: ' + (err.message || 'Unknown error'));
            setIsLive(false);
          }
        }
      });
      
      liveSessionRef.current = { sessionPromise, stream, processor, source };
    } catch (err: any) {
      console.error(err);
      setError(err.message || "Could not start live session.");
      setIsLive(false);
    }
  };

  const stopLiveSession = () => {
    setIsLive(false);
    if (liveSessionRef.current) {
      const { sessionPromise, stream, processor, source } = liveSessionRef.current;
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t: any) => t.stop());
      sessionPromise.then((s: any) => s.close());
      liveSessionRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
  };

  const handleFetchNews = async (topicsToFetch: string) => {
    if (!topicsToFetch.trim()) {
      setError('Please enter topics or domains.');
      return;
    }
    setIsLoading(true);
    setError('');
    setTranscript('');
    setAudioSrc(null);

    try {
      setProgressStep('Connecting to AI...');
      setProgressPercent(10);
      
      const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
      if (!apiKey) throw new Error('Gemini API key is missing. Please ensure it is set in the Secrets panel.');
      const ai = new GoogleGenAI({ apiKey });

      // Step 1: Fetch news using googleSearch
      setProgressStep('Fetching latest news...');
      setProgressPercent(30);
      const newsResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: `Fetch the latest news details strictly about the following domains/topics: ${topicsToFetch}. Filter out any general tech, AI, or unrelated news unless explicitly requested. Provide a comprehensive summary of the latest news strictly related to these topics.` }] }],
        config: {
          tools: [{ googleSearch: {} }],
        }
      });
      
      const newsText = newsResponse.text;
      if (!newsText) throw new Error('Failed to fetch news or no news found for these topics.');

      // Step 2: Generate Summary Script
      setProgressStep('Drafting summary script...');
      setProgressPercent(60);
      const summaryResponse = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [{ role: 'user', parts: [{ text: `You are a calm, professional podcast host. Summarize the following news into a concise, engaging, and easy-to-listen-to script for a morning commute. Keep it strictly focused on the requested topics (${topicsToFetch}) and ignore any unrelated news. Keep it under 2 minutes when spoken. Do not include any sound effects, stage directions, or speaker labels. Just provide the raw text to be spoken in a warm, conversational tone.\n\nNews:\n${newsText}` }] }],
      });

      const script = summaryResponse.text;
      if (!script) throw new Error('Failed to generate summary script.');
      
      setTranscript(script);

      // Step 3: Generate Audio
      setProgressStep('Generating audio...');
      setProgressPercent(85);
      const audioResponse = await ai.models.generateContent({
        model: 'gemini-2.5-flash-preview-tts',
        contents: [{ parts: [{ text: `Say cheerfully: ${script}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Zephyr' },
            },
          },
        },
      });

      const base64Audio = audioResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) throw new Error('Failed to generate audio content.');

      setProgressStep('Finalizing...');
      setProgressPercent(100);
      
      const audioUrl = pcmToWavUrl(base64Audio, 24000);
      setAudioSrc(audioUrl);

      // Save to history
      const id = Date.now().toString();
      const title = topicsToFetch.substring(0, 60).replace(/\n/g, ' ') + '...';
      const meta: HistoryMeta = { id, url: topicsToFetch, title, date: Date.now() };
      
      if (user) {
        try {
          // Save metadata
          await setDoc(doc(db, `users/${user.uid}/history/${id}`), {
            ...meta,
            transcript: script,
            userId: user.uid
          });
          
          // Save audio chunks (max ~800KB per chunk)
          const chunkSize = 800000;
          for (let i = 0; i < base64Audio.length; i += chunkSize) {
            const chunkData = base64Audio.substring(i, i + chunkSize);
            const chunkIndex = Math.floor(i / chunkSize);
            await setDoc(doc(db, `users/${user.uid}/history/${id}/chunks/${chunkIndex}`), {
              index: chunkIndex,
              data: chunkData
            });
          }
          
          setHistoryIndex(prev => [meta, ...prev]);
        } catch (err) {
          try {
            handleFirestoreError(err, OperationType.CREATE, `users/${user.uid}/history/${id}`);
          } catch (e) {
            setFatalError(e as Error);
          }
        }
      } else {
        // Fallback to local if not logged in
        const item: HistoryItem = { ...meta, transcript: script, audioBase64: base64Audio };
        setHistoryIndex(prev => {
          const newIndex = [meta, ...prev];
          set('history-index', newIndex).catch(console.error);
          return newIndex;
        });
        await set(`history-item-${id}`, item);
      }

    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An error occurred while generating the summary.');
    } finally {
      setIsLoading(false);
      setProgressStep('');
      setProgressPercent(0);
    }
  };

  if (fatalError) {
    throw fatalError;
  }

  return (
    <div className="min-h-screen text-[#333333] selection:bg-[#5A5A40] selection:text-[#f5f5f0] flex flex-col items-center py-12 px-4 sm:px-6 lg:px-8 relative">
      <div className="absolute top-6 right-6">
        {isAuthReady && (
          user ? (
            <button onClick={() => auth.signOut()} className="text-xs font-medium text-[#888] hover:text-[#222] transition-colors">
              Sign Out
            </button>
          ) : (
            <button onClick={handleSignIn} className="text-xs font-medium text-[#888] hover:text-[#222] transition-colors">
              Sign In
            </button>
          )
        )}
      </div>
      <main className="w-full max-w-2xl flex flex-col gap-10">
        
        {/* Header */}
        <header className="flex flex-col items-center text-center gap-4 mt-6">
          <motion.div 
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-16 h-16 rounded-full bg-[#5A5A40] text-[#f5f5f0] flex items-center justify-center shadow-lg"
          >
            <Headphones size={28} strokeWidth={1.5} />
          </motion.div>
          <motion.div
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.1 }}
            className="flex flex-col gap-2"
          >
            <h1 className="text-4xl sm:text-5xl font-serif tracking-tight text-[#222222]">
              Commute Zen
            </h1>
            <p className="text-[#666666] text-base max-w-md mx-auto font-light">
              Paste an article link. We&apos;ll craft a calming audio summary for your journey.
            </p>
          </motion.div>
        </header>

        {/* Tabs */}
        <div className="flex justify-center gap-2 mt-2">
          <button
            suppressHydrationWarning
            onClick={handleNewSummary}
            className={`flex items-center gap-2 px-5 py-2 rounded-full text-sm font-medium transition-all ${activeTab === 'create' ? 'bg-[#5A5A40] text-white shadow-md' : 'bg-white text-[#666] hover:bg-gray-50'}`}
          >
            <Plus size={16} />
            New Summary
          </button>
          <button
            suppressHydrationWarning
            onClick={() => setActiveTab('history')}
            className={`flex items-center gap-2 px-5 py-2 rounded-full text-sm font-medium transition-all ${activeTab === 'history' ? 'bg-[#5A5A40] text-white shadow-md' : 'bg-white text-[#666] hover:bg-gray-50'}`}
          >
            <Clock size={16} />
            History
          </button>
        </div>

        {activeTab === 'history' ? (
          <motion.section 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="w-full flex flex-col gap-4"
          >
            {viewingHistoryId && audioSrc ? (
              <div className="w-full flex flex-col gap-4">
                <button 
                  suppressHydrationWarning
                  onClick={() => { setViewingHistoryId(null); setAudioSrc(null); setTranscript(''); }}
                  className="self-start flex items-center gap-2 text-sm font-medium text-[#666] hover:text-[#222] transition-colors px-4 py-2 rounded-full hover:bg-white/50"
                >
                  <ArrowLeft size={16} />
                  Back to History
                </button>
                <div className="bg-white p-8 rounded-[1.5rem] shadow-[0_8px_30px_rgb(0,0,0,0.04)] flex flex-col items-center gap-8">
                  <p className="text-xs uppercase tracking-[0.2em] text-[#888888] font-semibold">Archived Summary</p>
                  <CustomAudioPlayer src={audioSrc} transcript={transcript} />
                </div>
              </div>
            ) : historyIndex.length === 0 ? (
              <div className="text-center py-12 text-[#888] font-serif text-lg">
                No summaries yet. Create your first one!
              </div>
            ) : (
              historyIndex.map((item) => (
                <button
                  suppressHydrationWarning
                  key={item.id}
                  onClick={() => loadHistoryItem(item.id)}
                  className="bg-white p-5 rounded-2xl shadow-[0_4px_20px_rgb(0,0,0,0.03)] hover:shadow-[0_8px_30px_rgb(0,0,0,0.06)] transition-all text-left flex flex-col gap-2 border border-transparent hover:border-[#5A5A40]/10"
                >
                  <div className="flex justify-between items-start gap-4">
                    <h3 className="font-serif text-lg text-[#222] font-medium line-clamp-2">{item.title}</h3>
                    <span className="text-xs text-[#888] whitespace-nowrap bg-[#f5f5f0] px-2 py-1 rounded-md">
                      {new Date(item.date).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="text-sm text-[#666] truncate">{item.url}</p>
                </button>
              ))
            )}
          </motion.section>
        ) : (
          <>
            {/* Input Section */}
            <motion.section 
              initial={{ y: 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.2 }}
              className="flex flex-col gap-6 w-full items-center"
            >
              <div className="flex justify-center mt-4">
                <button
                  suppressHydrationWarning
                  onClick={isLive ? stopLiveSession : startLiveSession}
                  disabled={isLoading}
                  className={`w-20 h-20 flex items-center justify-center rounded-full transition-all shadow-lg hover:shadow-xl disabled:shadow-none disabled:cursor-not-allowed active:scale-95 ${
                    isLive 
                      ? 'bg-red-500 text-white animate-pulse' 
                      : 'bg-[#5A5A40] text-[#f5f5f0] hover:bg-[#4a4a35]'
                  }`}
                  title={isLive ? "End Conversation" : "Talk to Agent"}
                >
                  {isLive ? (
                    <Square size={32} fill="currentColor" />
                  ) : (
                    <Mic size={32} />
                  )}
                </button>
              </div>

              <AnimatePresence>
                {error && (
                  <motion.p 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="text-red-500 text-sm px-4 text-center"
                  >
                    {error}
                  </motion.p>
                )}
              </AnimatePresence>
            </motion.section>

            {/* Loading / Results Modal */}
            <AnimatePresence>
              {(isLoading || audioSrc) && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#f5f5f0]/60 backdrop-blur-md"
                >
                  <motion.div
                    initial={{ scale: 0.95, opacity: 0, y: 20 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.95, opacity: 0, y: 20 }}
                    className="bg-white rounded-[2rem] shadow-2xl p-8 w-full max-w-md flex flex-col gap-6 border border-[#e5e5df] relative"
                  >
                    {audioSrc && !isLoading && (
                      <button 
                        onClick={() => { setAudioSrc(null); setTopics(''); }}
                        className="absolute top-6 right-6 p-2 text-[#888] hover:text-[#222] transition-colors rounded-full hover:bg-gray-100"
                      >
                        <X size={20} />
                      </button>
                    )}

                    {isLoading ? (
                      <>
                        <div className="flex flex-col items-center text-center gap-2">
                          <div className="w-12 h-12 rounded-full bg-[#5A5A40]/10 text-[#5A5A40] flex items-center justify-center mb-2">
                            <Loader2 size={24} className="animate-spin" />
                          </div>
                          <h3 className="font-serif text-xl text-[#222] font-medium">Crafting your commute</h3>
                          <p className="text-sm text-[#666]">{progressStep}</p>
                        </div>

                        <div className="relative">
                          <input
                            type="text"
                            value={topics}
                            readOnly
                            className="w-full p-4 pl-12 bg-[#f5f5f0] rounded-xl border border-transparent text-sm text-[#444] font-sans outline-none"
                          />
                          <SearchIcon size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#888]" />
                        </div>

                        <div className="w-full bg-[#e5e5df] rounded-full h-2 overflow-hidden">
                          <motion.div 
                            className="bg-[#5A5A40] h-full rounded-full"
                            initial={{ width: 0 }}
                            animate={{ width: `${progressPercent}%` }}
                            transition={{ duration: 0.5 }}
                          />
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-col items-center gap-8 pt-4">
                        <p className="text-xs uppercase tracking-[0.2em] text-[#888888] font-semibold">Your Audio Summary</p>
                        <CustomAudioPlayer src={audioSrc!} transcript={transcript} />
                      </div>
                    )}
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}

      </main>
    </div>
  );
}
