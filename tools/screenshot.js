// Screenshot harness for the visual iteration loop.
//
// The loop is worthless unless the images are actually looked at, so this exists
// to make looking cheap: one command, all three views at all three widths, plus
// whatever the browser console said. A page that renders nothing and logs
// nothing still counts as a failure, and the console capture is what makes that
// distinguishable from a page that is merely empty because there is no data yet.
//
// Playwright is installed with --no-save. It is a tool for inspecting the build,
// not a dependency of it, and it must never appear in package.json.

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const WIDTHS = [
  { name: '1440', width: 1440, height: 1000 },
  { name: '1024', width: 1024, height: 900 },
  { name: '390', width: 390, height: 844 },
];

const VIEWS = ['aggregate', 'station', 'training'];

export async function shoot({ outDir, baseUrl = 'http://localhost:8080', settleMs = 45_000 }) {
  await fs.mkdir(outDir, { recursive: true });
  // Pinned rather than left to Playwright's own resolution: the bundled browser
  // is provisioned at a versioned path here, and letting the library go looking
  // makes it try to download one instead.
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  });
  const messages = [];
  const shots = [];

  try {
    for (const size of WIDTHS) {
      const context = await browser.newContext({
        viewport: { width: size.width, height: size.height },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();

      page.on('console', (m) => messages.push(`[${size.name}] ${m.type()}: ${m.text()}`));
      page.on('pageerror', (e) => messages.push(`[${size.name}] pageerror: ${e.message}`));
      page.on('requestfailed', (r) =>
        messages.push(`[${size.name}] requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`));

      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((e) => {
        messages.push(`[${size.name}] goto failed: ${e.message}`);
      });
      // The replay and the first data load both settle asynchronously, and a
      // screenshot taken before they do shows a loading state rather than the
      // thing being judged.
      await page.waitForTimeout(settleMs);

      for (const view of VIEWS) {
        const tab = page.locator(`.views button[data-view="${view}"]`);
        if (await tab.count()) {
          await tab.click().catch(() => {});
          await page.waitForTimeout(900);
        }
        const file = path.join(outDir, `${view}-${size.name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        shots.push(file);
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }

  await fs.writeFile(path.join(outDir, 'console.txt'), messages.join('\n') + '\n');
  return { shots, messages };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pass = process.argv[2] ?? '1';
  const outDir = path.join(ROOT, 'screenshots', `loop-d-pass-${pass}`);
  const { shots, messages } = await shoot({ outDir });
  console.log(`${shots.length} screenshots -> ${path.relative(ROOT, outDir)}`);
  for (const s of shots) console.log('  ' + path.basename(s));

  const errors = messages.filter((m) => /error|pageerror|requestfailed/i.test(m));
  console.log(`\n${messages.length} console messages, ${errors.length} errors`);
  for (const e of errors.slice(0, 40)) console.log('  ' + e);
}
