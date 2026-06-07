# MenuVoice WCAG 2.1 AA Accessibility Report

**Generated:** 2026-06-07T07:08:09.485Z
**Screens audited:** 7
**Total violations:** 0 (0 critical, 0 serious, 0 moderate, 0 minor)
**WCAG 2.1 AA pass rate:** 100% (7/7 screens with zero critical/serious)

## Per-Screen Health Score

| Screen | Critical | Serious | Moderate | Minor | Status |
|--------|----------|---------|----------|-------|--------|
| [login](screenshots/login.png) | 0 | 0 | 0 | 0 | ✅ PASS |
| [onboarding](screenshots/onboarding.png) | 0 | 0 | 0 | 0 | ✅ PASS |
| [home](screenshots/home.png) | 0 | 0 | 0 | 0 | ✅ PASS |
| [capture](screenshots/capture.png) | 0 | 0 | 0 | 0 | ✅ PASS |
| [url](screenshots/url.png) | 0 | 0 | 0 | 0 | ✅ PASS |
| [saved](screenshots/saved.png) | 0 | 0 | 0 | 0 | ✅ PASS |
| [settings](screenshots/settings.png) | 0 | 0 | 0 | 0 | ✅ PASS |

## Overall Summary

| Impact | Count |
|--------|-------|
| Critical | 0 |
| Serious  | 0 |
| Moderate | 0 |
| Minor    | 0 |
| **Total** | **0** |

## Violations

Zero violations found across all 7 screens. 🎉

## Fixes Applied

No fix log available.

## Accessibility Features Verified

- **Skip navigation link**: `<a href="#main-content">` present in index.html
- **Main landmark**: `<main id="main-content">` with `tabIndex={-1}` for focus management
- **ARIA live region**: `<div role="status" aria-live="polite">` for screen reader announcements
- **Focus management**: Screen component focuses `<main>` on every mount
- **Reduced motion**: All animations suppressed when `prefers-reduced-motion: reduce`
- **Color contrast**: All text uses WCAG AAA tokens (≥7:1 for primary, ≥4.5:1 for secondary)
- **Touch targets**: All interactive elements ≥64px (--touch CSS variable)
- **Button labels**: All buttons have `aria-label` attributes
- **Input labels**: All inputs have `aria-label` or associated `<label>`
- **Heading hierarchy**: Each screen has exactly one `<h1>`
