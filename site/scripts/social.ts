// Renders the 1280×640 social preview (GitHub and Open Graph) from social.html: tsx site/scripts/social.ts
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 640 } });
await page.goto(pathToFileURL(join(here, 'social.html')).href);
await page.waitForLoadState('networkidle');
await page.screenshot({ path: join(here, '..', 'public', 'social.png') });
await browser.close();
