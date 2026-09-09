import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { loadSettings } from './settings'

// Budget governance — TS reimplementation of OpenMontage's cost-tracker concept.
// Lifecycle: reserve (with approval gates) → reconcile (record actual spend).
// Persisted to userData/cost-log.json.

export interface CostEntry {
  id: string
  tool: string
  operation: string
  status: 'reserved' | 'completed' | 'failed' | 'refunded'
  estimatedUsd: number
  actualUsd: number
  timestamp: number
}

interface CostLog {
  entries: CostEntry[]
}

function logPath(): string {
  return join(app.getPath('userData'), 'cost-log.json')
}

function loadLog(): CostLog {
  try {
    if (existsSync(logPath())) return JSON.parse(readFileSync(logPath(), 'utf-8'))
  } catch {
    /* ignore */
  }
  return { entries: [] }
}

function saveLog(log: CostLog): void {
  try {
    writeFileSync(logPath(), JSON.stringify(log, null, 2), 'utf-8')
  } catch {
    /* ignore */
  }
}

let counter = 0
function newId(): string {
  counter += 1
  return `c${Date.now().toString(36)}${counter}`
}

export interface BudgetState {
  totalUsd: number
  mode: 'observe' | 'warn' | 'cap'
  singleActionApprovalUsd: number
  spentUsd: number
  reservedUsd: number
  remainingUsd: number
  entries: CostEntry[]
}

export function budgetState(): BudgetState {
  const s = loadSettings()
  const log = loadLog()
  const spent = log.entries
    .filter((e) => e.status === 'completed' || e.status === 'failed')
    .reduce((a, e) => a + (e.actualUsd || 0), 0)
  const reserved = log.entries
    .filter((e) => e.status === 'reserved')
    .reduce((a, e) => a + (e.estimatedUsd || 0), 0)
  return {
    totalUsd: s.budgetTotalUsd,
    mode: s.budgetMode,
    singleActionApprovalUsd: s.singleActionApprovalUsd,
    spentUsd: +spent.toFixed(3),
    reservedUsd: +reserved.toFixed(3),
    remainingUsd: +(s.budgetTotalUsd - spent - reserved).toFixed(3),
    entries: log.entries.slice(-50)
  }
}

export interface ReserveResult {
  ok: boolean
  entryId?: string
  needApproval?: boolean
  blocked?: boolean
  reason?: string
}

export function budgetReserve(payload: {
  tool: string
  operation: string
  estimatedUsd: number
  approved?: boolean
}): ReserveResult {
  const s = loadSettings()
  const st = budgetState()
  const est = Math.max(0, payload.estimatedUsd || 0)

  if (s.budgetMode !== 'observe') {
    // Hard cap: block if it would exceed the remaining budget.
    if (s.budgetMode === 'cap' && est > st.remainingUsd) {
      return {
        ok: false,
        blocked: true,
        reason: `Estouraria o orçamento: custa $${est.toFixed(2)}, restam $${st.remainingUsd.toFixed(2)}.`
      }
    }
    // Per-action approval threshold.
    if (est > s.singleActionApprovalUsd && !payload.approved) {
      return {
        ok: false,
        needApproval: true,
        reason: `Ação de $${est.toFixed(2)} acima do limite de $${s.singleActionApprovalUsd.toFixed(2)} — confirme.`
      }
    }
  }

  const log = loadLog()
  const id = newId()
  log.entries.push({
    id,
    tool: payload.tool,
    operation: payload.operation,
    status: 'reserved',
    estimatedUsd: est,
    actualUsd: 0,
    timestamp: Date.now()
  })
  saveLog(log)
  return { ok: true, entryId: id }
}

// Refund reservations that never got reconciled (app crashed mid-generation).
// Anything still 'reserved' after `maxAgeMs` is considered orphaned — it stops
// eating into remainingUsd, but stays in the log (as 'refunded') for audit.
export function budgetCleanupStale(maxAgeMs = 6 * 60 * 60 * 1000): number {
  const log = loadLog()
  const cutoff = Date.now() - maxAgeMs
  let n = 0
  for (const e of log.entries) {
    if (e.status === 'reserved' && e.timestamp < cutoff) {
      e.status = 'refunded'
      n++
    }
  }
  if (n > 0) saveLog(log)
  return n
}

export function budgetReconcile(payload: { entryId: string; actualUsd: number; success: boolean }): BudgetState {
  const log = loadLog()
  const e = log.entries.find((x) => x.id === payload.entryId)
  if (e) {
    e.status = payload.success ? 'completed' : 'failed'
    e.actualUsd = Math.max(0, payload.actualUsd || 0)
    saveLog(log)
  }
  return budgetState()
}
