import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IN_DEVELOPMENT: readonly string[] = ['WhatsApp', 'Google Drive', 'MCP', 'Self-maintaining wiki', 'Space export'];

const BANNED: RegExp[] = [
  /\bShinox\b(?!-lab)/g,
  /\bCurator\b/g,
  /\bPhase [A-Z]\d?[a-z]?\b/g,
  /\bslice \d+\b/gi,
  /\bsk-[A-Za-z0-9-]{20,}/g,
];

const LABEL = '(In development)';

/** Every banned match in `text`, in the order it appears. */
export function findBannedTerms(text: string): string[] {
  const hits: Array<{ at: number; match: string }> = [];
  for (const re of BANNED) {
    for (const m of text.matchAll(re)) hits.push({ at: m.index ?? 0, match: m[0] });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.match);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lines that name an in-development feature without the "(In development)" label. */
export function findUnlabelledInDevelopment(text: string): string[] {
  const named = IN_DEVELOPMENT.map((name) => ({ name, re: new RegExp(`\\b${escape(name)}\\b`, 'i') }));
  return text.split('\n').filter((line) => {
    if (line.includes(LABEL)) return false;
    return named.some(({ name, re }) => re.test(line) && (name !== 'MCP' || /agent/i.test(line)));
  });
}

/** Problems with the README: dark logo, hosted-service links, and local files it points at. */
export function findReadmeIssues(readme: string, hostedUrl: string, exists: (relPath: string) => boolean): string[] {
  const issues: string[] = [];
  if (/<picture>/i.test(readme) && !/prefers-color-scheme:\s*dark/i.test(readme)) issues.push('logo has no dark-theme source');

  const tryLinks = [
    ...[...readme.matchAll(/\[Try Kinote\]\(([^)\s]+)\)/gi)].map((m) => m[1]),
    ...[...readme.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>\s*Try Kinote\s*<\/a>/gi)].map((m) => m[1]),
  ];
  if (tryLinks.some((url) => url !== hostedUrl)) issues.push('"Try Kinote" link is not the hosted URL');

  const refs = [
    ...[...readme.matchAll(/\b(?:src|srcset|href)="([^"]+)"/g)].map((m) => m[1]),
    ...[...readme.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]),
  ];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (/^(?:[a-z]+:|#|\/\/)/i.test(ref)) continue;
    const path = ref.split(/[?#]/)[0];
    if (!path || seen.has(path)) continue;
    seen.add(path);
    if (!exists(path)) issues.push(`missing file: ${path}`);
  }
  return issues;
}

function walk(dir: string, keep: (file: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return ['node_modules', 'dist', 'cache', '.work'].includes(e.name) ? [] : walk(p, keep);
    return keep(p) ? [p] : [];
  });
}

function lineOf(text: string, needle: string): number {
  const at = text.indexOf(needle);
  return at < 0 ? 1 : text.slice(0, at).split('\n').length;
}

function main(): number {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const site = join(root, 'site');
  const rel = (p: string) => relative(root, p);
  const readme = join(root, 'README.md');
  const features = join(site, '.vitepress', 'theme', 'features.ts');

  const scanned = [
    readme,
    ...walk(site, (f) => f.endsWith('.md')),
    ...walk(join(site, '.vitepress', 'theme'), (f) => /\.(ts|vue)$/.test(f)),
    ...walk(join(site, 'clips', 'seed'), (f) => f.endsWith('.ts')),
  ].filter((f, i, all) => existsSync(f) && all.indexOf(f) === i);

  const problems: string[] = [];
  for (const file of scanned) {
    const text = readFileSync(file, 'utf8');
    for (const term of findBannedTerms(text)) problems.push(`${rel(file)}:${lineOf(text, term)}: banned term "${term}"`);
  }
  for (const file of [readme, features].filter((f) => existsSync(f))) {
    const text = readFileSync(file, 'utf8');
    for (const line of findUnlabelledInDevelopment(text)) {
      problems.push(`${rel(file)}:${lineOf(text, line)}: in-development feature without "${LABEL}"`);
    }
  }
  if (existsSync(readme)) {
    const text = readFileSync(readme, 'utf8');
    const hosted = JSON.parse(readFileSync(join(site, 'hosted.json'), 'utf8')) as { url: string };
    for (const issue of findReadmeIssues(text, hosted.url, (p) => existsSync(join(root, p)))) problems.push(`README.md:1: ${issue}`);
  }

  for (const p of problems) console.log(p);
  console.log(problems.length ? `${problems.length} problem(s) in ${scanned.length} files` : `ok: ${scanned.length} files checked`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
