/**
 * Orchestrator: audit → fix → rebuild → repeat until zero critical/serious violations.
 */

import { execSync, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const MAX_CYCLES = 8;

function killPreview() {
  try { execSync('pkill -f "vite preview" 2>/dev/null || true', { cwd: ROOT }); } catch {}
  try { execSync('fuser -k 4173/tcp 2>/dev/null || true', { cwd: ROOT }); } catch {}
}

function startPreview() {
  killPreview();
  const proc = spawn('npx', ['vite', 'preview', '--port', '4173'], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();
  // Wait for server to be ready
  execSync('sleep 5', { cwd: ROOT });
  console.log('  Preview server started on http://localhost:4173');
}

console.log('\nMenuVoice WCAG 2.1 AA Audit Loop');
console.log('='.repeat(50));

startPreview();

let lastCritical = Infinity;

for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`CYCLE ${cycle}/${MAX_CYCLES}`);
  console.log('='.repeat(50));

  // Run audit
  try {
    execSync('node scripts/a11y/audit.mjs', { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    console.error(`Audit failed: ${e.message}`);
    break;
  }

  // Read results
  let violations = [];
  try {
    violations = JSON.parse(readFileSync(join(__dirname, 'violations.json'), 'utf8'));
  } catch (e) {
    console.error(`Could not read violations.json: ${e.message}`);
    break;
  }

  const critical = violations.filter((v) => v.impact === 'critical').length;
  const serious = violations.filter((v) => v.impact === 'serious').length;
  const criticalOrSerious = critical + serious;

  console.log(`\n  Critical: ${critical} | Serious: ${serious} | Total: ${violations.length}`);

  if (criticalOrSerious === 0) {
    console.log('\n✓ Zero critical/serious violations — generating final report…');
    execSync('node scripts/a11y/report.mjs', { cwd: ROOT, stdio: 'inherit' });
    console.log('\n✓ Audit loop complete. All WCAG 2.1 AA checks pass.\n');
    break;
  }

  if (cycle === MAX_CYCLES) {
    console.log(`\nMax cycles (${MAX_CYCLES}) reached — generating report with remaining issues…`);
    execSync('node scripts/a11y/report.mjs', { cwd: ROOT, stdio: 'inherit' });
    break;
  }

  // No improvement in last cycle — stop trying the same fixes
  if (criticalOrSerious >= lastCritical) {
    console.log(`  No improvement from last cycle (${lastCritical} → ${criticalOrSerious}) — generating report`);
    execSync('node scripts/a11y/report.mjs', { cwd: ROOT, stdio: 'inherit' });
    break;
  }
  lastCritical = criticalOrSerious;

  // Apply fixes
  console.log(`\n  Applying fixes (cycle ${cycle})…`);
  try {
    execSync('node scripts/a11y/fix.mjs', { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    console.error(`Fix script failed: ${e.message}`);
  }

  // Rebuild
  console.log(`  Rebuilding…`);
  try {
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    console.error(`Build failed: ${e.message}`);
    break;
  }

  startPreview();
}

killPreview();
console.log('\nDone.\n');
