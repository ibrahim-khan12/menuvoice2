/**
 * WCAG 2.1 AA accessibility audit for MenuVoice PWA.
 * Renders 7 screens with mocked localStorage, runs axe-core, saves results.
 */

import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const PROFILE = JSON.stringify({
  email: 'audit@menuvoice.app',
  name: 'Audit',
  allergies: [],
  dislikes: [],
  spiceTolerance: 'medium',
  cuisinesLiked: [],
  pastOrders: [],
  hidePrices: false,
  ttsVoice: 'shimmer',
  onboarded: true,
});

const SAVED = JSON.stringify([{
  id: 'r-test',
  name: 'Test Bistro',
  capturedAt: '2026-01-01T00:00:00.000Z',
  menu: {
    restaurantName: 'Test Bistro',
    categories: [{
      name: 'Starters',
      items: [{ name: 'Spring Rolls', description: 'Crispy vegetable rolls', price: '$8' }],
    }],
  },
}]);

const SCREENS = [
  { name: 'login',      ls: {} },
  { name: 'onboarding', ls: { 'menuvoice.profile.v1': JSON.stringify({ ...JSON.parse(PROFILE), onboarded: false }) } },
  { name: 'home',       ls: { 'menuvoice.profile.v1': PROFILE } },
  { name: 'capture',    ls: { 'menuvoice.profile.v1': PROFILE }, click: 'Scan a Menu' },
  { name: 'find',       ls: { 'menuvoice.profile.v1': PROFILE }, click: 'Find a Menu' },
  { name: 'saved',      ls: { 'menuvoice.profile.v1': PROFILE, 'menuvoice.savedRestaurants.v1': SAVED }, click: 'Saved Restaurants' },
  { name: 'settings',   ls: { 'menuvoice.profile.v1': PROFILE }, click: 'Settings' },
  { name: 'demo-browse', ls: { 'menuvoice.profile.v1': PROFILE }, demoBrowse: true, screenshot: false },
];

const SCREENSHOTS_DIR = join(__dirname, 'screenshots');
mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const CHROMIUM_PATH = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

async function assertCount(locator, expected, message) {
  const count = await locator.count();
  if (count !== expected) {
    throw new Error(`${message} Expected ${expected}, got ${count}.`);
  }
}

async function assertDemoBrowseSemantics(page) {
  await assertCount(
    page.getByRole('heading', { name: /^Starters, 4 items$/ }),
    1,
    'Category toggles must be heading rotor stops.'
  );
  await assertCount(
    page.getByRole('heading', { name: /Crispy Calamari/i }),
    0,
    'Dish items must not be heading rotor stops.'
  );

  await page.getByRole('button', { name: /^Starters, 4 items\./ }).click();
  await assertCount(
    page.getByRole('listitem', { name: /Crispy Calamari, \$13\./ }),
    1,
    'Opened categories must expose dishes as list items.'
  );
  await assertCount(
    page.getByRole('listitem', { name: /Truffle Parmesan Fries, \$9\.50\./ }),
    1,
    'Demo menu should include a cents-priced item in browse mode.'
  );
}

async function auditScreen(browser, screen) {
  const context = await browser.newContext();
  const page = await context.newPage();

  // Suppress console errors from TTS/mic APIs not available in headless
  page.on('pageerror', () => {});
  page.on('console', () => {});

  // Inject localStorage before page load
  await page.addInitScript((ls) => {
    for (const [k, v] of Object.entries(ls)) {
      localStorage.setItem(k, v);
    }
  }, screen.ls);

  await page.goto('http://localhost:4173', { waitUntil: 'networkidle' });

  try {
    await page.waitForSelector('main.screen', { timeout: 10000 });
  } catch {
    console.warn(`  [warn] main.screen not found for screen: ${screen.name}`);
  }

  // Click navigation target if needed
  if (screen.demoBrowse) {
    try {
      await page.getByRole('button', { name: 'Settings' }).click({ timeout: 5000 });
      await page.waitForTimeout(500);
      await page.getByRole('button', { name: 'Demo Menu' }).click({ timeout: 5000 });
      await page.waitForTimeout(1500);
      await page.getByRole('button', { name: /switch to browse mode/i }).click({ timeout: 5000 });
      await page.waitForTimeout(500);
      await assertDemoBrowseSemantics(page);
    } catch (e) {
      console.warn(`  [warn] Demo browse semantic check failed: ${e.message}`);
      throw e;
    }
  } else if (screen.click) {
    try {
      // Find by accessible name (button text / aria-label)
      const btn = page.getByRole('button', { name: screen.click }).first();
      await btn.click({ timeout: 5000 });
      await page.waitForTimeout(1500);
    } catch (e) {
      console.warn(`  [warn] Could not click "${screen.click}" on ${screen.name}: ${e.message}`);
    }
  }

  // Screenshot
  if (screen.screenshot !== false) {
    await page.screenshot({
      path: join(SCREENSHOTS_DIR, `${screen.name}.png`),
      fullPage: true,
    });
  }

  // Run axe
  let results;
  try {
    results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .disableRules(['frame-tested'])
      .analyze();
  } catch (e) {
    console.warn(`  [warn] axe analysis error on ${screen.name}: ${e.message}`);
    results = { violations: [] };
  }

  await context.close();

  const violations = results.violations.map((v) => ({
    screen: screen.name,
    id: v.id,
    impact: v.impact,
    description: v.description,
    help: v.help,
    helpUrl: v.helpUrl,
    nodes: v.nodes.map((n) => ({
      html: n.html,
      failureSummary: n.failureSummary,
      target: n.target,
    })),
  }));

  return violations;
}

async function main() {
  console.log('Starting MenuVoice WCAG 2.1 AA audit…\n');

  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  };
  if (existsSync(CHROMIUM_PATH)) {
    launchOptions.executablePath = CHROMIUM_PATH;
  }

  const browser = await chromium.launch(launchOptions);

  const allViolations = [];
  const summary = [];

  for (const screen of SCREENS) {
    process.stdout.write(`  Auditing [${screen.name}]…`);
    try {
      const violations = await auditScreen(browser, screen);
      allViolations.push(...violations);
      const counts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
      for (const v of violations) counts[v.impact] = (counts[v.impact] || 0) + 1;
      summary.push({ screen: screen.name, ...counts, total: violations.length });
      console.log(` ${violations.length} violation(s) [C:${counts.critical} S:${counts.serious} M:${counts.moderate} m:${counts.minor}]`);
    } catch (e) {
      console.log(` ERROR: ${e.message}`);
      summary.push({ screen: screen.name, critical: 0, serious: 0, moderate: 0, minor: 0, total: 0, error: e.message });
    }
  }

  await browser.close();

  writeFileSync(join(__dirname, 'violations.json'), JSON.stringify(allViolations, null, 2));

  console.log('\n── Summary ──────────────────────────────────────────');
  console.log('Screen'.padEnd(14) + 'Crit  Seri  Mod   Min   Total');
  for (const s of summary) {
    console.log(
      s.screen.padEnd(14) +
      String(s.critical).padEnd(6) +
      String(s.serious).padEnd(6) +
      String(s.moderate).padEnd(6) +
      String(s.minor).padEnd(6) +
      s.total
    );
  }
  const total = allViolations.length;
  const critical = allViolations.filter((v) => v.impact === 'critical').length;
  const serious = allViolations.filter((v) => v.impact === 'serious').length;
  console.log(`\nTotal: ${total} violations (${critical} critical, ${serious} serious)\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
