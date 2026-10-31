// pnpm seed:fixtures: writes the demo's two files (a PDF and an XLSX) into packages/core/src/demo/fixtures, so the api
// can upload them when it seeds a workspace (Settings -> Spaces), where there is no browser to print the PDF. Run it
// again, and commit the result, whenever brandGuide or budget in content.ts changes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { makeDemoFiles } from './files';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'core', 'src', 'demo', 'fixtures');
mkdirSync(dir, { recursive: true });
const browser = await chromium.launch();
const files = await makeDemoFiles(browser);
await browser.close();
for (const file of files) {
  writeFileSync(join(dir, file.name), file.buffer);
  console.log(`seed:fixtures: ${file.name} (${file.buffer.length} bytes)`);
}
