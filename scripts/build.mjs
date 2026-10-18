import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Resolve the toolchain from the project's own node_modules so the build works
// on any OS. (Do not hardcode Linux system paths like /usr/share/nodejs.)
const babel = require('@babel/core');
const presetTypescript = require('@babel/preset-typescript');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DIST = path.join(ROOT, 'dist');

function walkTsFiles(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walkTsFiles(full, fileList);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      fileList.push(full);
    }
  }
  return fileList;
}

// apps/web contains the Vite/React app, which has its own toolchain (Vite
// bundles JSX itself). The backend build only compiles its shared helper
// sources (*src*) so dist keeps `apps/web/src/App.js` for the API tests.
function isCompilable(srcFile) {
  const rel = path.relative(ROOT, srcFile);
  return !rel.startsWith('apps/web/app') && rel !== 'apps/web/vite.config.ts';
}

// Map workspace package names -> their compiled entry file inside dist/,
// e.g. '@living-wiki/db' -> 'packages/db/src/index.js'. Sources import each
// other by package name; the compiled output must become self-contained, so we
// rewrite those specifiers to relative paths inside dist/.
const workspaceEntry = new Map();
for (const group of ['packages', 'apps']) {
  const groupDir = path.join(ROOT, group);
  if (!fs.existsSync(groupDir)) continue;
  for (const name of fs.readdirSync(groupDir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const manifestPath = path.join(groupDir, name.name, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const main = typeof manifest.main === 'string' && /\.tsx?$/.test(manifest.main)
      ? manifest.main
      : 'src/index.ts';
    const entry = path.join(group, name.name, main.replace(/\.tsx?$/, '.js'));
    if (manifest.name) workspaceEntry.set(manifest.name, entry);
  }
}

function toRelativeSpecifier(fromOutFile, entryInDist) {
  let rel = path.relative(path.dirname(fromOutFile), path.join(DIST, entryInDist));
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

fs.rmSync(DIST, { recursive: true, force: true });

const targets = [
  ...walkTsFiles(path.join(ROOT, 'packages')),
  ...walkTsFiles(path.join(ROOT, 'apps')),
].filter(isCompilable);

let compiledCount = 0;
for (const srcFile of targets) {
  const rel = path.relative(ROOT, srcFile);
  const outRel = rel.replace(/\.tsx?$/, '.js');
  const outFile = path.join(DIST, outRel);

  const code = fs.readFileSync(srcFile, 'utf8');
  const result = babel.transformSync(code, {
    filename: srcFile,
    presets: [[presetTypescript, { isTSX: srcFile.endsWith('.tsx'), allExtensions: true }]],
    sourceMaps: false,
  });

  let output = result.code;
  // Rewrite workspace package imports to their compiled location in dist/.
  output = output.replace(
    /(['"])@living-wiki\/([a-z0-9-]+)\1/gs,
    (match, quote, pkgName) => {
      const entry = workspaceEntry.get(`@living-wiki/${pkgName}`);
      if (!entry) return match;
      return `${quote}${toRelativeSpecifier(outFile, entry)}${quote}`;
    }
  );

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, output, 'utf8');
  compiledCount++;
}

console.log(`[build] Successfully compiled ${compiledCount} TypeScript files to dist/`);
