// node-pty ships its POSIX prebuilt spawn-helper without the execute bit, so
// every pty.spawn fails with "posix_spawnp failed" until it is chmod'd. npm
// does not preserve the mode from the tarball, so this has to run after every
// install rather than being fixed once by hand. Windows uses ConPTY and has
// no helper to fix.
import { chmodSync, existsSync } from 'node:fs'

const helpers = [
  'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
  'node_modules/node-pty/prebuilds/linux-x64/spawn-helper',
  'node_modules/node-pty/prebuilds/linux-arm64/spawn-helper',
]
if (process.platform !== 'win32') {
  for (const h of helpers) {
    if (existsSync(h)) chmodSync(h, 0o755)
  }
}

// A fresh clone has no .env.local, and the dev script passes it to Node. An
// empty one means: no shared workspace, local workspaces only.
import { copyFileSync } from 'node:fs'
if (!existsSync('.env.local') && existsSync('.env.local.example')) {
  copyFileSync('.env.local.example', '.env.local')
}
