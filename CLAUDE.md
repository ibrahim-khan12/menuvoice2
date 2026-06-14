## Project Context / Accessibility

This is a voice-first accessibility app (MenuVoice) for blind/visually-impaired users. Always prioritize audio guidance and VoiceOver compatibility over visual-only solutions (color overlays, visual cues). Remove emojis from user-facing speech output.

## Deployment

Deployment target is Vercel via GitHub auto-deploy. The whitelisted OAuth origin must match the actual deployment URL, and server functions need the non-VITE prefixed env vars (e.g. OPENAI_API_KEY, not just VITE_OPENAI_API_KEY).

## Writing & Content

When writing user-facing copy (emails, newsletters, taglines, postings), avoid AI-slop tone: no salesy language, no fabricated claims, no unverified promises. Keep it factual and grounded in the actual codebase/product.

## Project Memory

MenuVoice is a voice-first accessibility web app for blind and low-vision users. The app is a React + Vite site that gets pushed to GitHub, auto-deploys on Vercel, and uses Vercel serverless functions for anything that needs a backend.

Most user state lives locally first in the browser. Profile data and saved restaurants sync through `api/sync` and Vercel KV. Telemetry goes through `api/events` into Vercel Postgres, and the reporting/dashboard endpoints read from that same events table. Optional menu photo uploads use Vercel Blob.

In production, OpenAI requests should go through the serverless API routes so the server key stays hidden. Local development can still use the direct `VITE_OPENAI_API_KEY` path. When checking the repo later, focus on the voice-first flow, the local-to-cloud sync path, and the analytics/reporting backend before anything visual-only.
