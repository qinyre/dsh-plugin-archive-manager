/** dsh-plugin-archive-manager client entry: the Settings archive-management
 * section and its locale + CSS. The surface talks to the host half through
 * same-origin fetch on /dsh-plugin-archive-manager/* (registered by
 * src/routes.ts). */

import { createElement } from 'react'
import { ArchivePanel, type ArchiveApi } from './ArchivePanel.tsx'
import { zh, en } from './locales.ts'

/** Locale dictionary namespace owned by this plugin. */
export const NS = 'archive-manager'

/** The `t` function bound by the locale service. */
export interface Translate {
  (key: string): string
}

/** Minimal structural subsets of the client services (same style as
 * dsh-plugin-install's client entry — structural, not imported). */
interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(meta: Record<string, unknown>, component: (props: never) => unknown): unknown
}
interface LocaleService {
  register(namespace: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(namespace: string): Translate
}

interface ArchiveClientContext {
  effect(callback: () => unknown, label?: string): void
  locale: LocaleService
  slots: SlotsService
}

// ---------------------------------------------------------------------------
// Same-origin host API

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

const postJson = <T>(path: string, body: unknown): Promise<T> =>
  fetchJson<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

function makeApi(): ArchiveApi {
  return {
    list: () => fetchJson<{ rows: import('../types.ts').ArchiveRow[] }>('/dsh-plugin-archive-manager/list'),
    preview: (sessionId: string) => fetchJson<import('../types.ts').ArchivePreview>(
      `/dsh-plugin-archive-manager/preview?sessionId=${encodeURIComponent(sessionId)}`),
    unarchiveBatch: (sessionIds: string[]) =>
      postJson<{ archivedSessionIds: string[] }>('/dsh-plugin-archive-manager/unarchive-batch', { sessionIds }),
    rules: () => fetchJson<{ rules: import('../types.ts').AutoRules }>('/dsh-plugin-archive-manager/rules'),
    saveRules: (rules: import('../types.ts').AutoRules) =>
      postJson<{ rules: import('../types.ts').AutoRules }>('/dsh-plugin-archive-manager/rules', { rules }),
    autorun: (dryRun: boolean) =>
      postJson<{ archived: string[]; selected: unknown[] }>('/dsh-plugin-archive-manager/autorun', { dryRun }),
  }
}

// ---------------------------------------------------------------------------
// CSS

const CSS = `
.dsha-page{display:flex;flex-direction:column;gap:12px;width:100%;max-width:760px;color:var(--dsw-alias-label-primary,#222)}
.dsha-page-head{display:flex;align-items:center;gap:8px}
.dsha-page-head h3{margin:0;font-size:13px;line-height:20px;font-weight:600}
.dsha-page-count{font-size:11px;font-weight:600;color:#2e6fe8;background:rgba(46,111,232,.12);padding:1px 8px;border-radius:9px;line-height:18px}
.dsha-page-head-actions{margin-left:auto;display:inline-flex;gap:2px}
.dsha-page-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary,rgba(110,117,140,.85))}
.dsha-page-btn{display:inline-flex;align-items:center;gap:4px;font-size:12px;padding:5px 9px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#222);cursor:pointer}
.dsha-page-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,134,156,.12))}
.dsha-page-btn:disabled{opacity:.45;cursor:default}
.dsha-page-btn svg{width:14px;height:14px}
.dsha-page-search{padding:7px 12px;font-size:13px;border:1px solid var(--dsw-alias-border-l2,rgba(128,134,156,.4));border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:inherit;outline:none;transition:border-color .12s ease-out}
.dsha-page-search:focus{border-color:#2e6fe8}
.dsha-page-search::placeholder{color:var(--dsw-alias-label-secondary,rgba(80,88,110,.9))}
.dsha-page-note{padding:36px 8px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary,rgba(80,88,110,.9))}
.dsha-page-group{margin:2px 0}
.dsha-page-group-head{display:flex;align-items:center;justify-content:space-between;padding:2px 8px 4px}
.dsha-page-group-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#222);display:flex;align-items:center;gap:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsha-page-group-count{font-size:11px;font-weight:600;color:#2e6fe8;background:rgba(46,111,232,.12);border-radius:8px;padding:0 6px;line-height:16px}
.dsha-page-row{display:flex;gap:10px;align-items:flex-start;padding:8px;border-radius:8px;cursor:pointer;border:1px solid transparent}
.dsha-page-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,134,156,.12))}
.dsha-page-row:has(input:checked){background:rgba(46,111,232,.08);border-color:rgba(46,111,232,.35)}
.dsha-page-row input{margin-top:3px;accent-color:#2e6fe8}
.dsha-page-row-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.dsha-page-row-title{font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary,#222);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsha-page-row-meta{font-size:11px;color:var(--dsw-alias-label-secondary,rgba(80,88,110,.9));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsha-page-actions{display:flex;align-items:center;gap:10px}
.dsha-page-message{font-size:12px}
.dsha-page-message.ok{color:#2e6fe8}
.dsha-page-message.err{color:var(--dsw-static-red-500,#ef4444)}
.dsha-page-selected{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-primary,#222)}
.dsha-page-primary{font-size:13px;font-weight:600;padding:6px 18px;border:0;border-radius:8px;background:#2e6fe8;color:#fff;cursor:pointer}
.dsha-page-primary:hover:not(:disabled){background:#1f5fd8}
.dsha-page-primary:disabled{background:rgba(46,111,232,.14);color:#2e6fe8;cursor:default}
.dsha-rules{margin:8px 0 0;padding:12px 14px;display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2,rgba(128,134,156,.4));border-radius:10px;background:var(--dsw-alias-bg-base,#fff)}
.dsha-rules-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,#222)}
.dsha-rules-row{display:flex;gap:8px;align-items:center;font-size:12px}
.dsha-rules-row>span{flex:1;display:flex;flex-direction:column;gap:2px}
.dsha-rules-hint{font-style:normal;font-size:11px;color:var(--dsw-alias-label-secondary,rgba(80,88,110,.9))}
.dsha-rules-row input[type=number]{width:96px;padding:5px 8px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,rgba(128,134,156,.4));border-radius:7px;background:var(--dsw-alias-bg-base,#fff);color:inherit;outline:none}
.dsha-rules-row input[type=number]:focus{border-color:#2e6fe8}
.dsha-rules-row input[type=checkbox]{accent-color:#2e6fe8}
.dsha-rules-actions{display:flex;gap:6px}
.dsha-rules-actions .dsha-page-btn{margin-left:0}
`

function injectCss(): void {
  if (document.querySelector('style[data-plugin-css="dsh-plugin-archive-manager"]') !== null) return
  const style = document.createElement('style')
  style.setAttribute('data-plugin-css', 'dsh-plugin-archive-manager')
  style.textContent = CSS
  document.head.appendChild(style)
}

// ---------------------------------------------------------------------------

export const name = 'dsh-plugin-archive-manager'
export const inject = ['slots', 'locale']

export function apply(ctx: ArchiveClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-archive-manager: dictionaries')
  injectCss()

  const t = ctx.locale.bind(NS)
  const api = makeApi()

  // Archive management: a first-level Settings section, next to 技能与 MCP.
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'archive-manager', order: 14, label: () => t('sectionNav'), locale: NS },
      () => createElement(ArchivePanel, { t, api }),
    ))
}
