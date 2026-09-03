/**
 * dsh-plugin-archive-manager end-to-end smoke: real source dsh, temp DSH_HOME, install
 * this package into a profile, boot `dsh web`, then probe the archive-manager routes.
 *
 * Gate: DSH_ARCHIVE_MANAGER_PLUGIN_SMOKE=1 (mirrors dsh-plugin-install's gate).
 * Requires: deepseek-harness checked out beside this repo, `pnpm install`
 * already run there, and a host that permits capturing child-process output.
 */

import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const srcDir = fileURLToPath(new URL('.', import.meta.url))
const pluginDir = join(srcDir, '..')
const repoRoot = join(srcDir, '..', '..', 'deepseek-harness')
const guard = existsSync(join(repoRoot, 'apps', 'cli', 'src', 'bin.ts'))
const [nodeMajor, nodeMinor] = process.version.slice(1).split('.').map(Number)
const nodeOk = (nodeMajor === 22 && nodeMinor >= 19) || nodeMajor >= 24

const smokeRoot = mkdtempSync(join(tmpdir(), 'dsh-plugin-archive-manager-smoke-'))
const dshBin = join(repoRoot, 'apps', 'cli', 'src', 'bin.ts')

/** Clean PATH (same reason as dsh-plugin-install's smoke: vitest prepends
 * ancestor node_modules/.bin, which drags in a stray pnpm that breaks dsh's
 * plugin forwarder). */
function smokeEnv(dshHome: string): NodeJS.ProcessEnv {
  const systemBins = [
    process.env.npm_config_prefix,
    join(homedir(), 'AppData', 'Roaming', 'npm'),
    dirname(process.execPath),
  ].filter((value): value is string => typeof value === 'string' && value !== '')
  const pathValue = [...systemBins, 'C:\\Windows\\system32', 'C:\\Windows'].join(';')
  return { ...process.env, DSH_HOME: dshHome, PATH: pathValue }
}

function dsh(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx/esm', dshBin, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
    }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
      resolve({ code, out: `${stdout}\n${stderr}` })
    })
  })
}

function bootWeb(dshHome: string): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', dshBin, 'web', '--port', '0', '--host', '127.0.0.1'], {
      cwd: repoRoot,
      env: { ...smokeEnv(dshHome), DSH_DESKTOP: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffer = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`timed out waiting for dsh web URL line; output:\n${buffer.slice(-4000)}`))
    }, 120_000)
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString()
      const match = /dsh web: http:\/\/127\.0\.0\.1:(\d+)/.exec(buffer)
      if (match !== null) {
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        child.stderr?.off('data', onData)
        resolve({ port: Number(match[1]) })
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    afterAll(() => { try { child.kill() } catch { /* already gone */ } })
  })
}

describe.skipIf(process.env.DSH_ARCHIVE_MANAGER_PLUGIN_SMOKE !== '1' || !guard || !nodeOk)('dsh-plugin-archive-manager smoke', () => {
  afterAll(() => {
    if (smokeRoot.startsWith(tmpdir()) && smokeRoot.includes('dsh-plugin-archive-manager-smoke-')) {
      rmSync(smokeRoot, { recursive: true, force: true })
    }
  })

  it('installs into a temp profile, boots web, and serves the archive-manager routes', { timeout: 240_000 }, async () => {
    const env = smokeEnv(smokeRoot)

    const install = await dsh(['plugin', '--profile', 'web', 'add', `file:${pluginDir}`], env)
    if (install.code !== 0) console.log('[smoke] FULL dsh output:\n' + install.out)
    expect(install.code, install.out).toBe(0)

    const manifest = JSON.parse(readFileSync(join(smokeRoot, 'profiles', 'web', 'package.json'), 'utf8')) as {
      dsh?: { profile?: { bundles?: string[] } }
    }
    expect(manifest.dsh?.profile?.bundles).toContain('dsh-plugin-archive-manager')

    const { port } = await bootWeb(smokeRoot)
    const origin = `http://127.0.0.1:${port}`

    // status: routes alive, funnel present, rules default OFF
    const status = await fetch(`${origin}/dsh-plugin-archive-manager/status`)
    expect(status.status).toBe(200)
    const statusBody = await status.json() as { ok?: boolean; unarchiveSupported?: boolean; rules?: { enabled?: boolean } }
    expect(statusBody.ok).toBe(true)
    expect(statusBody.unarchiveSupported).toBe(true)
    expect(statusBody.rules?.enabled).toBe(false)

    // list on a fresh home: empty, but shaped
    const list = await fetch(`${origin}/dsh-plugin-archive-manager/list`)
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject({ rows: [] })

    // preview of an unknown id is a 404 (not a crash)
    const preview = await fetch(`${origin}/dsh-plugin-archive-manager/preview?sessionId=nope`)
    expect(preview.status).toBe(404)

    // cross-origin POST is fenced off
    const csrf = await fetch(`${origin}/dsh-plugin-archive-manager/unarchive-batch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example', host: `127.0.0.1:${port}` },
      body: JSON.stringify({ sessionIds: ['x'] }),
    })
    expect(csrf.status).toBe(403)

    // same-origin rules round-trip persists into the temp home
    const save = await fetch(`${origin}/dsh-plugin-archive-manager/rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, host: `127.0.0.1:${port}` },
      body: JSON.stringify({ rules: { enabled: false, maxIdleDays: 7, perWorkspaceKeep: 3 } }),
    })
    expect(save.status).toBe(200)
    const settingsFile = readFileSync(join(smokeRoot, 'dsh-plugin-archive-manager.json'), 'utf8')
    expect(settingsFile).toContain('"maxIdleDays": 7')

    // dry-run autorun selects nothing (rules disabled, empty home)
    const autorun = await fetch(`${origin}/dsh-plugin-archive-manager/autorun`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, host: `127.0.0.1:${port}` },
      body: JSON.stringify({ dryRun: true }),
    })
    expect(autorun.status).toBe(200)
    expect(await autorun.json()).toMatchObject({ dryRun: true, archived: [] })
  })
})
