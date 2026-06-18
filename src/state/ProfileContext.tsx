import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { UserProfile, EMPTY_PROFILE } from '../types';
import { loadProfile, saveProfile } from '../lib/storage';
import { track } from '../lib/telemetry';
import { setAppVoice } from '../lib/speech';

interface ProfileCtx {
  profile: UserProfile;
  loaded: boolean;
  update: (patch: Partial<UserProfile>) => Promise<void>;
  reset: () => Promise<void>;
}

const Ctx = createContext<ProfileCtx | null>(null);

export function ProfileProvider({ children }: { children: React.ReactNode }) {
  const [profile, setProfile] = useState<UserProfile>(EMPTY_PROFILE);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    loadProfile().then((p) => {
      setAppVoice(p.appVoice !== false);
      setProfile(p);
      setLoaded(true);
    });
  }, []);

  const update = useCallback(
    async (patch: Partial<UserProfile>) => {
      track('profile', 'update', { content: { fields: Object.keys(patch) } });
      setProfile((prev) => {
        const next = { ...prev, ...patch };
        if (Object.prototype.hasOwnProperty.call(patch, 'appVoice')) {
          setAppVoice(next.appVoice !== false);
        }
        saveProfile(next).catch(() => {});
        return next;
      });
    },
    []
  );

  const reset = useCallback(async () => {
    setAppVoice(true);
    setProfile({ ...EMPTY_PROFILE });
    await saveProfile({ ...EMPTY_PROFILE });
  }, []);

  return <Ctx.Provider value={{ profile, loaded, update, reset }}>{children}</Ctx.Provider>;
}

export function useProfile(): ProfileCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useProfile must be used inside ProfileProvider');
  return v;
}
