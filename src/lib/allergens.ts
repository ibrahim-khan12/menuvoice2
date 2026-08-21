// Allergen detection for menu items.
//
// Each dish carries ingredients (and a name/description). We map that text onto
// a small set of common allergen groups, then compare against the guest's
// profile allergies (already canonicalized by normalizeAllergens in util.ts).
//
// Two outcomes drive the menu UI:
//   - blocked: the dish may contain an allergen the guest listed, so flag it.
//   - otherwise: list any OTHER allergens present for optional disclosure.
//
// This is a SAFETY surface, so detection errs toward flagging: keyword matches
// are word-boundary based to avoid obvious false positives, but when in doubt we
// would rather warn than stay silent.

import type { MenuItem } from '../types';

interface AllergenGroup {
  key: string;
  label: string; // spoken/displayed name
  // Terms a guest might have in their profile that refer to this group.
  profileTerms: string[];
  // Ingredient / dish-text keywords that indicate this allergen is present.
  keywords: string[];
  // When true, only surface this group if the guest personally listed it: it
  // still drives the safety warning (blockedBy) for those who need it, but is
  // never added to the general "other allergens" disclosure. Used for very
  // common ingredients (garlic, onion) whose unsolicited disclosure to every
  // user would be noise rather than signal.
  personalOnly?: boolean;
}

