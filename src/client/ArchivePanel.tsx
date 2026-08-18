/** The archive drawer: sidebar-foot entry opens this overlay panel. Lists
 * archived sessions grouped by workspace with a lazy per-row preview, search,
 * single/batch unarchive, and the auto-archive rules form (default OFF) with
 * dry-run. All mutations go through the same-origin host routes; the sidebar
 * itself updates live because the host pushes
 * `host/archived-sessions-changed` on every registry write. */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ArchivePreview, ArchiveRow, AutoRules } from '../types.ts'

/** Host API surface (bound in client/index.ts via same-origin fetch). */
export interface AtlasApi {
  list(): Promise<{ rows: ArchiveRow[] }>
  preview(sessionId: string): Promise<ArchivePreview>
  unarchiveBatch(sessionIds: string[]): Promise<{ archivedSessionIds: string[] }>
  rules(): Promise<{ rules: AutoRules }>
  saveRules(rules: AutoRules): Promise<{ rules: AutoRules }>
  autorun(dryRun: boolean): Promise<{ archived: string[]; selected: unknown[] }>
}

export interface ArchivePanelProps {
  t: (key: string) => string
  api: AtlasApi
  onClose: () => void
}

/** Bound template: t('k') returns '…{n}…' — fill it locally. */
function tf(t: (key: string) => string, key: string, n: number): string {
  return t(key).replace('{n}', String(n))
}

function RefreshIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M13.5 8a5.5 5.5 0 1 1-1.62-3.9" />
      <path d="M13.5 1.8v2.7h-2.7" />
    </svg>
  )
}

function CloseIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

interface RulesForm {
  enabled: boolean
  maxIdleDays: string
  perWorkspaceKeep: string
}

const formOfRules = (rules: AutoRules): RulesForm => ({
  enabled: rules.enabled,
  maxIdleDays: rules.maxIdleDays === null ? '' : String(rules.maxIdleDays),
  perWorkspaceKeep: rules.perWorkspaceKeep === null ? '' : String(rules.perWorkspaceKeep),
})

