// Small shared helpers.

/** Turn a comma/newline separated string into a clean list of trimmed items. */
export function splitList(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse a spoken/typed list. Handles "x and y", and "none"/"no" -> []. */
export function parseList(text: string): string[] {
  const cleaned = text.trim().toLowerCase();
  if (!cleaned || /^(no|none|nope|nothing|n\/?a|no allergies|i have none|i don'?t have any)\b/.test(cleaned)) {
    return [];
  }
  return splitList(text.replace(/\band\b/gi, ','));
}

/** Strip common lead-ins so a spoken "my name is Avital." becomes "Avital". */
export function cleanName(text: string): string {
  return text
    .trim()
    .replace(/^(my name is|i'?m|i am|it'?s|call me|this is)\s+/i, '')
    .replace(/[.!,]+$/, '')
    .trim();
}

// ── Allergy spellcheck ──────────────────────────────────────────────────────
// Voice-first users dictate allergens, and the field mic / keyboard mishears
// them ("peanutts", "shellfsh", "glooten"). An allergen that doesn't match the
// menu text is a SAFETY failure, so we auto-correct obvious misspellings to a
// canonical name before saving. Local + offline: a curated list plus a small
// edit-distance match. No network call on a safety path.

const CANONICAL_ALLERGENS = [
  'peanuts', 'tree nuts', 'almonds', 'cashews', 'walnuts', 'pecans', 'pistachios',
  'hazelnuts', 'milk', 'dairy', 'lactose', 'eggs', 'wheat', 'gluten', 'soy',
  'fish', 'shellfish', 'shrimp', 'crab', 'lobster', 'sesame', 'mustard',
  'celery', 'sulfites', 'coconut', 'corn', 'garlic', 'onion', 'cinnamon',
];

// Common mishearings/variants that edit distance alone would miss or mis-route.
const ALLERGEN_ALIASES: Record<string, string> = {
  peanut: 'peanuts', groundnut: 'peanuts', groundnuts: 'peanuts',
  nut: 'tree nuts', nuts: 'tree nuts', treenut: 'tree nuts', treenuts: 'tree nuts',
  egg: 'eggs', shellfishes: 'shellfish', shrimps: 'shrimp', prawns: 'shrimp',
  glutin: 'gluten', glutten: 'gluten', wheats: 'wheat', soya: 'soy', soybean: 'soy',
  soybeans: 'soy', sezame: 'sesame', sesami: 'sesame', lactos: 'lactose',
  dairyproducts: 'dairy', seafood: 'shellfish', sulphites: 'sulfites',
};

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 2) return 99; // allergens are short; >2 apart is not a typo
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1]);
      prev = tmp;
    }
  }
  return dp[m];
}

/**
 * Correct one allergen token to its canonical spelling. Returns the input
 * unchanged (trimmed) if it is already canonical or no close match is found, so
 * we never silently change something the user clearly meant.
 */
export function correctAllergen(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  const key = t.toLowerCase().replace(/[^a-z\s]/g, '').trim();
  if (!key) return t;
  if (CANONICAL_ALLERGENS.includes(key)) return key;
  if (ALLERGEN_ALIASES[key.replace(/\s+/g, '')]) return ALLERGEN_ALIASES[key.replace(/\s+/g, '')];
  // Nearest canonical within a length-scaled edit budget.
  let best = t, bestDist = Infinity;
  for (const c of CANONICAL_ALLERGENS) {
    const d = editDistance(key, c);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  const budget = key.length <= 5 ? 1 : 2;
  return bestDist <= budget ? best : t;
}

/**
 * Normalize a whole allergen list: correct each token, drop blanks, de-dupe.
 * Returns the cleaned list plus the corrections made (for spoken confirmation).
 */
export function normalizeAllergens(items: string[]): { list: string[]; corrections: Array<[string, string]> } {
  const seen = new Set<string>();
  const list: string[] = [];
  const corrections: Array<[string, string]> = [];
  for (const item of items) {
    const fixed = correctAllergen(item);
    if (!fixed) continue;
    if (fixed.toLowerCase() !== item.trim().toLowerCase()) corrections.push([item.trim(), fixed]);
    const k = fixed.toLowerCase();
    if (!seen.has(k)) { seen.add(k); list.push(fixed); }
  }
  return { list, corrections };
}

/** Merge two string lists, case-insensitive de-dupe, keep most recent `cap`. */
export function mergeUnique(existing: string[], add: string[], cap = 30): string[] {
  const seen = new Set(existing.map((s) => s.toLowerCase()));
  const out = [...existing];
  for (const item of add) {
    const t = item.trim();
    if (!t) continue;
    if (!seen.has(t.toLowerCase())) {
      seen.add(t.toLowerCase());
      out.push(t);
    }
  }
  return out.slice(-cap);
}
