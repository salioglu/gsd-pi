// gsd-pi — Headless Recover entrypoint
/**
 * Headless Recover — `gsd headless recover`
 *
 * Non-interactive parallel of the `/gsd recover` slash command. Prints one
 * sealed markdown Preview, then applies it through the verified Import
 * Application boundary only after exact hash approval.
 *
 * Output: `gsd-recover: recovered <N>M/<N>S/<N>T hierarchy\n` to stderr on
 * successful assessment or completed action — the same marker emitted by
 * handleRecover (commands-maintenance.ts), so callers can distinguish that
 * path from a silent no-op.
 *
 * Exit codes:
 *   0 — assessment or the requested recovery action completed
 *   1 — Preview approval or Forward Repair choices are required, or setup/action failed
 */

import { createJiti } from '@mariozechner/jiti'
import { fileURLToPath } from 'node:url'
import { resolveGsdAgentExtensionsDir, shouldUseAgentExtensionsDir } from './headless-query.js'
import { resolveBundledGsdExtensionModule } from './bundled-resource-path.js'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { getJitiWorkspaceAliases } from './jiti-workspace-aliases.js'

const jiti = createJiti(fileURLToPath(import.meta.url), {
  alias: getJitiWorkspaceAliases(import.meta.url),
  interopDefault: true,
  debug: false,
})

const agentExtensionsDir = resolveGsdAgentExtensionsDir()
const { useAgentDir } = shouldUseAgentExtensionsDir({ env: process.env })
const gsdExtensionPath = (...segments: string[]) =>
  useAgentDir
    ? resolveAgentExtensionModule(agentExtensionsDir, segments)
    : resolveBundledGsdExtensionModule(import.meta.url, segments.join('/'))

function resolveAgentExtensionModule(agentDir: string, segments: string[]): string {
  const requested = join(agentDir, ...segments)
  if (existsSync(requested)) return requested
  if (segments.length === 1 && segments[0].endsWith('.ts')) {
    const jsPath = join(agentDir, segments[0].replace(/\.ts$/, '.js'))
    if (existsSync(jsPath)) return jsPath
  }
  return requested
}

function recoveryErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message
}

async function loadExtensionModules() {
  const workspaceModule = await jiti.import(gsdExtensionPath('db-workspace.ts'), {}) as typeof import('./resources/extensions/gsd/db-workspace.js')
  const orchestratorModule = await jiti.import(gsdExtensionPath('legacy-import-recovery-orchestrator.ts'), {}) as typeof import('./resources/extensions/gsd/legacy-import-recovery-orchestrator.js')
  const choiceTokenModule = await jiti.import(gsdExtensionPath('legacy-import-forward-repair-choice-token.ts'), {}) as typeof import('./resources/extensions/gsd/legacy-import-forward-repair-choice-token.js')
  const openWorkflowDatabase = workspaceModule.openWorkflowDatabase
  const closeWorkflowDatabase = workspaceModule.closeWorkflowDatabase
  const loadVerifiedRecoverApplication = workspaceModule.loadVerifiedRecoverApplication
  const executeLegacyImportRecovery = orchestratorModule.executeLegacyImportRecovery
  const validateLegacyImportRecoveryRequest = orchestratorModule.validateLegacyImportRecoveryRequest
  const formatLegacyImportForwardRepairChoice = choiceTokenModule.formatLegacyImportForwardRepairChoice
  if (typeof openWorkflowDatabase !== 'function') {
    throw new Error('selected GSD extensions do not support workflow database recovery; synchronize the extension bundle')
  }
  if (typeof closeWorkflowDatabase !== 'function') {
    throw new Error('selected GSD extensions do not support workflow database closeout; synchronize the extension bundle')
  }
  if (typeof loadVerifiedRecoverApplication !== 'function') {
    throw new Error('selected GSD extensions do not support retained Import Application recovery; synchronize the extension bundle')
  }
  if (typeof executeLegacyImportRecovery !== 'function'
    || typeof validateLegacyImportRecoveryRequest !== 'function') {
    throw new Error('selected GSD extensions do not support executable recovery actions; synchronize the extension bundle')
  }
  if (typeof formatLegacyImportForwardRepairChoice !== 'function') {
    throw new Error('selected GSD extensions do not support recovery choice tokens; synchronize the extension bundle')
  }
  return {
    openWorkflowDatabase: openWorkflowDatabase as (basePath: string) => { ok: boolean },
    closeWorkflowDatabase: closeWorkflowDatabase as () => void,
    loadVerifiedRecoverApplication,
    executeLegacyImportRecovery,
    validateLegacyImportRecoveryRequest,
    formatLegacyImportForwardRepairChoice,
  }
}

export interface RecoverResult {
  exitCode: number
}

