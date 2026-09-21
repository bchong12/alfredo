// Secrets for workspace connections live in the macOS keychain, never in
// workspaces.json. The registry says *where* a workspace lives; the keychain
// holds the token that lets this machine in. Off macOS (Windows, Linux, CI)
// it falls back to a file beside the registry, inside the user's own profile,
// locked to the owner where the filesystem has a way to say that.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { appHome } from './home'

const SERVICE = 'Alfredo'
const mac = process.platform === 'darwin'
const FALLBACK = () => join(appHome(), 'secrets.json')

function readFallback(): Record<string, string> {
  try {
    return existsSync(FALLBACK()) ? JSON.parse(readFileSync(FALLBACK(), 'utf8')) : {}
  } catch {
    return {}
  }
}

export function getSecret(account: string): string | null {
  if (mac) {
    try {
      return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      return null
    }
  }
  return readFallback()[account] ?? null
}

export function setSecret(account: string, value: string) {
  if (mac) {
    // -U updates in place when the item already exists.
    execFileSync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-w', value], {
      stdio: 'ignore',
    })
    return
  }
  const all = readFallback()
  all[account] = value
  mkdirSync(appHome(), { recursive: true })
  writeFileSync(FALLBACK(), JSON.stringify(all, null, 2))
  // Windows has no mode bits worth setting; the file sits in the user's own
  // profile, which is the same fence NTFS would give it.
  try {
    chmodSync(FALLBACK(), 0o600)
  } catch {}
}

export function deleteSecret(account: string) {
  if (mac) {
    try {
      execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', account], { stdio: 'ignore' })
    } catch {}
    return
  }
  const all = readFallback()
  delete all[account]
  writeFileSync(FALLBACK(), JSON.stringify(all, null, 2))
}
