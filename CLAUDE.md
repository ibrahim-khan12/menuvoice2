## Project Context / Accessibility

This is a voice-first accessibility app (MenuVoice) for blind/visually-impaired users. Always prioritize audio guidance and VoiceOver compatibility over visual-only solutions (color overlays, visual cues). Remove emojis from user-facing speech output.

## Deployment

Deployment target is Vercel via GitHub auto-deploy. The whitelisted OAuth origin must match the actual deployment URL, and server functions need the non-VITE prefixed env vars (e.g. OPENAI_API_KEY, not just VITE_OPENAI_API_KEY).

## Writing & Content

When writing user-facing copy (emails, newsletters, taglines, postings), avoid AI-slop tone: no salesy language, no fabricated claims, no unverified promises. Keep it factual and grounded in the actual codebase/product.
