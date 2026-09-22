// Where Alfredo keeps its things on this Mac.
//
// The app was called Alfred, so the data folder and the audio helper were
// installed under that name. A rename must not orphan 87 MB of workspaces:
// an existing folder keeps being used, and only a fresh install gets the new
// one. Same for the workspace folder in the home directory.
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const pick = (...paths: string[]) => paths.find(existsSync) ?? paths[0]

/** ~/.alfredo, or ~/.alfred when that is the one that exists. */
export function appHome(): string {
  const explicit = process.env.ALFREDO_HOME ?? process.env.ALFRED_HOME
  return explicit || pick(join(homedir(), '.alfredo'), join(homedir(), '.alfred'))
}

/** The folders a terminal session may create work in. */
export function workspaceFolders(): string[] {
  return [join(homedir(), 'Alfredo'), join(homedir(), 'Alfred')]
}

/** Where a new session starts: the workspace folder, else the home directory. */
export function workspaceFolder(): string {
  return workspaceFolders().find(existsSync) ?? homedir()
}

/** The recorder helper, under its current name or the one it was built with. */
export function audioHelper(): string {
  // One you built yourself wins; otherwise the one the packaged app ships.
  // (An empty file is a build made without Swift: no helper.)
  const shipped = process.env.ALFREDO_RESOURCES ? join(process.env.ALFREDO_RESOURCES, 'bin', 'alfredo-audio') : ''
  const real = (p: string) => existsSync(p) && statSync(p).size > 0
  return [join(appHome(), 'bin', 'alfredo-audio'), join(appHome(), 'bin', 'alfred-audio'), shipped].find(real) ?? join(appHome(), 'bin', 'alfredo-audio')
}
