# MenuVoice Fixes & Improvements Needed

## Em-Dash Removal (USER-FACING TEXT)
**Status:** Partially completed.

### Fixed:
- ✅ `UrlScreen.tsx`: Error message and Body text
- ✅ `ConversationScreen.tsx`: Phase labels ("Your turn. Tap to talk", "Listening. Tap when you're done"), menu aria-labels
- ✅ `OnboardingScreen.tsx`: Intro text and help text 
- ✅ `SettingsScreen.tsx`: All aria-labels
- ✅ `openai.ts`: System prompts, error messages, JSON schema instructions

### Replacements made:
- "Hey, sorry — I couldn't..." → "Hey, sorry. I couldn't..."
- "Your turn — tap to talk" → "Your turn. Tap to talk"
- "Listening — tap when you're done" → "Listening. Tap when you're done"
- "Just a heads up — this menu" → "Just a heads up. This menu"
- "Heads up — this contains" → "Heads up. This contains"
- All other em-dashes replaced with periods or restructured sentences

### Still TODO:
- Documentation files (PROGRESS.md, IDEAS.md, etc.) - lower priority
- Comments in code - lower priority
- Website files - lower priority

---

## Browse Mode VoiceOver Accessibility Issues
**Priority:** HIGH - Accessibility blocker for blind/low-vision users.

### Problems:
1. **Heading hierarchy broken**: Food item name, description, and ingredients all appear at same heading level (h3) in red
2. **Price placement**: Price is at same level as title; should be nested/subordinate
3. **Visual/Audio mismatch**: Red text styling not accessible via VoiceOver; users can't read the hierarchy properly
4. **Missing user guidance**: Users don't know they need to turn on VoiceOver Heading Rotor to navigate browse mode effectively

### Required fixes:
1. Restructure browse item markup:
   - `<h3>` = Food title (item name)
   - `<h4>` or `<div>` = Price (subordinate to title)
   - `<h4>` or `<div>` = Description
   - `<h4>` or `<div>` = Ingredients (or list format)

2. Add user guidance:
   - When entering browse mode, speak: "You can browse this menu using VoiceOver. To navigate by headings, open the VoiceOver rotor and select 'Headings'. Then you can jump from food to food using up and down arrows."
   - Optional: Provide instructions on how to open rotor (varies by device):
     - iOS: 3-finger swipe up (or Z gesture)
     - Mac: VO key + U

3. Remove or restructure red text styling to be semantically meaningful

4. Test with VoiceOver enabled to verify proper heading navigation

---

## Speaking Page Redesign
**Priority:** HIGH - Core user interaction flow is broken by overlap.

### Problems:
1. **Text overlap**: When a message is sent, user's text and assistant's reply overlap with other UI elements
2. **VoiceOver broken**: Overlapping text breaks screen reader navigation
3. **Red text unreadable**: Red text for messages is not readable against background and hard to parse
4. **No visual separation**: User text, assistant reply, and surrounding UI have no clear spatial boundaries

### Required fixes:
1. Create a dedicated conversation area with clear spatial boundaries
   - Separate section/container for message history
   - Padding/margins to prevent overlap with buttons or other elements
   - Clear visual distinction between user messages and assistant messages

2. Improve text readability:
   - Change message styling from red to readable color
   - Add background color or box styling to make messages stand out
   - Ensure WCAG AAA contrast ratio

3. VoiceOver compatibility:
   - Messages should be in logical reading order
   - Use aria-live regions or proper semantic structure for new messages
   - Each message should be a distinct, non-overlapping element

4. Layout structure (suggested):
   ```
   [Phone Header / Nav]
   
   [Browse/Conversation Area]
   ├─ Previous messages (scrollable)
   ├─ Latest message (with clear visual box)
   └─ User message (with clear visual box)
   
   [Input area]
   ├─ Mic button
   ├─ Mode toggle
   └─ etc.
   ```

5. Test that:
   - No overlap occurs when multiple messages are on screen
   - VoiceOver reads messages in correct order
   - Touch targets (buttons) are not obscured
   - Conversation remains readable even with many messages

---

## Auto-Capture Camera Issues & Enhancements

### 1. First Login Auto-Capture Delay & Immediate Audio
- **Problem**: Auto-capture doesn't work on first login. Only works on second attempt (after cancel + re-enter).
- **Issue**: Likely timing/initialization problem. Should be much faster.
- **Immediate Audio**: As soon as capture menu turns on, should start talking almost right away.
- **Specific Instruction**: Should clearly say "click the analyze button when ready"
- **Fix Needed**: Debug initialization flow; ensure audio/camera perms complete before user interaction. Trigger audio guidance immediately on menu open.

### 2. Audio Guidance Missing
- **Current**: "Auto capture is all hold your phone flat" is only displayed as text.
- **Needed**: Verbalize these directions when capture mode starts talking. User should hear instruction aloud.
- **Specific**: Should say "click the analyze button when ready"

### 3. Horizontal Orientation & Picture Taking
- **Problem**: Phone can flip horizontally, but user cannot actually take a picture in landscape.
- **Needed**: Support taking pictures in landscape/horizontal orientation.

### 4. Zoom In/Out Capability
- **Problem**: No zoom controls; user must physically adjust phone distance.
- **Needed**: Add pinch-to-zoom or +/- buttons.
- **Accessibility**: Critical for seated users who can't move phone far away.

### 5. Audio Feedback on Capture
- **Needed**: When picture taken, verbalize + play sound effect so user knows photo was successful.

### 6. Zoom Preview vs. Actual Capture Range Mismatch
- **Problem**: Preview shows smaller chunk than actual camera captures (verified vs. native camera app).
- **Fix Needed**: Preview must accurately represent actual capture range.

---

## Home Page Redesign
**Priority:** HIGH - Unusable; UI elements overlapping.

- **Problem**: Beginning/home page UI elements overlap with each other, layout is broken.
- **Needed**: Full redesign with clean, non-overlapping layout.
- **Requirements**: Must work for both visual and VoiceOver navigation.

---

## Allergy Spellcheck
**Priority:** MEDIUM - Nice-to-have for voice-first UX.

- **Feature**: Auto-correct user misspellings of allergy names.
- **Example**: "peanutts" → "peanuts"
- **Implementation**: Normalize against canonical allergy list or fuzzy-match via LLM.
