/* The system-audio helper the Mac app ships (native/alfredo-audio), built
 * into dist-helper so electron-builder can put it in the bundle. On a Mac
 * without Xcode's command line tools, or on any other platform, the file is
 * left empty: the build still packages, and the app knows an empty helper is
 * no helper (server/home.ts). */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';

mkdirSync('dist-helper', { recursive: true });
const out = 'dist-helper/alfredo-audio';
const can = process.platform === 'darwin' && spawnSync('xcrun', ['-f', 'swiftc'], { stdio: 'ignore' }).status === 0;
if (!can) {
  if (!existsSync(out) || statSync(out).size === 0) writeFileSync(out, '');
  console.log(`helper   skipped (${process.platform === 'darwin' ? 'no swiftc; install Xcode command line tools' : 'not a Mac'})`);
  process.exit(0);
}
execFileSync('swiftc', ['-O', '-o', out, 'native/alfredo-audio/main.swift', '-framework', 'ScreenCaptureKit', '-framework', 'AVFoundation', '-framework', 'CoreMedia', '-framework', 'CoreGraphics'], { stdio: 'inherit' });
console.log(`helper   ${out}`);