export function ArchivePanel(props: ArchivePanelProps): React.ReactElement {
  const { t, api } = props
  const [rows, setRows] = useState<ArchiveRow[] | null>(null)
  const [previews, setPreviews] = useState<Map<string, ArchivePreview>>(new Map())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [messageKind, setMessageKind] = useState<'ok' | 'err'>('ok')
  const [form, setForm] = useState<RulesForm | null>(null)

  const reload = useCallback(async () => {
    try {
      const { rows: next } = await api.list()
      setRows(next)
      setMessage(null)
    } catch (error) {
      setRows([])
      setMessage(error instanceof Error ? error.message : String(error))
      setMessageKind('err')
    }
  }, [api])

  useEffect(() => { void reload() }, [reload])

  // Rules load once per drawer open.
  useEffect(() => {
    void api.rules()
      .then(({ rules }) => { setForm(formOfRules(rules)) })
      .catch(() => { setForm(formOfRules({ enabled: false, maxIdleDays: 30, perWorkspaceKeep: null })) })
  }, [api])

  // Lazy previews for the first visible rows (bounded; preview of the rest
  // loads when they scroll into the filtered window).
  const visible = useMemo(() => {
    if (rows === null) return []
    const needle = query.trim().toLowerCase()
    if (needle === '') return rows
    return rows.filter(row =>
      (row.workspaceTitle ?? '').toLowerCase().includes(needle)
      || (row.cwd ?? '').toLowerCase().includes(needle)
      || row.id.toLowerCase().includes(needle))
  }, [rows, query])

  useEffect(() => {
    const pending = visible.slice(0, 60).filter(row => !previews.has(row.id))
    if (pending.length === 0) return
    let cancelled = false
    void (async () => {
      for (const row of pending) {
        if (cancelled) return
        try {
          const preview = await api.preview(row.id)
          if (cancelled) return
          setPreviews(current => new Map(current).set(row.id, preview))
        } catch { /* preview is advisory — absence renders the id */ }
      }
    })()
    return () => { cancelled = true }
  }, [visible, previews, api])

  const groups = useMemo(() => {
    const map = new Map<string, ArchiveRow[]>()
    for (const row of visible) {
      const key = row.workspaceTitle ?? ''
      const bucket = map.get(key)
      if (bucket === undefined) map.set(key, [row])
      else bucket.push(row)
    }
    return [...map.entries()].sort((left, right) => right[1].length - left[1].length)
  }, [visible])

  const toggle = (id: string): void => {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleGroup = (groupRows: readonly ArchiveRow[]): void => {
    setSelected(current => {
      const next = new Set(current)
      const allSelected = groupRows.every(row => next.has(row.id))
      for (const row of groupRows) {
        if (allSelected) next.delete(row.id)
        else next.add(row.id)
      }
      return next
    })
  }

  const unarchiveSelected = async (): Promise<void> => {
    if (selected.size === 0 || busy) return
    setBusy(true)
    try {
      await api.unarchiveBatch([...selected])
      setSelected(new Set())
      setMessage(tf(t, 'drawer.unarchived', [...selected].length))
      setMessageKind('ok')
      await reload()
    } catch (error) {
      setMessage(t('drawer.unarchiveFailed'))
      setMessageKind('err')
    } finally {
      setBusy(false)
    }
  }

  const saveRules = async (): Promise<void> => {
    if (form === null || busy) return
    const idle = form.maxIdleDays.trim() === '' ? null : Number(form.maxIdleDays)
    const keep = form.perWorkspaceKeep.trim() === '' ? null : Number(form.perWorkspaceKeep)
    const idleOk = idle === null || (Number.isInteger(idle) && idle >= 1 && idle <= 3650)
    const keepOk = keep === null || (Number.isInteger(keep) && keep >= 1 && keep <= 500)
    if (!idleOk || !keepOk) {
      setMessage(t('rules.invalid'))
      setMessageKind('err')
      return
    }
    setBusy(true)
    try {
      await api.saveRules({ enabled: form.enabled, maxIdleDays: idle, perWorkspaceKeep: keep })
      setMessage(t('rules.saved'))
      setMessageKind('ok')
    } catch {
      setMessage(t('rules.saveFailed'))
      setMessageKind('err')
    } finally {
      setBusy(false)
    }
  }

  const runRules = async (dryRun: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      const result = await api.autorun(dryRun)
      setMessage(tf(t, dryRun ? 'rules.dryRunResult' : 'rules.runResult', dryRun ? result.selected.length : result.archived.length))
      setMessageKind('ok')
      if (!dryRun) await reload()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      setMessageKind('err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dsha-drawer">
      <div className="dsha-drawer-backdrop" onClick={props.onClose} />
      <div className="dsha-drawer-panel" role="dialog" aria-label={t('drawer.title')}>
        <header className="dsha-drawer-head">
          <span className="dsha-drawer-title">{t('drawer.title')}</span>
          <span className="dsha-drawer-count">{rows === null ? '' : rows.length}</span>
          <span className="dsha-drawer-head-actions">
            <button type="button" className="dsha-drawer-btn" title={t('drawer.reload')} aria-label={t('drawer.reload')} onClick={() => { void reload() }}>
              <RefreshIcon />
            </button>
            <button type="button" className="dsha-drawer-btn" title={t('drawer.close')} aria-label={t('drawer.close')} onClick={props.onClose}>
              <CloseIcon />
            </button>
          </span>
        </header>

        <input
          className="dsha-drawer-search"
          type="search"
          placeholder={t('drawer.search')}
          value={query}
          onChange={event => { setQuery(event.target.value) }}
        />

        <div className="dsha-drawer-body">
          {rows === null ? (
            <div className="dsha-drawer-note">{t('drawer.loading')}</div>
          ) : visible.length === 0 ? (
            <div className="dsha-drawer-note">{t('drawer.empty')}</div>
          ) : groups.map(([groupTitle, groupRows]) => (
            <section className="dsha-drawer-group" key={groupTitle === '' ? '\0' : groupTitle}>
              <header className="dsha-drawer-group-head">
                <span className="dsha-drawer-group-title">
                  {groupTitle === '' ? t('drawer.noWorkspace') : groupTitle}
                  <span className="dsha-drawer-group-count">{groupRows.length}</span>
                </span>
                <button type="button" className="dsha-drawer-btn" onClick={() => { toggleGroup(groupRows) }}>
                  {t('drawer.selectAll')}
                </button>
              </header>
              {groupRows.map(row => {
                const preview = previews.get(row.id)
                return (
                  <label key={row.id} className="dsha-drawer-row">
                    <input
                      type="checkbox"
                      checked={selected.has(row.id)}
                      onChange={() => { toggle(row.id) }}
                    />
                    <span className="dsha-drawer-row-main">
                      <span className="dsha-drawer-row-title" title={preview?.title ?? row.id}>
                        {preview?.title ?? row.id}
                      </span>
                      <span className="dsha-drawer-row-meta">
                        {row.cwd === null ? '' : row.cwd}
                        {row.cwd !== null && preview?.turns !== undefined && preview.turns > 0 ? ' · ' : ''}
                        {preview !== undefined && preview.turns > 0 ? tf(t, 'drawer.previewTurns', preview.turns) : ''}
                      </span>
                    </span>
                  </label>
                )
              })}
            </section>
          ))}
        </div>

        <footer className="dsha-drawer-actions">
          {message !== null ? <span className={`dsha-drawer-message ${messageKind}`}>{message}</span> : null}
          <span className="dsha-drawer-selected">
            {selected.size > 0 ? tf(t, 'drawer.selected', selected.size) : ''}
          </span>
          <button
            type="button"
            className="dsha-drawer-primary"
            disabled={busy || selected.size === 0}
            onClick={() => { void unarchiveSelected() }}
          >
            {t('drawer.unarchiveSelected')}
          </button>
        </footer>

        {form !== null ? (
          <section className="dsha-rules">
            <header className="dsha-rules-title">{t('rules.title')}</header>
            <label className="dsha-rules-row">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={event => { setForm({ ...form, enabled: event.target.checked }) }}
              />
              <span>
                {t('rules.enabled')}
                <em className="dsha-rules-hint">{t('rules.enabledHint')}</em>
              </span>
            </label>
            <div className="dsha-rules-row">
              <span>{t('rules.maxIdleDays')}</span>
              <input
                type="number" min={1} max={3650}
                placeholder={t('rules.maxIdleDaysOff')}
                value={form.maxIdleDays}
                onChange={event => { setForm({ ...form, maxIdleDays: event.target.value }) }}
              />
            </div>
            <div className="dsha-rules-row">
              <span>{t('rules.perWorkspaceKeep')}</span>
              <input
                type="number" min={1} max={500}
                placeholder={t('rules.perWorkspaceKeepOff')}
                value={form.perWorkspaceKeep}
                onChange={event => { setForm({ ...form, perWorkspaceKeep: event.target.value }) }}
              />
            </div>
            <div className="dsha-rules-actions">
              <button type="button" className="dsha-drawer-btn" disabled={busy} onClick={() => { void saveRules() }}>
                {t('rules.save')}
              </button>
              <button type="button" className="dsha-drawer-btn" disabled={busy} onClick={() => { void runRules(true) }}>
                {t('rules.dryRun')}
              </button>
              <button
                type="button" className="dsha-drawer-btn"
                disabled={busy || !form.enabled}
                onClick={() => { void runRules(false) }}
              >
                {t('rules.runNow')}
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