const ALLERGEN_GROUPS: AllergenGroup[] = [
  {
    key: 'dairy',
    label: 'dairy',
    profileTerms: ['dairy', 'milk', 'lactose', 'cheese'],
    keywords: [
      'milk', 'cream', 'creamy', 'creme', 'crème', 'buttermilk', 'butter',
      'cheese', 'cheddar', 'parmesan', 'parmigiano', 'mozzarella', 'feta',
      'ricotta', 'provolone', 'gouda', 'brie', 'blue cheese', 'goat cheese',
      'gruyere', 'gruyère', 'mascarpone', 'burrata', 'queso', 'paneer',
      'yogurt', 'yoghurt', 'ghee', 'custard', 'gelato', 'ice cream', 'whey',
      'casein', 'curd', 'bechamel', 'béchamel', 'alfredo', 'sour cream',
      'half and half', 'condensed milk', 'clotted cream', 'panna',
    ],
  },
  {
    key: 'egg',
    label: 'egg',
    profileTerms: ['egg', 'eggs'],
    keywords: [
      'egg', 'eggs', 'mayonnaise', 'mayo', 'aioli', 'aïoli', 'meringue',
      'custard', 'hollandaise', 'frittata', 'omelet', 'omelette', 'quiche',
      'carbonara', 'egg wash', 'albumen', 'caesar dressing', 'tempura',
      'brioche',
    ],
  },
  {
    key: 'gluten',
    label: 'gluten (wheat)',
    profileTerms: ['gluten', 'wheat', 'celiac'],
    keywords: [
      'wheat', 'flour', 'bread', 'breaded', 'breadcrumb', 'breadcrumbs',
      'panko', 'bun', 'brioche', 'sourdough', 'baguette', 'ciabatta',
      'focaccia', 'pita', 'naan', 'tortilla', 'pasta', 'linguine',
      'spaghetti', 'penne', 'fettuccine', 'macaroni', 'rigatoni', 'orzo',
      'gnocchi', 'noodle', 'noodles', 'ramen', 'udon', 'dumpling', 'wonton',
      'ravioli', 'lasagna', 'crouton', 'croutons', 'barley', 'rye', 'farro',
      'bulgur', 'couscous', 'semolina', 'seitan', 'malt', 'beer', 'soy sauce',
      'teriyaki', 'pancake', 'waffle', 'batter', 'tempura', 'roux', 'cracker',
      'crackers', 'pretzel', 'biscuit', 'pastry', 'pie crust', 'phyllo',
      'puff pastry', 'toast', 'crostini', 'bruschetta',
    ],
  },
  {
    key: 'peanut',
    label: 'peanuts',
    profileTerms: ['peanut', 'peanuts', 'groundnut'],
    keywords: ['peanut', 'peanuts', 'groundnut', 'groundnuts', 'satay', 'peanut butter'],
  },
  {
    key: 'treenut',
    label: 'tree nuts',
    profileTerms: [
      'tree nuts', 'tree nut', 'almond', 'almonds', 'walnut', 'walnuts',
      'cashew', 'cashews', 'pecan', 'pecans', 'pistachio', 'pistachios',
      'hazelnut', 'hazelnuts',
    ],
    keywords: [
      'almond', 'almonds', 'walnut', 'walnuts', 'cashew', 'cashews', 'pecan',
      'pecans', 'pistachio', 'pistachios', 'hazelnut', 'hazelnuts',
      'macadamia', 'pine nut', 'pine nuts', 'praline', 'brazil nut',
      'chestnut', 'marzipan', 'nutella', 'pesto', 'frangipane', 'amaretto',
      'nougat',
    ],
  },
  {
    key: 'soy',
    label: 'soy',
    profileTerms: ['soy', 'soya', 'soybean'],
    keywords: [
      'soy', 'soya', 'soybean', 'soybeans', 'tofu', 'edamame', 'miso',
      'tempeh', 'tamari', 'soy sauce', 'teriyaki', 'hoisin',
    ],
  },
  {
    key: 'fish',
    label: 'fish',
    profileTerms: ['fish'],
    keywords: [
      'salmon', 'tuna', 'cod', 'anchovy', 'anchovies', 'halibut', 'trout',
      'sea bass', 'tilapia', 'sardine', 'sardines', 'mackerel', 'herring',
      'snapper', 'haddock', 'catfish', 'swordfish', 'mahi', 'branzino',
      'fish sauce', 'worcestershire', 'nam pla', 'caesar dressing',
    ],
  },
  {
    key: 'shellfish',
    label: 'shellfish',
    profileTerms: [
      'shellfish', 'seafood', 'shrimp', 'prawn', 'crab', 'lobster', 'clam',
      'mussel', 'scallop', 'oyster', 'squid', 'calamari', 'octopus',
    ],
    keywords: [
      'shrimp', 'prawn', 'prawns', 'crab', 'lobster', 'clam', 'clams',
      'mussel', 'mussels', 'scallop', 'scallops', 'oyster', 'oysters',
      'squid', 'calamari', 'octopus', 'crawfish', 'crayfish', 'langoustine',
      'shellfish',
    ],
  },
  {
    key: 'sesame',
    label: 'sesame',
    profileTerms: ['sesame', 'tahini'],
    keywords: ['sesame', 'tahini', 'hummus', 'halva', "za'atar", 'benne'],
  },
  {
    key: 'mustard',
    label: 'mustard',
    profileTerms: ['mustard'],
    keywords: ['mustard', 'dijon'],
  },
  {
    key: 'celery',
    label: 'celery',
    profileTerms: ['celery', 'celeriac'],
    keywords: ['celery', 'celeriac'],
  },
  {
    key: 'sulfites',
    label: 'sulfites',
    profileTerms: ['sulfite', 'sulfites', 'sulphite', 'sulphites'],
    keywords: ['wine', 'sulfite', 'sulfites', 'sulphite', 'balsamic'],
  },
  {
    key: 'coconut',
    label: 'coconut',
    profileTerms: ['coconut'],
    keywords: ['coconut'],
  },
  {
    key: 'corn',
    label: 'corn',
    profileTerms: ['corn', 'maize'],
    personalOnly: true,
    keywords: [
      'corn', 'maize', 'cornmeal', 'corn meal', 'cornstarch', 'corn starch',
      'cornflour', 'corn flour', 'corn syrup', 'polenta', 'grits', 'hominy',
      'masa', 'popcorn', 'cornbread', 'corn tortilla', 'tortilla chips',
      'nachos', 'elote', 'succotash',
    ],
  },
  {
    key: 'garlic',
    label: 'garlic',
    profileTerms: ['garlic'],
    personalOnly: true,
    keywords: [
      'garlic', 'garlicky', 'aioli', 'aïoli', 'aglio', 'toum', 'garlic bread',
      'garlic butter', 'roasted garlic',
    ],
  },
  {
    key: 'onion',
    label: 'onion',
    // Onion-allergic guests commonly react to the wider allium family, so the
    // keywords include shallot, leek, scallion, and chive; err toward warning.
    profileTerms: ['onion', 'onions', 'allium'],
    personalOnly: true,
    keywords: [
      'onion', 'onions', 'scallion', 'scallions', 'shallot', 'shallots',
      'leek', 'leeks', 'chive', 'chives', 'spring onion', 'green onion',
      'red onion', 'caramelized onion', 'caramelised onion', 'onion powder',
    ],
  },
  {
    key: 'cinnamon',
    label: 'cinnamon',
    profileTerms: ['cinnamon', 'cassia'],
    personalOnly: true,
    keywords: [
      'cinnamon', 'cassia', 'snickerdoodle', 'churro', 'churros',
      'horchata', 'pumpkin spice', 'speculoos', 'cinnamon roll', 'chai',
    ],
  },
  {
    key: 'beef',
    label: 'beef',
    profileTerms: ['beef', 'steak', 'steaks', 'veal', 'cow'],
    personalOnly: true,
    keywords: [
      'beef', 'steak', 'steaks', 'sirloin', 'ribeye', 'rib eye', 'filet mignon',
      'tenderloin', 'porterhouse', 't bone', 'new york strip', 'strip steak',
      'brisket', 'short rib', 'short ribs', 'prime rib', 'veal', 'burger',
      'burgers', 'hamburger', 'meatball', 'meatballs', 'beef broth', 'beef stock',
    ],
  },
  {
    key: 'pork',
    label: 'pork',
    profileTerms: ['pork', 'bacon', 'ham', 'prosciutto', 'sausage'],
    personalOnly: true,
    keywords: [
      'pork', 'bacon', 'ham', 'prosciutto', 'pancetta', 'salami', 'pepperoni',
      'chorizo', 'sausage', 'pulled pork', 'pork belly', 'lard', 'pork broth',
    ],
  },
  {
    key: 'lamb',
    label: 'lamb',
    profileTerms: ['lamb', 'mutton'],
    personalOnly: true,
    keywords: ['lamb', 'mutton', 'lamb chop', 'lamb shank', 'lamb broth'],
  },
  {
    key: 'poultry',
    label: 'poultry',
    profileTerms: ['poultry', 'chicken', 'turkey', 'duck', 'goose'],
    personalOnly: true,
    keywords: [
      'poultry', 'chicken', 'turkey', 'duck', 'goose', 'hen', 'wings',
      'chicken broth', 'chicken stock', 'turkey bacon',
    ],
  },
  {
    key: 'vegetarian',
    label: 'vegetarian restriction',
    profileTerms: ['vegetarian', 'vegetarian diet', 'no meat'],
    personalOnly: true,
    keywords: [
      // Vegetarian dishes can still contain dairy or eggs, so only animal flesh
      // and animal-derived ingredients that are clearly incompatible are used.
      'beef', 'steak', 'sirloin', 'ribeye', 'filet mignon', 'brisket', 'short rib',
      'veal', 'burger', 'hamburger', 'meatball', 'pork', 'bacon', 'ham',
      'prosciutto', 'pancetta', 'salami', 'pepperoni', 'chorizo', 'sausage', 'lard',
      'lamb', 'mutton', 'chicken', 'turkey', 'duck', 'goose', 'fish', 'salmon',
      'tuna', 'cod', 'anchovy', 'shrimp', 'prawn', 'crab', 'lobster', 'clam',
      'mussel', 'scallop', 'oyster', 'squid', 'calamari', 'gelatin',
    ],
  },
  {
    key: 'vegan',
    label: 'vegan restriction',
    profileTerms: ['vegan', 'vegan diet', 'plant based', 'plant-based'],
    personalOnly: true,
    keywords: [
      // Vegan includes the clearly non-vegetarian terms plus common animal
      // ingredients. This is a warning, not a certification of suitability.
      'beef', 'steak', 'sirloin', 'ribeye', 'filet mignon', 'brisket', 'short rib',
      'veal', 'burger', 'hamburger', 'meatball', 'pork', 'bacon', 'ham',
      'prosciutto', 'pancetta', 'salami', 'pepperoni', 'chorizo', 'sausage', 'lard',
      'lamb', 'mutton', 'chicken', 'turkey', 'duck', 'goose', 'fish', 'salmon',
      'tuna', 'cod', 'anchovy', 'shrimp', 'prawn', 'crab', 'lobster', 'clam',
      'mussel', 'scallop', 'oyster', 'squid', 'calamari', 'gelatin', 'milk',
      'cream', 'creamy', 'butter', 'cheese', 'yogurt', 'ghee', 'whey', 'casein', 'egg',
      'eggs', 'mayonnaise', 'mayo', 'aioli', 'honey', 'beeswax',
    ],
  },
];

