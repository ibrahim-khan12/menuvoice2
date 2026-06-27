# Cartesia Voice Test Branch

This branch lets MenuVoice test Cartesia Sonic 3.5 for text-to-speech and Cartesia Ink for the secondary speech-to-text paths without replacing the app's OpenAI menu reasoning.

## What Changes

- `/api/tts` can route to Cartesia Sonic 3.5 when `CARTESIA_TTS_ENABLED=true`.
- `/api/transcribe` can route to Cartesia STT when `CARTESIA_STT_ENABLED=true`.
- OpenAI remains the fallback if Cartesia is disabled, missing config, or errors.
- The core menu parsing, chat replies, allergy handling, and session learnings still use OpenAI.
- The main conversation listen loop still uses browser speech recognition unless you later choose to replace it.

## Vercel Preview Setup

Set these environment variables on a preview deployment for this branch:

```text
VITE_AUDIO_PROVIDER=cartesia
CARTESIA_API_KEY=sk_car_...
CARTESIA_VOICE_ID=<voice id from Cartesia>
CARTESIA_TTS_ENABLED=true
CARTESIA_STT_ENABLED=true
OPENAI_API_KEY=<existing OpenAI key>
REPORT_EMAIL_TO=2firemaster27@gmail.com
```

Optional:

```text
CARTESIA_TTS_MODEL=sonic-3.5
CARTESIA_TTS_SPEED=1
CARTESIA_ALERT_EMAIL_TO=2firemaster27@gmail.com
CARTESIA_ALERT_COOLDOWN_SECONDS=21600
```

### Multiple Cartesia keys (automatic failover)

Free Cartesia credits run out fast, so the server can hold several keys and roll
to the next one the moment a key hits a credit/quota wall. Supply keys in any of
these ways (they are all merged and de-duplicated):

```text
CARTESIA_API_KEYS=sk_car_first,sk_car_second,sk_car_third
CARTESIA_API_KEY=sk_car_single        # still works, treated as one more key
CARTESIA_API_KEY_1=sk_car_a           # numbered keys 1..10 also picked up
CARTESIA_API_KEY_2=sk_car_b
```

Rotation applies to TTS, STT, and the realtime STT token. A key that returns a
credit error (HTTP 402 or a credit/quota/billing message) is skipped for ~6
hours, then retried. Only when *every* key is exhausted does the app fall back to
OpenAI and send the single credit alert email.

Cartesia credit and quota failures email `CARTESIA_ALERT_EMAIL_TO`, falling back to `REPORT_EMAIL_TO`, then `2firemaster27@gmail.com`. Alerts use the existing email transport: `RESEND_API_KEY` with optional `RESEND_FROM`, or `GMAIL_USER` plus `GMAIL_APP_PASSWORD`.

To test only the voice output first, set `CARTESIA_TTS_ENABLED=true` and leave `CARTESIA_STT_ENABLED=false`.

To test realtime voice input in the conversation loop, also set:

```text
VITE_STT_PROVIDER=cartesia
CARTESIA_REALTIME_STT_ENABLED=true
```

This uses Cartesia Ink 2 over a browser WebSocket. The browser receives only a short-lived STT access token from `/api/transcribe?cartesiaToken=1`; the Cartesia API key stays server-side in Vercel.

## How To Compare

1. Open the preview deployment for this branch.
2. Capture or load the same menu you use on the current production app.
3. Ask the same short questions in voice mode.
4. Compare:
   - time until the voice starts speaking,
   - how natural the answer sounds,
   - whether pronunciation is better,
   - whether the app ever overlaps with VoiceOver,
   - whether fallback still works if Cartesia fails.

## Notes

Cartesia requires a server-side API key and a voice ID. The app does not expose the Cartesia key to the browser. Free Cartesia credits are only enough for a small test, so do not treat this branch as a cost solution until usage data proves it.
