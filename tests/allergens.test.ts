// Allergen detection + explicit/inferred confidence (pure functions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeItemAllergens,
  allergenAlertText,
  allergenDisclaimer,
  dishSpokenLabel,
} from '../src/lib/allergens.ts';
import type { MenuItem } from '../src/types.ts';

test('blocks a dish containing a profile allergen', () => {
  const item: MenuItem = { name: 'Shrimp scampi', description: 'with garlic butter' };
  const info = analyzeItemAllergens(item, ['shellfish']);
  assert.equal(info.blocked, true);
  assert.ok(info.blockedBy.some((f) => f.label === 'shellfish'));
});

test('does not block when allergen absent; lists other allergens as inferred', () => {
  const item: MenuItem = { name: 'Margherita pizza', description: 'mozzarella, basil' };
  const info = analyzeItemAllergens(item, ['peanuts']);
  assert.equal(info.blocked, false);
  const dairy = info.otherAllergens.find((f) => f.label === 'dairy');
  assert.ok(dairy, 'dairy detected from mozzarella');
  assert.equal(dairy!.confidence, 'inferred');
});

test('explicit declaration is marked explicit', () => {
  const item: MenuItem = { name: 'House salad', description: 'Contains peanuts and blue cheese' };
  const info = analyzeItemAllergens(item, []);
  const peanut = info.otherAllergens.find((f) => f.label === 'peanuts');
  assert.ok(peanut);
  assert.equal(peanut!.confidence, 'explicit');
});

test('allergenDisclaimer never presents inferred as confirmed', () => {
  const d = allergenDisclaimer([{ label: 'dairy', confidence: 'inferred' }]);
  assert.match(d, /may contain dairy/);
  assert.match(d, /does not confirm/);
  assert.ok(!/The restaurant lists/.test(d));
});

test('allergenDisclaimer reports explicit declarations as listed', () => {
  const d = allergenDisclaimer([{ label: 'soy', confidence: 'explicit' }]);
  assert.match(d, /The restaurant lists soy/);
});

test('personal allergen alert keeps inferred matches uncertain', () => {
  const alert = allergenAlertText([{ label: 'shellfish', confidence: 'inferred' }]);
  assert.match(alert, /may contain shellfish/);
  assert.match(alert, /does not confirm it/);
  assert.ok(!/restaurant lists shellfish/.test(alert));
});

test('personal allergen alert identifies explicit restaurant listings', () => {
  const alert = allergenAlertText([{ label: 'soy', confidence: 'explicit' }]);
  assert.match(alert, /restaurant lists soy/);
  assert.match(alert, /confirm with the restaurant/);
});

test('empty findings produce empty disclaimer', () => {
  assert.equal(allergenDisclaimer([]), '');
  assert.equal(allergenAlertText([]), '');
});

test('dishSpokenLabel puts the dish name first and the warning before other details', () => {
  const item: MenuItem = {
    name: 'Caesar Salad',
    price: '$12',
    description: 'romaine, parmesan, croutons',
  };
  const label = dishSpokenLabel(item, [{ label: 'dairy', confidence: 'inferred' }]);

  assert.ok(label.startsWith('Caesar Salad. Allergen warning.'), label);
  assert.ok(label.indexOf('Allergen warning') < label.indexOf('Price $12'));
  assert.ok(label.indexOf('Allergen warning') < label.indexOf('romaine, parmesan, croutons'));
});

test('dishSpokenLabel keeps the normal compact order when there is no warning', () => {
  const item: MenuItem = { name: 'House Fries', price: '$6' };
  assert.equal(dishSpokenLabel(item), 'House Fries. Price $6');
});

test('dishSpokenLabel includes ingredients after the warning', () => {
  const item: MenuItem = { name: 'Pad Thai', ingredients: ['peanuts', 'rice noodles', 'egg'] };
  const label = dishSpokenLabel(item, [{ label: 'peanuts', confidence: 'explicit' }]);

  assert.ok(label.startsWith('Pad Thai. Allergen warning.'), label);
  assert.ok(label.indexOf('Allergen warning') < label.indexOf('Ingredients:'));
});

// ── Bug #2a: detection groups for corn, garlic, onion, cinnamon ──
// The profile accepts these canonical allergens (util.ts CANONICAL_ALLERGENS),
// so each must have a detection path. Positive, negative, and ambiguous cases.