function hasWord(haystack: string, needle: string): boolean {
  // Word-boundary match so "cream" hits "ice cream" but "egg" doesn't hit
  // "eggplant". Escape spaces/letters only — keywords are plain words.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
}

// Build the searchable text for a dish from its name, description, ingredients.
function itemText(item: MenuItem): string {
  return [item.name, item.description ?? '', ...(item.ingredients ?? [])]
    .join(' ')
    .toLowerCase();
}

// How sure we are an allergen is present:
//   explicit  - the dish text actually DECLARES allergens ("contains milk",
//               "allergens: soy, wheat", "made with peanuts"). The restaurant
//               (or the menu) said so.
//   inferred  - we recognised an ingredient from the dish name/description, but
//               nobody confirmed it. Most matches are this. NEVER present as fact.
export type AllergenConfidence = 'explicit' | 'inferred';

export interface AllergenFinding {
  label: string;
  confidence: AllergenConfidence;
}

// Cues that a piece of dish text is an explicit allergen/ingredient declaration
// rather than just a dish name. Conservative on purpose: if these are absent we
// fall back to "inferred", because over-claiming "confirmed" is the unsafe error.
const DECLARATION_CUES = /\b(contains?|allergens?|made with|prepared with|may contain|ingredients?)\b/i;

// Is allergen group `g` an EXPLICIT declaration in this dish text? We require a
// declaration cue AND the keyword to appear, so a plain "Shrimp scampi" stays
// inferred while "Contains shellfish" is explicit.
function isExplicit(text: string, g: AllergenGroup): boolean {
  if (!DECLARATION_CUES.test(text)) return false;
  return g.keywords.some((kw) => hasWord(text, kw));
}

