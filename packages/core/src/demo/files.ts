import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DemoFile } from './seed.js';
import { brandGuide, budget } from './content.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** The demo's PDF and XLSX as `pnpm seed:fixtures` wrote them: no browser or exceljs needed. */
export function readDemoFiles(): DemoFile[] {
  return [
    { name: brandGuide.name, mimeType: 'application/pdf', buffer: readFileSync(join(dir, brandGuide.name)) },
    {
      name: budget.name,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: readFileSync(join(dir, budget.name)),
    },
  ];
}
