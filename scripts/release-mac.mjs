/* A Mac release someone else can open.
 *
 * A downloaded app that is not signed and notarized is "damaged and can't be
 * opened" on any Mac but the one that built it. So this signs with the
 * Developer ID in the keychain, has Apple notarize it, and staples the ticket,
 * then writes a dmg (drag Alfredo to Applications) and a zip.
 *
 * Needs, on this Mac: a "Developer ID Application" certificate in the
 * keychain, and notarytool credentials stored as a keychain profile
 * (xcrun notarytool store-credentials <name>); name it with
 * APPLE_KEYCHAIN_PROFILE, default AC_PASSWORD. Run after build:desktop-ui and
 * build:server, which npm run release:mac does.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

if (process.platform !== 'darwin') {
  console.error('A signed Mac build has to be made on a Mac.');
  process.exit(1);
}
const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning']).toString();
// electron-builder wants the name without its "Developer ID Application:" prefix.
const id = /"Developer ID Application: ([^"]+)"/.exec(identities)?.[1];
if (!id) {
  console.error('No "Developer ID Application" certificate in the keychain; nothing to sign with.');
  process.exit(1);
}
if (!existsSync('dist-helper/alfredo-audio') || statSync('dist-helper/alfredo-audio').size === 0) {
  console.error('The audio helper did not build (node scripts/helper.mjs needs Xcode command line tools); a release ships it.');
  process.exit(1);
}
const profile = process.env.APPLE_KEYCHAIN_PROFILE ?? 'AC_PASSWORD';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
console.log(`signing as  ${id}`);
console.log(`notarizing  keychain profile ${profile}`);

const r = spawnSync('npx', ['electron-builder', '--mac', 'dmg', 'zip', '--arm64', '--config.mac.identity=' + id, '--config.mac.notarize=true'], {
  stdio: 'inherit',
  env: { ...process.env, APPLE_KEYCHAIN_PROFILE: profile, CSC_IDENTITY_AUTO_DISCOVERY: 'true' },
});
if (r.status !== 0) process.exit(r.status ?? 1);

/* The dmg gets its own ticket, so it opens on a Mac that is offline too. */
const dmg = `dist-app/Alfredo-${version}-arm64.dmg`;
if (existsSync(dmg)) {
  console.log(`notarizing  ${dmg}`);
  const n = spawnSync('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', profile, '--wait'], { stdio: 'inherit' });
  if (n.status !== 0) process.exit(n.status ?? 1);
  spawnSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
}

/* Say whether a stranger's Mac will open it, the way Gatekeeper decides. */
const v = spawnSync('spctl', ['-a', '-vv', '-t', 'exec', 'dist-app/mac-arm64/Alfredo.app'], { encoding: 'utf8' });
console.log((v.stderr || v.stdout).trim());
console.log(`\nready  ${dmg}\nready  dist-app/Alfredo-${version}-arm64-mac.zip`);
