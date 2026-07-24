// Build the extension and zip dist/ contents into wallet/aladdin-wallet-v<ver>.zip
// for distribution / sideload / Chrome Web Store upload.
//
// The zip contains the *contents* of dist/ at root (manifest.json, popup.html,
// background.js, ...) — NOT a wrapping `dist/` directory. Chrome and the Web
// Store both expect manifest at root.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { $ } from 'bun';

const ROOT = resolve(import.meta.dir, '..');
const DIST = resolve(ROOT, 'dist');
const MANIFEST = resolve(ROOT, 'manifest.json');

// 1. Rebuild fresh
console.log('▶ build');
await $`bun run scripts/build.ts`.cwd(ROOT);

// 2. Read version from manifest for filename
const { version, name } = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
  version: string;
  name: string;
};
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const zipName = `${slug}-v${version}.zip`;
const zipPath = resolve(ROOT, zipName);

if (existsSync(zipPath)) rmSync(zipPath);

// 3. Zip dist/ contents so the archive entries are relative, with no leading
// `dist/` directory (Chrome + the Web Store expect manifest.json at root).
// Defensive excludes: dist/ should never contain these (esbuild bundles in
// place + minify=false → no maps), but if a stale node_modules / .map /
// .DS_Store ever leaks into the build output, we don't want it shipped.
//
// Cross-platform: Unix/CI use the `zip` binary. Windows has no `zip`, and
// PowerShell 5.1's Compress-Archive / ZipFile.CreateFromDirectory emit
// backslash-separated entry names that the Web Store mishandles — so on
// Windows we build the archive via .NET System.IO.Compression with explicit
// forward-slash entry names (no external binary, correct icons/ nesting).
console.log(`▶ zip → ${zipName}`);
if (process.platform === 'win32') {
  const ps = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$src = $env:PACK_SRC
$dest = $env:PACK_DEST
if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Force }
$zip = [System.IO.Compression.ZipFile]::Open($dest, 'Create')
try {
  Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length + 1) -replace '\\', '/'
    if ($rel -like 'node_modules/*' -or $rel -like '*.map' -or $rel -like '*.DS_Store') { return }
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal)
  }
} finally {
  $zip.Dispose()
}
`;
  const proc = Bun.spawnSync(
    ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { env: { ...process.env, PACK_SRC: DIST, PACK_DEST: zipPath }, stderr: 'inherit' },
  );
  if (proc.exitCode !== 0) throw new Error(`pack: PowerShell zip failed (exit ${proc.exitCode})`);
} else {
  await $`zip -qr ${zipPath} . -x 'node_modules/*' '*.map' '.DS_Store' '*/.DS_Store'`.cwd(DIST);
}

// 4. Show size summary
const stat = Bun.file(zipPath).size;
const kb = (stat / 1024).toFixed(1);
console.log(`✔ ${zipName} (${kb} KB)`);
console.log(`  Chrome Web Store: chrome://extensions → Load unpacked (dev) or upload to dashboard.`);
console.log(`  Sideload: extract zip, point Load unpacked at the extracted folder.`);