export async function handleRecover(
  basePath: string,
  args: readonly string[] = [],
): Promise<RecoverResult> {
  const gsdDir = join(basePath, '.gsd')
  if (!existsSync(gsdDir)) {
    process.stderr.write(`[headless] recover: no .gsd/ directory at ${basePath}\n`)
    return { exitCode: 1 }
  }

  let modules: Awaited<ReturnType<typeof loadExtensionModules>>
  try {
    modules = await loadExtensionModules()
  } catch (err) {
    const msg = recoveryErrorMessage(err)
    process.stderr.write(`[headless] recover: failed to load extension modules: ${msg}\n`)
    return { exitCode: 1 }
  }

  try {
    modules.validateLegacyImportRecoveryRequest(args.join(' '))
  } catch (error) {
    const message = recoveryErrorMessage(error)
    const prefix = /choice token/iu.test(message)
      ? '[headless] recover: malformed --choice token: '
      : '[headless] recover: '
    process.stderr.write(`${prefix}${message}\n`)
    return { exitCode: 1 }
  }

  const opened = modules.openWorkflowDatabase(basePath)
  if (!opened.ok) {
    process.stderr.write(`[headless] recover: failed to open or create the GSD database at ${basePath}\n`)
    return { exitCode: 1 }
  }
  try {
  let execution: NonNullable<Awaited<ReturnType<typeof modules.executeLegacyImportRecovery>>>
  try {
    const result = await modules.executeLegacyImportRecovery({
      basePath,
      args: args.join(' '),
      approvePrepared: async (prepared, approvedPreviewHash) => {
      if (approvedPreviewHash !== prepared.preview.preview_hash) {
        process.stderr.write(`[headless] recover: ${prepared.authorizationText}\n`)
        process.stderr.write(
          `[headless] recover: import not applied; re-run with --preview=${prepared.preview.preview_hash}\n`,
        )
          return false
      }
        return true
      },
    })
    if (!result) return { exitCode: 1 }
    execution = result
  } catch (err) {
    const msg = recoveryErrorMessage(err)
    process.stderr.write(`[headless] recover failed: ${msg}\n`)
    return { exitCode: 1 }
  }
  const { application, recoveryAction } = execution
  process.stderr.write(
    `[headless] recover: verified backup and restore rehearsal completed at ${application.backup.backup_ref}\n`,
  )
  if (recoveryAction.status === 'choice-required') {
    for (const choice of recoveryAction.choices ?? []) {
      process.stderr.write(
        `[headless] recover: review target ${choice.instructionIndex}:${choice.targetKind}:${choice.targetKey}; `
          + `reason ${choice.reasonCode}, evidence ${choice.reviewHash}; `
          + `current canonical value ${choice.currentValueJson}; proposed backup mutation ${choice.proposedMutationJson}; `
          + `recommended ${choice.recommendedDecision} because ${choice.recommendationRationale}; use `
          + `--application=${application.receipt.operationId} --forward-repair `
          + `${modules.formatLegacyImportForwardRepairChoice(choice, 'preserve-later')} or `
          + `--application=${application.receipt.operationId} --forward-repair `
          + `${modules.formatLegacyImportForwardRepairChoice(choice, 'restore-backup')}\n`,
      )
    }
    return { exitCode: 1 }
  }
  if (recoveryAction.status === 'restored' || recoveryAction.status === 'forward-repaired') {
    process.stderr.write(
      `[headless] recover: ${recoveryAction.status} (${recoveryAction.result?.status ?? 'unknown'})\n`,
    )
  } else {
    const assessment = recoveryAction.assessment!
    process.stderr.write(
      `[headless] recover: ${assessment.recommendation.recommendationText} `
        + `Application ${application.receipt.applicationIdentityHash}; use retained Application operation ${application.receipt.operationId}.\n`,
    )
    if (assessment.decision === 'restore-consent-required') {
      process.stderr.write(
        `[headless] recover: --application=${application.receipt.operationId} --restore `
          + `--consent=proceed:destructive-database-restore:${assessment.evidenceHash}\n`,
      )
    } else if (assessment.decision === 'forward-repair-required') {
      process.stderr.write(
        `[headless] recover: --application=${application.receipt.operationId} --forward-repair\n`,
      )
    } else if (assessment.decision === 'already-restored') {
      process.stderr.write(
        '[headless] recover: retained Application is already restored; no further recovery action is required.\n',
      )
    } else {
      // Fail closed: a refused (or otherwise non-actionable) assessment is not
      // a successful recovery — no `gsd-recover: recovered` marker, non-zero exit.
      process.stderr.write(
        `[headless] recover: assessment '${assessment.decision}' (${assessment.reasonCode}); no recovery action was taken.\n`,
      )
      return { exitCode: 1 }
    }
  }

  const completedApplication = recoveryAction.status === 'restored' || recoveryAction.status === 'forward-repaired'
    ? modules.loadVerifiedRecoverApplication(application.receipt.operationId)
    : application
  const { counts } = completedApplication
  process.stderr.write(
    `gsd-recover: recovered ${counts.milestones}M/${counts.slices}S/${counts.tasks}T hierarchy\n`,
  )
  return { exitCode: 0 }
  } finally {
    modules.closeWorkflowDatabase()
  }
}