// Which allergen groups are present in this dish, each with a confidence.
function detectGroups(item: MenuItem): Array<{ group: AllergenGroup; confidence: AllergenConfidence }> {
  const text = itemText(item);
  const explicitText =
    DECLARATION_CUES.test(text) ? text : ''; // only check declarations against declaring text
  return ALLERGEN_GROUPS.filter((g) => g.keywords.some((kw) => hasWord(text, kw))).map((g) => ({
    group: g,
    confidence: explicitText && isExplicit(explicitText, g) ? 'explicit' : 'inferred',
  }));
}

// Does the guest's profile list an allergy that refers to this group?
function groupInProfile(group: AllergenGroup, profileAllergies: string[]): boolean {
  const allergies = profileAllergies.map((a) => a.trim().toLowerCase()).filter(Boolean);
  return allergies.some((a) =>
    group.profileTerms.some(
      (term) => a === term || (term.length > 3 && a.includes(term)) || (a.length > 3 && term.includes(a)),
    ),
  );
}

// Guests can need the app to watch for a food that is not in our curated map.
// Preserve that exact, user-approved term and compare it as a whole phrase.
// We deliberately do not guess related foods for these custom entries: an exact
// alert is useful, while a made-up relationship could be dangerous.
function customProfileFindings(item: MenuItem, profileAllergies: string[]): AllergenFinding[] {
  const text = itemText(item);
  const customTerms = profileAllergies
    .map((allergy) => allergy.trim().toLowerCase())
    .filter((allergy) => allergy.length >= 2)
    .filter((allergy) => !ALLERGEN_GROUPS.some((group) => groupInProfile(group, [allergy])));
  return [...new Set(customTerms)]
    .filter((term) => hasWord(text, term))
    .map((label) => ({ label, confidence: 'inferred' as const }));
}

