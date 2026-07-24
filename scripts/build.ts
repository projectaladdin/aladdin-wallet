// Bun bundler for the MV3 extension. Three independent entry points:
//   - background.ts       → background.js  (service worker, ESM)
//   - content.ts          → content.js     (ISOLATED-world bridge)
//   - inject.ts           → inject.js      (MAIN-world EIP-1193 provider)
//   - popup-bootstrap.tsx → popup.js       (React UI, mounted in popup.html)
//
// All four land in dist/ alongside copied static assets (manifest.json,
// popup.html, popup.css, icons/). Chrome reads dist/ as the unpacked extension.

import { rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '..');
const SRC = resolve(ROOT, 'src');
const PUBLIC = resolve(ROOT, 'public');
const DIST = resolve(ROOT, 'dist');

const watch = process.argv.includes('--watch');

async function build() {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  // Static files first so Chrome can pick up the manifest immediately if the
  // user already has the unpacked extension loaded.
  cpSync(resolve(ROOT, 'manifest.json'), resolve(DIST, 'manifest.json'));
  cpSync(PUBLIC, DIST, { recursive: true });

  const entrypoints = [
    resolve(SRC, 'background.ts'),
    resolve(SRC, 'content.ts'),
    resolve(SRC, 'inject.ts'),
    resolve(SRC, 'popup-bootstrap.tsx'),
  ];

  // Inline the manifest version into the bundle so `inject.ts`'s
  // `web3_clientVersion` response stays in sync with `manifest.json`
  // without a manual edit on every version bump.
  const manifest = JSON.parse(await Bun.file(resolve(ROOT, 'manifest.json')).text()) as { version: string };
  const result = await Bun.build({
    entrypoints,
    outdir: DIST,
    target: 'browser',
    format: 'esm',
    define: {
      '__WALLET_VERSION__': JSON.stringify(manifest.version),
    },
    // Chrome Web Store §2 forbids *obfuscation* but explicitly allows
    // minification (whitespace removal + identifier renaming). Dev builds
    // stay readable for the reviewer's source-map workflow; release builds
    // strip whitespace + shorten locals to cut popup/SW cold-start cost.
    // We disable property renaming (Bun's default) so public APIs and
    // chrome.* call sites remain auditable in the bundle.
    minify: watch
      ? false
      : { whitespace: true, identifiers: true, syntax: true },
    sourcemap: watch ? 'inline' : 'none',
    naming: {
      // Rename popup-bootstrap → popup so popup.html's <script src="popup.js">
      // picks it up.
      entry: '[name].[ext]',
    },
    // Service workers and content scripts need ESM with no externals.
    external: [],
  });

  if (!result.success) {
    console.error('build failed:');
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  // Bun emits popup-bootstrap.js, but manifest references popup.js. Rename
  // by copying.
  const bootstrapPath = resolve(DIST, 'popup-bootstrap.js');
  const popupPath = resolve(DIST, 'popup.js');
  if (existsSync(bootstrapPath)) {
    cpSync(bootstrapPath, popupPath);
    rmSync(bootstrapPath);
  }

  console.log(`✔ built ${entrypoints.length} entrypoints → ${DIST}`);
}

if (watch) {
  // Bun has no native watch for Bun.build yet; use fs watcher.
  await build();
  console.log('▶ watching src/ for changes…');
  const { watch: fsWatch } = await import('node:fs');
  fsWatch(SRC, { recursive: true }, async (_evt, file) => {
    if (!file?.endsWith('.ts') && !file?.endsWith('.tsx')) return;
    console.log(`  ↺ ${file}`);
    try {
      await build();
    } catch (e) {
      console.error(e);
    }
  });
} else {
  await build();
}
