# Smoke Test Results — Production Menu Pipeline

- Target: https://menuvoice-sigma.vercel.app
- Script: `scripts/smoke-restaurants.mjs` (sequential POSTs, 60s client timeout each)
- Date: 2026-06-12
- Two full runs were executed (~10 min apart). Run 1's menu-from-url URLs turned out to be dead upstream links (tester error, but useful as upstream-error-path data); Run 2 used verified-live URLs.

## Run 2 (primary — all URLs verified live beforehand)

### /api/find-menu

| Case | Query | HTTP | Elapsed | Items | restaurantName | via | incomplete | Error |
|---|---|---|---|---|---|---|---|---|
| National chain | Olive Garden | 404 | 11,757 ms | 0 | Olive Garden | - | absent | "I found the restaurant, but their menu does not seem to be posted online." |
| Fast-food chain | Panda Express | 404 | 6,032 ms | 0 | Panda Express | - | absent | "The restaurant was found, but I could not reliably read the full current menu from the official menu page in a way that let me extract every item without inventing missing entries." |
| Local + city | Lou Malnati's, Chicago | 200 | 11,690 ms | 10 | Lou Malnati's, Chicago | search | absent | - |
| Coffee shop | Dunkin | 200 | 14,827 ms | 42 | Dunkin' | search | absent | - |
| JS-app website | McAlister's Deli | 404 | 5,196 ms | 0 | McAlister's Deli | - | absent | "I found the restaurant, but their menu does not seem to be posted online." |
| Fake restaurant | Zzyzx Quantum Bistro, Nowhere | 404 | 8,639 ms | 0 | null | - | absent | "I could not find a restaurant by that name, so I could not verify any menu." |

### /api/menu-from-url

| Case | URL | HTTP | Elapsed | Items | restaurantName | incomplete | Error |
|---|---|---|---|---|---|---|---|
| HTML menu page | https://www.loumalnatis.com/menu/ | 200 | 18,419 ms | 58 | Lou Malnati's Pizzeria | absent | - |
| HTML menu page 2 | https://www.osf.com/menu/ | 200 | 14,052 ms | 51 | The Old Spaghetti Factory | absent | - |
| PDF menu | https://superdawg.com/.../print-menu-Chicago-11_2025.pdf | 200 | 14,450 ms | 39 | Superdawg drive-in | absent | - |

## Run 1 (same find-menu queries, ~10 min earlier)

| Case | Query | HTTP | Elapsed | Items | via | Error |
|---|---|---|---|---|---|---|
| Olive Garden | 404 | 6,993 ms | 0 | - | "menu does not seem to be posted online" | |
| Panda Express | 404 | 7,781 ms | 0 | - | "menu does not seem to be posted online" | |
| Lou Malnati's, Chicago | 200 | 27,882 ms | 58 | url | - | |
| Dunkin | 404 | 11,730 ms | 0 | - | "...menu items, prices, and ingredients were not exposed in the page text I could access." | |
| McAlister's Deli | 404 | 9,265 ms | 0 | - | "menu does not seem to be posted online" | |
| Zzyzx Quantum Bistro | 404 | 2,446 ms | 0 | - | "I could not find the restaurant or any menu online." | |

Run 1 menu-from-url (dead upstream links — error path check): all three returned HTTP 502 quickly (320–1,494 ms) with clear messages, e.g. "That website returned an error (404). Double-check the link and try again." Upstream 4xx/5xx is surfaced as our 502, not 200-with-empty-menu — good.

## Observations

1. **Major national chains consistently fail (0/2 runs each): Olive Garden, Panda Express, McAlister's Deli.** All three were correctly identified (restaurantName populated) but returned 404 with no items. Their menus ARE online; the failure mode is that the search model can't read JS-rendered chain menu pages, and stage 2 (server-side fetch of menuUrl) either got no usable menuUrl or also failed. The error copy "their menu does not seem to be posted online" is **factually wrong** for these — a blind user would be told a falsehood. This is the biggest systemic problem.

2. **Results are nondeterministic run-to-run.** Dunkin: 404 (run 1) -> 200 with 42 items (run 2). Lou Malnati's: 58 items via `url` (run 1) -> 10 items via `search` (run 2). Same query, minutes apart.

3. **Lou Malnati's run 2 returned only 10 items without any incomplete signal** — their actual menu page yields 58 items (proven by menu-from-url in the same run). A ~17% menu presented as if complete contradicts the "This wasn't a complete menu" UX requirement.

4. **The `incomplete` field never appeared in any successful response** (9 successes across both runs, including the partial Lou Malnati's result). Either the deployed build predates the flag or it's being stripped; it never reaches clients.

5. **/api/menu-from-url is solid when given a real menu URL: 3/3 passed** (HTML x2, PDF x1) with healthy item counts (39–58) and correct restaurant names, in 14–18.5s. The PDF path works.

6. **Fake restaurant handled correctly both runs**: 404 with an honest "could not find" message, no hallucinated menu, restaurantName null.

7. **Latency**: successes ranged 11.7–27.9s (slowest: Lou Malnati's run 1 at 27.9s, two-stage search->fetch->parse). Failures fail reasonably fast (2.4–11.8s). Nothing hit the 60s client timeout; server search stage has its own 50s cap.

8. **Error message inconsistency**: failure `reason` text varies per run for the same restaurant (compare Panda Express run 1 vs run 2) because it's model-generated. Run 2's Panda Express message leaks prompt language ("without inventing missing entries") — not appropriate for end users.

## Suggested tuning targets (from the data, not implemented)

- Big-chain queries: stage 2 should be attempted more aggressively (the search model appears to return found=true but no usable `menuUrl` for chains), or maintain a known-chain URL shortlist.
- Replace model-generated `reason` with fixed, honest copy; never claim "not posted online" when found=true.
- Verify the deployed build actually emits `menu.incomplete`; the flag is absent from all production responses.
- Low item counts via `search` (e.g. 10 items) should trigger the stage-2 URL fetch even when count >= 3, or set incomplete=true.