test('garlic profile allergy blocks a garlic dish with a warning', () => {
  const item: MenuItem = { name: 'Garlic butter shrimp', price: '$14' };
  const info = analyzeItemAllergens(item, ['garlic']);
  assert.equal(info.blocked, true);
  assert.ok(info.blockedBy.some((f) => f.label === 'garlic'));
  // Warning must precede price in the spoken label.
  const label = dishSpokenLabel(item, info.blockedBy);
  assert.ok(label.indexOf('Allergen warning') < label.indexOf('Price $14'), label);
});

test('garlic allium term (aioli) is detected for a garlic-allergic guest', () => {
  const item: MenuItem = { name: 'Fries', description: 'served with aioli' };
  const info = analyzeItemAllergens(item, ['garlic']);
  assert.equal(info.blocked, true);
});

test('onion allergy also catches the wider allium family (shallot, scallion)', () => {
  const shallot = analyzeItemAllergens({ name: 'Salad', description: 'shallot vinaigrette' }, ['onion']);
  assert.equal(shallot.blocked, true);
  const scallion = analyzeItemAllergens({ name: 'Ramen', ingredients: ['scallions'] }, ['onion']);
  assert.equal(scallion.blocked, true);
});

test('corn allergy blocks polenta and popcorn but not corned beef', () => {
  assert.equal(analyzeItemAllergens({ name: 'Creamy polenta' }, ['corn']).blocked, true);
  assert.equal(analyzeItemAllergens({ name: 'Popcorn shrimp' }, ['corn']).blocked, true);
  // "corned beef" contains no corn — word boundaries must not false-match.
  assert.equal(analyzeItemAllergens({ name: 'Corned beef hash' }, ['corn']).blocked, false);
});

test('cinnamon allergy blocks churros and chai', () => {
  assert.equal(analyzeItemAllergens({ name: 'Cinnamon churros' }, ['cinnamon']).blocked, true);
  assert.equal(analyzeItemAllergens({ name: 'Chai latte' }, ['cinnamon']).blocked, true);
});

test('negative: a plain dish does not block for these allergies', () => {
  const item: MenuItem = { name: 'Grilled salmon', description: 'with lemon' };
  for (const allergy of ['garlic', 'onion', 'corn', 'cinnamon']) {
    assert.equal(analyzeItemAllergens(item, [allergy]).blocked, false, `${allergy} should not match`);
  }
});

test('personal-only groups do not pollute other-allergen disclosure', () => {
  // A garlic-heavy dish, but the guest is only allergic to peanuts: garlic and
  // onion must NOT appear in otherAllergens (they are personal-only).
  const item: MenuItem = { name: 'Garlic and onion flatbread', description: 'caramelized onion, roasted garlic' };
  const info = analyzeItemAllergens(item, ['peanuts']);
  assert.ok(!info.otherAllergens.some((f) => f.label === 'garlic'));
  assert.ok(!info.otherAllergens.some((f) => f.label === 'onion'));
});

test('explicit declaration still applies to the new groups', () => {
  const item: MenuItem = { name: 'Spice blend', description: 'Contains cinnamon' };
  const info = analyzeItemAllergens(item, ['cinnamon']);
  assert.ok(info.blockedBy.some((f) => f.label === 'cinnamon' && f.confidence === 'explicit'));
});

test('steak allergy is normalized to beef coverage and blocks steak or beef dishes', () => {
  const steak = analyzeItemAllergens({ name: 'Steak and eggs' }, ['steak']);
  assert.equal(steak.blocked, true);
  assert.ok(steak.blockedBy.some((finding) => finding.label === 'beef'));
  assert.equal(analyzeItemAllergens({ name: 'Braised beef short ribs' }, ['steak']).blocked, true);
});

test('vegetarian and vegan restrictions flag plainly incompatible dishes', () => {
  assert.equal(analyzeItemAllergens({ name: 'Chicken parmesan' }, ['vegetarian']).blocked, true);
  assert.equal(analyzeItemAllergens({ name: 'Bacon and eggs' }, ['vegan']).blocked, true);
  assert.equal(analyzeItemAllergens({ name: 'Creamy mushroom pasta' }, ['vegan']).blocked, true);
  assert.equal(analyzeItemAllergens({ name: 'Garden salad' }, ['vegetarian']).blocked, false);
});

test('a user-approved custom term is watched as an exact phrase without guessed relatives', () => {
  assert.equal(analyzeItemAllergens({ name: 'Rice paper rolls' }, ['paper']).blocked, true);
  assert.equal(analyzeItemAllergens({ name: 'Paperdelle pasta' }, ['paper']).blocked, false);
  assert.equal(analyzeItemAllergens({ name: 'Steak and eggs' }, ['paper']).blocked, false);
});
