# Product

## Register

product

## Users

Primary: blind and low-vision people dining at restaurants. They may use a screen reader or rely entirely on the phone's speaker. They are navigating an environment — a restaurant, a noisy table, a menu in a format they cannot read — that was not designed for them. They want independence, not assistance theater.

Secondary: sighted users who prefer voice for convenience (hands full, low light, unfamiliar cuisine).

Context of use: phone in hand or pocket, noisy restaurant environment, time pressure of a waiter waiting for an order.

## Product Purpose

MenuVoice reads restaurant menus aloud and holds a voice conversation with the user about the food, so they can decide what to order without help from another person. It captures menus by camera or URL, parses them with AI, and lets the user ask questions ("what's in the carbonara?", "anything without shellfish?") by voice. It learns food preferences and allergy constraints over time.

Success: a blind user sits down at an unfamiliar restaurant, opens MenuVoice, and orders confidently without having to ask anyone to read the menu for them.

## Brand Personality

Clear, confident, human.

The app talks like a knowledgeable friend who happens to know the menu, not like a voice assistant or accessibility tool. It never condescends. It respects that the user is capable of making their own decisions — its job is to give them the information to do so.

## Anti-references

- Medical or clinical accessibility tools: cold, sterile, designed-for-disabled-people aesthetics.
- Generic SaaS dashboards: sidebar nav, metric tiles, navy-and-white enterprise grid.
- Chatbot / AI product aesthetics: white backgrounds, floating bubbles, the ChatGPT look.
- Gamified or playful apps: bouncy, bright, confetti-driven — Duolingo energy.

## Design Principles

1. **Voice is the interface.** Visual UI supports audio, not the other way around. Every screen should work in the dark with one thumb. Nothing requires reading to operate.
2. **Confidence over caution.** The app speaks first, acts decisively, and does not hedge with "I think" or "maybe." Users have enough uncertainty at the table.
3. **Dignity through restraint.** No cheerful disability language, no patronizing copy. The app assumes competence. Short sentences, direct labels, no unnecessary explanation.
4. **Safety is non-negotiable.** Allergen warnings always surface before describing a dish. Never buried, never muted.
5. **Earn trust slowly.** Preferences are learned from what the user actually orders, not interrogated upfront. The app gets smarter without asking to.

## Accessibility & Inclusion

- WCAG AAA target throughout (contrast ratios confirmed in theme.ts).
- Minimum 64×64px touch targets on all interactive elements.
- All state changes announced via aria-live or spoken audio (earcons for start/stop recording).
- Screen reader compatible: aria-label on every interactive element, semantic heading hierarchy.
- `prefers-reduced-motion` should be respected for any animations added.
- Voice-first: every task completable by voice alone; typing is always a fallback, never the primary path.
