/* Put the built app in /Applications and start it.
 *
 * The obvious version of this (quit, rm -rf, cp -R, open) installs a working
 * app with the wrong icon. macOS keeps what it knows about a bundle in
 * LaunchServices, keyed by path, and a new bundle arriving at the path the old
 * one just left does not by itself invalidate that: the Dock goes on drawing
 * the icon it cached, which for a first build of an Electron app is Electron's
 * own. Worse, the tile of a RUNNING app holds the icon it was given at launch,
 * so an app opened in the same breath as the copy keeps the stale one until it
 * is started again.
 *
 * So: the copy lands beside the target and is moved into place in one step, the
 * bundle is re-registered before anything opens it, and only then does the app
 * start.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (process.platform !== 'darwin') {
  /* The release notes offer this as the build-it-yourself route on every
     platform; /Applications only exists on one of them. */
  console.error('This puts the app in /Applications, which is a Mac thing.');
  console.error(`Build it with npm run desktop:build:${process.platform === 'win32' ? 'win' : 'linux'} and run it from dist-app.`);
  process.exit(1);
}

const APP = 'Alfredo.app';
const built = join('dist-app', process.arch === 'arm64' ? 'mac-arm64' : 'mac', APP);
const installed = join('/Applications', APP);
const staging = join('/Applications', `.${APP}.incoming`);
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks'
  + '/LaunchServices.framework/Support/lsregister';

const run = (command, args, quiet = false) =>
  spawnSync(command, args, { stdio: quiet ? 'ignore' : 'inherit' }).status === 0;

if (!existsSync(built)) {
  console.error(`No build at ${built}. Run npm run desktop:build first.`);
  process.exit(1);
}

/* A running copy holds the old bundle open, and would keep its old icon. */
run('osascript', ['-e', `quit app "${APP.replace('.app', '')}"`], true);
for (let waited = 0; waited < 20; waited++) {
  if (!run('pgrep', ['-f', `${installed}/Contents/MacOS/`], true)) break;
  execFileSync('sleep', ['0.25']);
}

rmSync(staging, { recursive: true, force: true });
if (!run('cp', ['-R', built, staging])) process.exit(1);
rmSync(installed, { recursive: true, force: true });
if (!run('mv', [staging, installed])) process.exit(1);

/* A dir build carries no update manifest (only a packaged one does); without
   it the app cannot look for newer versions. Written here from package.json,
   so an install made this way updates like one from the releases page. */
try {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const pub = pkg.build?.publish?.[0];
  const manifest = join(installed, 'Contents', 'Resources', 'app-update.yml');
  if (pub && !existsSync(manifest)) writeFileSync(manifest, `owner: ${pub.owner}\nrepo: ${pub.repo}\nprovider: ${pub.provider}\nupdaterCacheDirName: ${pkg.name}-updater\n`);
} catch {}

/* Before anything opens it, so the Dock asks about this bundle and not the
   one that used to be here. */
run(LSREGISTER, ['-f', installed], true);

run('open', ['-a', installed]);
console.log(`installed  ${installed}`);
