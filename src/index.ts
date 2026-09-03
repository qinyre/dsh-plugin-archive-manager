/** dsh-plugin-archive-manager host entry: mount the archive-manager HTTP routes once
 * the profile composes the webServer / workspaceRegistry / sessionPersistence
 * services, and run the opt-in auto-archive scheduler when the persisted
 * rules enable it.
 *
 * Two rules of the road learned the hard way:
 * - Services are fetched with `ctx.get(name)` and passed around as plain
 *   objects — accessing `ctx.<service>` as a property without a declared
 *   inject trips cordis' proxy guard ("cannot get property … without
 *   inject") and takes the whole plugin tree down.
 * - No hard inject dependencies: on headless profiles the three services
 *   never bind, and the plugin stays dormant instead of blocking boot. */

import type { Context } from '@deepseek-ai/cordis'
import { mountArchiveRoutes } from './routes.ts'
import { loadRules, runAutoArchive } from './autorules.ts'
import type { ArchiveHost, PersistenceLike, RegistryWriteSurface, SessionsLike, WebServerService } from './types.ts'

export const name = 'dsh-plugin-archive-manager'

/** Delay after mount before the first auto-archive pass (keep startup
 * clean), and the re-check cadence. */
const BOOT_DELAY_MS = 30_000
const RECHECK_MS = 24 * 60 * 60 * 1000

/** Service key candidates, newest first (defensive across dsh builds). */
const WEB_SERVER_KEYS = ['webServer', 'httpServer']
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace']
const PERSISTENCE_KEYS = ['sessionPersistence']

/** Scheduler handle so rule changes re-arm the cadence cleanly. */
class AutoScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  private interval: ReturnType<typeof setInterval> | null = null
  private running = false

  constructor(private readonly host: ArchiveHost) {}

  arm(): void {
    this.disarm()
    void loadRules().then(rules => {
      if (!rules.enabled) return
      this.timer = setTimeout(() => { void this.fire() }, BOOT_DELAY_MS)
      this.interval = setInterval(() => { void this.fire() }, RECHECK_MS)
    }).catch(() => { /* rules unreadable → stay off */ })
  }

  private async fire(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const rules = await loadRules()
      if (rules.enabled) {
        const result = await runAutoArchive(this.host, rules, false)
        if (result.archived.length > 0) {
          this.host.logger?.info(`dsh-plugin-archive-manager: auto-archived ${result.archived.length} session(s)`)
        }
        for (const failure of result.failed) {
          this.host.logger?.warn(`dsh-plugin-archive-manager: auto-archive of ${failure.sessionId} failed: ${failure.error}`)
        }
      }
    } catch (error) {
      this.host.logger?.warn(`dsh-plugin-archive-manager: auto-archive pass failed: ${String(error)}`)
    } finally {
      this.running = false
    }
  }

  disarm(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.interval !== null) clearInterval(this.interval)
    this.timer = null
    this.interval = null
  }
}

export function apply(ctx: Context): void {
  let mounted = false

  const mountWebSurface = (): void => {
    if (mounted) return
    const webServer = WEB_SERVER_KEYS.map(key => ctx.get(key)).find(value => value !== undefined)
    const registry = WORKSPACE_KEYS.map(key => ctx.get(key)).find(value => value !== undefined)
    const persistence = PERSISTENCE_KEYS.map(key => ctx.get(key)).find(value => value !== undefined)
    if (webServer === undefined || registry === undefined || persistence === undefined) return
    mounted = true

    // Assemble the host from the fetched service objects — never from ctx
    // property access (see the module doc).
    const host: ArchiveHost = {
      webServer: webServer as WebServerService,
      workspaceRegistry: registry as RegistryWriteSurface,
      sessionPersistence: persistence as PersistenceLike,
      sessions: ctx.get('sessions') as SessionsLike | undefined,
      logger: ctx.logger,
    }
    const scheduler = new AutoScheduler(host)

    ctx.effect(() => mountArchiveRoutes(host, {
      onRulesChanged: rules => { if (rules.enabled) scheduler.arm(); else scheduler.disarm() },
    }), 'dsh-plugin-archive-manager: http routes')
    ctx.effect(() => () => scheduler.disarm(), 'dsh-plugin-archive-manager: scheduler disposal')
    scheduler.arm()
  }

  mountWebSurface()
  ctx.on('internal/service', (serviceName: string) => {
    if (WEB_SERVER_KEYS.includes(serviceName) || WORKSPACE_KEYS.includes(serviceName) || PERSISTENCE_KEYS.includes(serviceName)) {
      mountWebSurface()
    }
  })
}
