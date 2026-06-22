/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OPENAI_API_KEY: string;
  readonly VITE_TTS_MODEL?: string;
  readonly VITE_TTS_VOICE?: string;
  readonly VITE_VISION_MODEL?: string;
  readonly VITE_CHAT_MODEL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