export interface ItemAllergenInfo {
  // True when the dish may contain an allergen the guest listed and needs an alert.
  blocked: boolean;
  // The guest's own allergens found in the dish, with confidence (for copy).
  blockedBy: AllergenFinding[];
  // OTHER allergens present (not in the guest's profile), with confidence.
  otherAllergens: AllergenFinding[];
}

/**
 * Analyze one dish against the guest's profile allergies.
 * Dishes remain visible. Callers use blocked/blockedBy to add a prominent alert
 * for allergens the guest listed, while preserving the confidence of each match.
 * Each finding carries whether the allergen was explicitly declared by the menu
 * or merely inferred from the dish name/description, so callers never present an
 * inference as confirmed.
 */
export function analyzeItemAllergens(item: MenuItem, profileAllergies: string[]): ItemAllergenInfo {
  const present = detectGroups(item);
  const blockedBy: AllergenFinding[] = [];
  const otherAllergens: AllergenFinding[] = [];
  for (const { group, confidence } of present) {
    const finding: AllergenFinding = { label: group.label, confidence };
    if (groupInProfile(group, profileAllergies)) blockedBy.push(finding);
    else if (!group.personalOnly) otherAllergens.push(finding);
  }
  // An unrecognized but user-approved entry (for example, "paper") is still
  // watched exactly as entered. It cannot appear in otherAllergens because it
  // only has meaning for the guest who listed it.
  blockedBy.push(...customProfileFindings(item, profileAllergies));
  return { blocked: blockedBy.length > 0, blockedBy, otherAllergens };
}

/**
 * A prominent ALERT for allergens the guest personally listed. Unlike the
 * general disclaimer, this always fires (even for inferred matches) because it
 * concerns the guest's own safety, but it stays honest about confidence.
 */
export function allergenAlertText(findings: AllergenFinding[]): string {
  if (findings.length === 0) return '';
  const labels = findings.map((f) => f.label);
  const list =
    labels.length === 1
      ? labels[0]
      : labels.slice(0, -1).join(', ') + ' and ' + labels[labels.length - 1];
  const verb = labels.length === 1 ? 'is one of your allergens' : 'are among your allergens';
  const allExplicit = findings.every((f) => f.confidence === 'explicit');
  if (allExplicit) {
    return `Allergen warning. The restaurant lists ${list}, which ${verb}. Please confirm with the restaurant.`;
  }
  return `Allergen warning. This dish may contain ${list}, which ${verb}, based on the description. The restaurant does not confirm it. Please confirm with the restaurant.`;
}

/** Spoken/printed allergen disclaimer honoring confidence. Empty when none. */
export function allergenDisclaimer(findings: AllergenFinding[]): string {
  if (findings.length === 0) return '';
  const explicit = findings.filter((f) => f.confidence === 'explicit').map((f) => f.label);
  const inferred = findings.filter((f) => f.confidence === 'inferred').map((f) => f.label);
  const parts: string[] = [];
  if (explicit.length) parts.push(`The restaurant lists ${explicit.join(', ')}.`);
  if (inferred.length)
    parts.push(
      `This dish may contain ${inferred.join(', ')} based on the description, but the restaurant does not confirm it.`,
    );
  parts.push('Please confirm with the restaurant.');
  return parts.join(' ');
}

/**
 * One dish's accessible spoken label. Keep the dish name first so users know
 * which item the warning belongs to, then announce the warning before price,
 * description, or ingredients.
 */
export function dishSpokenLabel(item: MenuItem, personalAllergens: AllergenFinding[] = []): string {
  const segments = [item.name];
  if (personalAllergens.length > 0) segments.push(allergenAlertText(personalAllergens));
  if (item.price) segments.push(`Price ${item.price}`);
  if (item.description) segments.push(item.description);
  if (item.ingredients && item.ingredients.length > 0) {
    segments.push(`Ingredients: ${item.ingredients.join(', ')}`);
  }
  return segments.map((segment) => segment.trim().replace(/\.+$/, '')).join('. ');
}
