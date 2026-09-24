/* Ship a version: the one command behind "push an update".
 *
 *   npm run ship -- 0.1.2 [notes.md]
 *
 * Bumps package.json, commits and tags it, pushes (CI builds Windows and
 * Linux onto the release), builds, signs and notarizes the Mac app here, and
 * puts the dmg, the zip and the update manifest on the GitHub release. The
 * manifest (latest-mac.yml) is what installed apps look for: until it is on
 * the latest release, nobody's app offers the update. Needs a clean tree,
 * the Developer ID certificate, the notary profile and gh signed in.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [version, notesFile] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('Say which version: npm run ship -- 0.1.2 [notes.md]');
  process.exit(1);
}
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
const out = (cmd, args) => execFileSync(cmd, args).toString().trim();

if (out('git', ['status', '--porcelain'])) {
  console.error('Commit or stash first: shipping tags exactly what is committed.');
  process.exit(1);
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
if (pkg.version === version) console.log(`version   already ${version}`);
else {
  pkg.version = version;
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  sh('git', ['add', 'package.json']);
  sh('git', ['commit', '-q', '-m', `Alfredo v${version}`]);
}
const tag = `v${version}`;
if (!out('git', ['tag', '-l', tag])) sh('git', ['tag', '-a', tag, '-m', `Alfredo ${tag}`]);
sh('git', ['push', '-q', 'origin', 'HEAD', tag]);
console.log(`pushed    ${tag} (CI builds Windows and Linux)`);

sh('npm', ['run', 'release:mac']);

const files = [`dist-app/Alfredo-${version}-arm64.dmg`, `dist-app/Alfredo-${version}-arm64-mac.zip`, `dist-app/Alfredo-${version}-arm64.dmg.blockmap`, `dist-app/Alfredo-${version}-arm64-mac.zip.blockmap`, 'dist-app/latest-mac.yml'].filter(existsSync);
const notes = notesFile ? ['--notes-file', notesFile] : ['--generate-notes'];
const made = spawnSync('gh', ['release', 'create', tag, '--title', `Alfredo ${tag}`, ...notes, ...files], { stdio: 'inherit' });
if (made.status !== 0) sh('gh', ['release', 'upload', tag, '--clobber', ...files]);
console.log(`shipped   https://github.com/${pkg.build.publish[0].owner}/${pkg.build.publish[0].repo}/releases/tag/${tag}`);
console.log('Installed apps offer it within a few hours, or on their next launch.');
