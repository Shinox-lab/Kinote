import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ENTRY = fileURLToPath(new URL('./capturePanel.ts', import.meta.url));

/** Follows the host's theme (applyDocumentTheme sets color-scheme) and its style variables when it sends them. */
const CSS = `
:root { color-scheme: light dark; --bg: var(--color-background-primary, light-dark(#ffffff, #1f1f1e));
  --fg: var(--color-text-primary, light-dark(#1f1f1e, #f4f3ef)); --muted: var(--color-text-secondary, light-dark(#6b6a66, #a8a69f));
  --line: var(--color-border-primary, light-dark(#d9d7d0, #45443f)); --accent: light-dark(#2f5fd0, #7ea2ff);
  --error: light-dark(#b42318, #ff8a80); font-family: var(--font-sans, system-ui, sans-serif); }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font-size: 14px; line-height: 1.45; }
h1 { font-size: 15px; margin: 0 0 8px; }
p { margin: 0 0 8px; overflow-wrap: anywhere; }
.notes, .muted { color: var(--muted); }
.drop { border: 1.5px dashed var(--line); border-radius: 10px; padding: 20px 12px; text-align: center; }
.drop.over { border-color: var(--accent); }
.drop input[type=file] { display: none; }
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
button { font: inherit; border-radius: 8px; padding: 6px 14px; cursor: pointer; border: 1px solid var(--line); background: transparent; color: var(--fg); }
button.primary { background: var(--accent); border-color: var(--accent); color: light-dark(#fff, #10131a); }
button:disabled { opacity: .45; cursor: default; }
progress { width: 100%; height: 8px; accent-color: var(--accent); }
.error { color: var(--error); }
.receipt { white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--line); border-radius: 10px; padding: 12px; }
.receipt a { color: var(--accent); }
`;

let cached: Promise<string> | null = null;

/** The panel as one self-contained HTML page, bundled on first use and kept in memory. */
export function capturePanelHtml(): Promise<string> {
  cached ??= bundle().catch((err) => {
    cached = null;
    throw err;
  });
  return cached;
}

async function bundle(): Promise<string> {
  const out = await build({
    entryPoints: [ENTRY],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
  });
  const js = out.outputFiles[0]!.text.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kinote file panel</title>
<style>${CSS}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>
`;
}
