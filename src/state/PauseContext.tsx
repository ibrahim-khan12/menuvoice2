import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { stopSpeaking } from '../lib/speech';

interface PauseCtx {
  paused: boolean;
  status: string;
  pause: (message?: string) => void;
  resume: () => void;
  registerStopListening: (fn: (() => void) | null) => () => void;
}

const Ctx = createContext<PauseCtx | null>(null);

export function PauseProvider({ children }: { children: React.ReactNode }) {
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState('');
  const stopListeningRef = useRef<(() => void) | null>(null);

  const pause = useCallback((message = 'MenuVoice is paused. Speech and listening are stopped.') => {
    stopSpeaking();
    stopListeningRef.current?.();
    setPaused(true);
    setStatus(message);
  }, []);

  const resume = useCallback(() => {
    setPaused(false);
    setStatus('MenuVoice is resumed. Use the current screen controls to continue.');
  }, []);

  const registerStopListening = useCallback((fn: (() => void) | null) => {
    stopListeningRef.current = fn;
    return () => {
      if (stopListeningRef.current === fn) stopListeningRef.current = null;
    };
  }, []);

  const value = useMemo(
    () => ({ paused, status, pause, resume, registerStopListening }),
    [paused, status, pause, resume, registerStopListening],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePause(): PauseCtx {
  const value = useContext(Ctx);
  if (!value) throw new Error('usePause must be used inside PauseProvider');
  return value;
}
