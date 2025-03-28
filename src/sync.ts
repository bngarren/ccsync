import { watch } from "chokidar"
import path from "node:path"
import type { Config } from "./config"
import {
  type Computer,
  createTypedEmitter,
  type ManualSyncEvents,
  type WatchSyncEvents,
  SyncEvent,
  type ResolvedFileRule,
  type ComputerSyncResult,
  SyncMode,
  SyncStatus,
  type BaseControllerEvents,
  type SyncOperationResult,
  type Result,
  ResultStatus,
  failure,
  ok,
  type SyncToComputerResult,
  partial,
  isOk,
  okVoid,
  partialVoid,
  isFailure,
} from "./types"
import {
  validateMinecraftSave,
  findMinecraftComputers,
  resolveSyncRules,
  copyFilesToComputer,
  pluralize,
  resolveTargetPath,
  processPath,
  filterFilesOnly,
  getRelativePath,
  checkDuplicateTargetPaths,
} from "./utils"
import { KeyHandler } from "./keys"
import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { setTimeout } from "node:timers"
import { glob } from "glob"
import {
  AppError,
  ErrorSeverity,
  getErrorMessage,
  type IAppError,
} from "./errors"
import { UI, UIMessageType } from "./ui"
import {
  createEmptySyncPlan,
  createSyncPlanIssue,
  SyncPlanIssueCategory,
  SyncPlanIssueSeverity,
  type SyncPlan,
} from "./syncplan"
import { getLogger } from "./log"
import type pino from "pino"
import NodeCache from "node-cache"
import crypto from "crypto"
import { clearGlobCache } from "./cache"
import { PROCESS_CHANGES_DELAY } from "./constants"

export enum SyncManagerState {
  IDLE,
  STARTING,
  RUNNING,
  STOPPING,
  STOPPED,
  ERROR,
}

/**
 * Utility function to display sync plan issues in the UI
 */
function displaySyncPlanIssues(
  syncPlan: SyncPlan,
  ui: UI | null,
  log: pino.Logger
): void {
  if (!ui) return

  // Display errors
  syncPlan.issues
    .filter((issue) => issue.severity === SyncPlanIssueSeverity.ERROR)
    .forEach((issue) => {
      ui.addMessage(UIMessageType.ERROR, issue.message, issue.suggestion)
      log.error({ issue }, `sync plan error`)
    })

  // Display warnings
  syncPlan.issues
    .filter((issue) => issue.severity === SyncPlanIssueSeverity.WARNING)
    .forEach((issue) => {
      ui.addMessage(UIMessageType.WARNING, issue.message, issue.suggestion)
      log.warn({ issue }, `sync plan warning`)
    })
}

/**
 * Utility function to extract error messages from sync plan issues
 */
function getSyncPlanErrorMessage(syncPlan: SyncPlan): string {
  return syncPlan.issues
    .filter((issue) => issue.severity === SyncPlanIssueSeverity.ERROR)
    .map((issue) => issue.message)
    .join(", ")
}

export class SyncManager {
  private _logger: pino.Logger | null = null
  private get log() {
    if (!this._logger) {
      this._logger = getLogger().child({ component: "SyncManager" })
    }
    return this._logger
  }

  private activeModeController:
    | ManualModeController
    | WatchModeController
    | null = null

  private syncPlanCache: NodeCache

  private error: IAppError | null = null

  // STATE
  private state: SyncManagerState = SyncManagerState.IDLE
  private setState(newState: SyncManagerState) {
    const oldState = this.state
    this.state = newState
    this.log.trace(
      `State transition: ${SyncManagerState[oldState]} → ${SyncManagerState[newState]}`
    )

    if (newState === SyncManagerState.ERROR) {
      // Perform emergency cleanup/logging
      this.stop().catch((err: unknown) => {
        this.log.error(
          `Failed to gracefully stop after ERROR state: ${getErrorMessage(err)}`
        )
      })
    }
  }

  private setErrorState(error?: unknown) {
    if (error instanceof AppError) {
      this.error = error
    } else {
      this.error = AppError.from(error, { severity: ErrorSeverity.FATAL })
    }
    this.setState(SyncManagerState.ERROR)
  }

  constructor(
    private config: Config,
    private ui: UI
  ) {
    // Initialize the sync plan cache with settings from config
    this.syncPlanCache = new NodeCache({
      // PERF: Not sure what best TTL is here...
      stdTTL: Math.floor(this.config.advanced.cacheTTL / 1000), // Convert to seconds
      checkperiod: 120, // Check for expired keys every 2 minutes
      useClones: false, // Don't clone values - we want to share references
    })
  }

  // Public state query methods
  public isRunning(): boolean {
    return this.state === SyncManagerState.RUNNING
  }

  public isStarting(): boolean {
    return this.state === SyncManagerState.STARTING
  }

  public isStopped(): boolean {
    return this.state === SyncManagerState.STOPPED
  }

  public getError(): IAppError | null {
    return this.error
  }

  public getState(): SyncManagerState {
    return this.state
  }

  /*
    Cache management
   The benefit of caching is to optimize for repeated manual syncs or file changes, where most of the system state (computers, directory structure, config) remains the same across operations
  */

  /**
   * Creates a cache key based on the input files
   * For full plans (no changed files), uses a standard key
   * For partial plans, creates a hash of the file paths
   */
  private createCacheKey(changedFiles?: Set<string>): string {
    // For full plan with no changed files, use a consistent key
    if (!changedFiles || changedFiles.size === 0) {
      return "syncPlan:full"
    }

    // For partial plans, create a hash of the sorted file paths
    const sortedPaths = [...changedFiles].sort().join("|")
    const hash = crypto.createHash("md5").update(sortedPaths).digest("hex")
    return `syncPlan:partial:${hash}`
  }

  public invalidateCache(reason?: string): void {
    this.log.trace(`Sync plan cache invalidated${reason ? `: ${reason}` : ""}`)
    this.syncPlanCache.flushAll()

    clearGlobCache()
    this.log.trace(`Glob cache cleared`)
  }

  /**
   * Creates a sync plan that maps source files to target computers
   * This replaces the old runValidation method with a more structured approach
   */
  public async createSyncPlan(options?: {
    forceRefresh?: boolean
    changedFiles?: Set<string>
  }): Promise<SyncPlan> {
    const { forceRefresh = false, changedFiles } = options || {}

    // Determine the cache key based on changed files
    const cacheKey = this.createCacheKey(changedFiles)

    // Check cache first (unless forced refresh)
    if (!forceRefresh) {
      const cachedPlan = this.syncPlanCache.get<SyncPlan>(cacheKey)
      if (cachedPlan) {
        this.log.trace({ cacheKey }, "createSyncPlan > Cache hit")
        return cachedPlan
      }
    }

    this.log.trace({ cacheKey }, "createSyncPlan > Cache miss")

    // Performance tracking
    const createSyncPlanStartTime = process.hrtime.bigint()

    // Create a base sync plan
    const plan = createEmptySyncPlan()

    try {
      // Step 1: Validate save directory
      try {
        const saveDirValidation = await validateMinecraftSave(
          this.config.minecraftSavePath
        )

        if (!saveDirValidation.isValid) {
          // Add save directory issues to the plan
          saveDirValidation.errors.forEach((error) => {
            plan.issues.push(
              createSyncPlanIssue(
                error,
                SyncPlanIssueCategory.SAVE_DIRECTORY,
                SyncPlanIssueSeverity.ERROR,
                {
                  source: "validateMinecraftSave",
                  suggestion: `Ensure this is a valid Minecraft save at '${saveDirValidation.savePath}' and that a 'computercraft/computer' directory exists`,
                }
              )
            )
          })

          if (saveDirValidation.missingFiles.length > 0) {
            plan.issues.push(
              createSyncPlanIssue(
                `Missing files in save directory: ${saveDirValidation.missingFiles.join(", ")}`,
                SyncPlanIssueCategory.SAVE_DIRECTORY,
                SyncPlanIssueSeverity.WARNING,
                {
                  source: "validateMinecraftSave",
                  suggestion: `Ensure this is a valid Minecraft at '${saveDirValidation.savePath}'`,
                }
              )
            )
          }

          plan.isValid = false
          this.invalidateCache("Minecraft save directory is invalid")
          return plan
        }
      } catch (err) {
        plan.issues.push(
          createSyncPlanIssue(
            `Failed to validate save directory: ${getErrorMessage(err)}`,
            SyncPlanIssueCategory.SAVE_DIRECTORY,
            SyncPlanIssueSeverity.ERROR,
            { source: "createSyncPlan" }
          )
        )
        plan.isValid = false
        this.invalidateCache("Could not validate Minecraft save directory")
        return plan
      }

      // Step 2: Discover computers
      let computers: Computer[] = []
      try {
        computers = await findMinecraftComputers(this.config.minecraftSavePath)

        this.log.info(
          {
            computers: computers.map((c) => ({ [c.id]: c.shortPath })),
            saveDir: this.config.minecraftSavePath,
          },
          `Found ${computers.length} Minecraft ${pluralize("computer")(computers.length)} in save directory`
        )

        if (computers.length === 0) {
          plan.issues.push(
            createSyncPlanIssue(
              "No computers found in the save directory",
              SyncPlanIssueCategory.COMPUTER,
              SyncPlanIssueSeverity.WARNING,
              {
                source: "findMinecraftComputers",
                suggestion:
                  "Ensure CC: Tweaked computers are present in the world. Sometimes adding a dummy file to the in-game computer helps.",
              }
            )
          )
          this.invalidateCache(
            "No computers found in the Minecraft save directory"
          )
        }
      } catch (err) {
        plan.issues.push(
          createSyncPlanIssue(
            `Failed to find computers: ${err instanceof Error ? err.message : String(err)}`,
            SyncPlanIssueCategory.COMPUTER,
            SyncPlanIssueSeverity.ERROR,
            { source: "createSyncPlan" }
          )
        )
        plan.isValid = false
        this.invalidateCache(
          "Failed to find computers in Minecraft save directory"
        )
        return plan
      }

      // Step 3: Get changed files from watch mode if applicable
      const changedFiles =
        this.activeModeController instanceof WatchModeController
          ? this.activeModeController.getChangedFiles()
          : undefined

      // Step 4: Resolve sync rules
      try {
        const resolved = await resolveSyncRules(
          this.config,
          computers,
          changedFiles
        )

        if (resolved.missingComputerIds.length > 0) {
          this.log.warn(
            `missing computers: ${resolved.missingComputerIds.join(" , ")}`
          )
        }

        // Add resolved files to the plan
        plan.resolvedFileRules = resolved.resolvedFileRules
        plan.availableComputers = resolved.availableComputers
        plan.missingComputerIds = resolved.missingComputerIds

        // Add any errors as issues
        if (resolved.errors.length > 0) {
          resolved.errors.forEach((error) => {
            // Determine if this is a fatal error or just a warning
            // Errors about missing files are warnings, configuration issues are errors
            const isFatal =
              error.includes("cannot be accessed") ||
              error.includes("Invalid pattern") ||
              error.includes("Permission denied")

            plan.issues.push(
              createSyncPlanIssue(
                error,
                SyncPlanIssueCategory.RULE,
                isFatal
                  ? SyncPlanIssueSeverity.ERROR
                  : SyncPlanIssueSeverity.WARNING,
                { source: "resolveSyncRules" }
              )
            )
          })
          this.invalidateCache("There were errors with resolved file rules")
        }

        // Add missing computers as warnings
        const missing = resolved.missingComputerIds
        if (missing.length > 0) {
          plan.issues.push(
            createSyncPlanIssue(
              `Missing computers: ${missing.join(", ")}`,
              SyncPlanIssueCategory.COMPUTER,
              SyncPlanIssueSeverity.WARNING,
              {
                source: "resolveSyncRules",
                suggestion: `${missing.length > 1 ? "These" : "This"} ${pluralize("computer")(missing.length)} ${missing.length > 1 ? "were" : "was"} referenced in rules but not found in the save directory`,
              }
            )
          )
        }

        // Step 5: Check for duplicate target paths
        const duplicateTargets = checkDuplicateTargetPaths(
          plan.resolvedFileRules
        )

        if (duplicateTargets.size > 0) {
          // Add warnings for duplicate targets
          for (const [targetKey, rules] of duplicateTargets.entries()) {
            const [computerId, targetPath] = targetKey.split(":", 2)
            const sourceFiles = rules
              .map((r) =>
                getRelativePath(r.sourceAbsolutePath, this.config.sourceRoot, {
                  includeRootName: true,
                })
              )
              .join(", ")

            plan.issues.push(
              createSyncPlanIssue(
                `Multiple source files (${sourceFiles}) target the same path "${targetPath}" on computer ${computerId}`,
                SyncPlanIssueCategory.RULE,
                SyncPlanIssueSeverity.WARNING,
                {
                  source: "checkDuplicateTargets",
                  suggestion:
                    "Review your sync rules to avoid conflicts. Only the last synced file will be kept when multiple files target the same destination.",
                }
              )
            )
          }
        }
      } catch (err) {
        plan.issues.push(
          createSyncPlanIssue(
            `Failed to resolve sync rules: ${err instanceof Error ? err.message : String(err)}`,
            SyncPlanIssueCategory.RULE,
            SyncPlanIssueSeverity.ERROR,
            { source: "createSyncPlan" }
          )
        )
        plan.isValid = false
        this.invalidateCache("Failed to resolve sync rules")
        return plan
      }

      // Determine if the plan is valid (no ERROR severity issues)
      plan.isValid = !plan.issues.some(
        (issue) => issue.severity === SyncPlanIssueSeverity.ERROR
      )

      // Cache successful plan
      if (plan.isValid) {
        // Update the timestamp before caching
        plan.timestamp = Date.now()

        // Cache the plan with the computed key
        this.syncPlanCache.set(cacheKey, plan)
      }

      // Performance tracking
      const endTime = process.hrtime.bigint()
      const duration = Number(endTime - createSyncPlanStartTime) / 1_000_000 // Convert to ms

      this.log.debug(
        {
          planCreationTime: duration,
          filesCount: plan.resolvedFileRules.length,
          computersCount: plan.availableComputers.length,
          valid: plan.isValid,
        },
        `SyncPlan created (${duration} ms)`
      )

      return plan
    } catch (err) {
      // Handle unexpected errors
      plan.issues.push(
        createSyncPlanIssue(
          `Unexpected error creating sync plan: ${err instanceof Error ? err.message : String(err)}`,
          SyncPlanIssueCategory.OTHER,
          SyncPlanIssueSeverity.ERROR,
          { source: "createSyncPlan" }
        )
      )
      plan.isValid = false
      this.invalidateCache("Unexpected error creating sync plan")
      return plan
    }
  }

  /**
   * 'skippedFiles' come from the copyFilesToComputer operation and may be due to security violations or source files not found
   */
  private async syncToComputer(
    computer: Computer,
    fileRules: ResolvedFileRule[]
  ): Promise<Result<SyncToComputerResult>> {
    const result: SyncToComputerResult = {
      computerId: computer.id,
      copiedFiles: [],
      skippedFiles: [],
    }
    const filesToCopy = fileRules.filter((file) =>
      file.computers.includes(computer.id)
    )

    if (filesToCopy.length === 0) {
      this.log.warn(`syncToComputer called with 0 files to copy!`)
      return ok(result)
    }

    this.log.debug(
      {
        computerPath: computer.shortPath,
        numberOfFiles: filesToCopy.length,
      },
      `starting copy of files to computer ${computer.id}`
    )

    const copyResult = await copyFilesToComputer(filesToCopy, computer.path)
    await setTimeoutPromise(25) // Small delay between computers

    this.log.info(
      copyResult,
      `finished copying files to computer ${computer.id}.`
    )
    if (copyResult.status === ResultStatus.FAILURE) {
      // Local handling of syncToComputer failure
      this.log.error(
        { computer, errors: copyResult.errors },
        `syncToComputer failed with errors`
      )
      return failure(copyResult.errors)
    }

    result.copiedFiles = copyResult.value.copiedFiles
    result.skippedFiles = copyResult.value.skippedFiles

    if (copyResult.status === ResultStatus.PARTIAL) {
      // Local handling of syncToComputer partial errors
      this.log.error(
        { computer, errors: copyResult.errors },
        `syncToComputer proceeded with errors`
      )
      return partial(result, copyResult.errors)
    }

    return ok(result)
  }

  public async performSync(
    syncPlan: SyncPlan
  ): Promise<Result<SyncOperationResult>> {
    // throw exception here as this is bad state
    if (this.state !== SyncManagerState.RUNNING) {
      throw AppError.fatal(
        "Cannot perform sync when not in RUNNING state",
        "SyncManager.performSync"
      )
    }

    const computerResults: ComputerSyncResult[] = []
    const allComputerIds = new Set<string>()
    // A set of available computer IDs for faster lookup
    const availableComputerIds = new Set(
      syncPlan.availableComputers.map((c) => c.id)
    )

    // - - - - - Warnings - - - - -
    // We accumulate warnings from both the syncPlan's issues that were identified during sync plan creation
    // and from the running of this performSync operation
    let warnings = 0
    const planWarnings = syncPlan.issues.filter(
      (issue) => issue.severity === SyncPlanIssueSeverity.WARNING
    ).length

    if (planWarnings > 0) {
      warnings += planWarnings
      this.log.debug(
        `Including ${planWarnings} warnings from sync plan in operation status`
      )
    }

    /** Errors during performSync operation */
    const errors: AppError[] = []

    let totalAttemptedFiles = 0

    // First create entries for all computers
    for (const fileRule of syncPlan.resolvedFileRules) {
      for (const computerId of fileRule.computers) {
        // Create computer if it doesn't exist yet
        if (!allComputerIds.has(computerId)) {
          allComputerIds.add(computerId)

          // Check if this is a missing computer
          const isExisting = availableComputerIds.has(computerId)

          computerResults.push({
            computerId,
            exists: isExisting,
            files: [],
            successCount: 0,
            failureCount: 0,
          })
        }

        // Get the pre-made computerResult entry
        const computerResult = computerResults.find(
          (cr) => cr.computerId === computerId
        )

        if (!computerResult) {
          this.invalidateCache(
            "Missing a pre-made computer result for a synced computer"
          )
          errors.push(
            AppError.fatal(
              `A pre-made computer result was not found for computerId: ${computerId}`,
              "performSync"
            )
          )
        } else {
          // Prepare target path based on target type
          const targetPath = resolveTargetPath(fileRule)

          // Add file entry with explicit type information
          computerResult.files.push({
            targetPath,
            sourcePath: fileRule.sourceAbsolutePath,
            success: false, // Mark all as unsuccessful initially
          })
          totalAttemptedFiles++
        }
      }
    }

    // If any fatal errors from above, exit early (bad state)
    if (errors.some((error) => error.severity === ErrorSeverity.FATAL)) {
      return failure(errors)
    }

    /**
     * Execute the actual sync operation for each available computer:
     * 1. Copy the files to each computer according to resolved rules
     * 2. Track successful and failed file transfers
     * 3. Update UI with results for each computer
     * 4. Aggregate results to determine overall sync status
     *
     * This is the core synchronization process where file transfers actually occur
     * and success/failure is determined for the operation.
     */
    for (const computer of syncPlan.availableComputers) {
      const syncToComputerResult = await this.syncToComputer(
        computer,
        syncPlan.resolvedFileRules
      )

      // If a failure occured during syncToComputer, exit early. This may limit corrupted/bad copiedFiles
      // to other computers
      if (syncToComputerResult.status === ResultStatus.FAILURE) {
        this.log.error(
          { computer },
          `performSync aborted early due to syncToComputer failure`
        )
        return failure(syncToComputerResult.errors)
      } else if (
        // If syncToComputerResult was PARTIALLY successful, then consolidate these non-fatal errors into current errors array
        syncToComputerResult.status === ResultStatus.PARTIAL
      ) {
        const syncToComputerErrors = syncToComputerResult.errors.map(
          (e) => e.message
        )
        errors.push(
          new AppError(
            `Error copying files to computer ID ${syncToComputerResult.value.computerId}`,
            ErrorSeverity.ERROR,
            "performSync",
            undefined,
            `There was an error encountered when copying files to computer ID ${syncToComputerResult.value.computerId}`,
            { errors: syncToComputerErrors }
          )
        )
      } else {
        // syncToComputerResult === OK
        this.log.debug(
          {
            copiedFiles: syncToComputerResult.value.copiedFiles,
            skippedFiles: syncToComputerResult.value.skippedFiles,
          },
          `Completed sync with computer ID ${syncToComputerResult.value.computerId}`
        )
      }

      // Now that syncing is finished, we organize the results into summary object

      // Find this computer in our results array
      const computerResult = computerResults.find(
        (cr) => cr.computerId === computer.id
      )
      if (!computerResult) continue // Should never happen but TypeScript needs this check

      // Process all copied files (successes)
      for (const filePath of syncToComputerResult.value.copiedFiles) {
        // Process ALL rules that match this file
        const matchingRules = syncPlan.resolvedFileRules.filter(
          (rule) =>
            rule.sourceAbsolutePath === filePath &&
            rule.computers.includes(computer.id)
        )

        for (const rule of matchingRules) {
          const targetPath = resolveTargetPath(rule)

          // Find and update the file entry
          const fileEntries = computerResult.files.filter(
            (f) => f.targetPath === targetPath && f.sourcePath === filePath
          )

          for (const fileEntry of fileEntries) {
            fileEntry.success = true
            computerResult.successCount++
          }
        }
      }

      // Handle non-fatal errors. Fatal errors should have been recognized/handled above
      if (errors.length > 0) {
        // Report each error to the UI
        errors.forEach((error) => {
          this.ui.addMessage(
            UIMessageType.ERROR,
            `Error copying to computer ${computer.id}: ${error.getDisplayMessage()}`
          )
        })

        this.invalidateCache(
          `${pluralize("Error")(errors.length)} in the sync result`
        )
      }

      // Handle skipped files as warnings
      const skippedFiles = syncToComputerResult.value.skippedFiles

      if (skippedFiles.length > 0) {
        const skipMessage = `Skipped ${skippedFiles.length} file(s) for computer ${computer.id}`

        warnings++

        // Update computer failure count
        computerResult.failureCount += skippedFiles.length

        this.ui.addMessage(UIMessageType.WARNING, skipMessage)
      }

      // Update computer success/failure counts
      computerResult.successCount = computerResult.files.filter(
        (f) => f.success
      ).length
      computerResult.failureCount =
        computerResult.files.length - computerResult.successCount
    } // end "for const computer of syncPlan.availableComputers"

    // Calculate summary statistics
    const summary = {
      totalFiles: totalAttemptedFiles,
      successfulFiles: computerResults.reduce(
        (sum, cr) => sum + cr.successCount,
        0
      ),
      failedFiles: computerResults.reduce(
        (sum, cr) => sum + cr.failureCount,
        0
      ),
      totalComputers: allComputerIds.size,
      fullySuccessfulComputers: computerResults.filter(
        (cr) => cr.exists && cr.files.length > 0 && cr.failureCount === 0
      ).length,
      partiallySuccessfulComputers: computerResults.filter(
        (cr) => cr.exists && cr.successCount > 0 && cr.failureCount > 0
      ).length,
      failedComputers: computerResults.filter(
        (cr) => cr.exists && cr.files.length > 0 && cr.successCount === 0
      ).length,
      missingComputers: syncPlan.missingComputerIds.length,
    } as SyncOperationResult["summary"]

    // Determine overall operation status
    let status = SyncStatus.SUCCESS

    if (summary.totalFiles === 0) {
      status = SyncStatus.WARNING
    } else if (summary.successfulFiles === 0 && summary.failedFiles > 0) {
      status = SyncStatus.ERROR
    } else if (summary.failedFiles > 0) {
      status = SyncStatus.PARTIAL
    } else if (warnings > 0 || summary.missingComputers > 0) {
      status = SyncStatus.WARNING
    }

    let result: Result<SyncOperationResult>
    const operationResult = {
      status,
      timestamp: Date.now(),
      summary,
      computerResults,
    }
    if (status === SyncStatus.SUCCESS) {
      result = ok(operationResult)
    } else if (status === SyncStatus.ERROR) {
      result = failure(errors)
    } else {
      result = partial(operationResult, errors)
    }

    this.log.info(
      {
        totalFiles: totalAttemptedFiles,
        totalComputers: allComputerIds.size,
        abbrComputerResults: computerResults.map((cr) => {
          return {
            computerId: cr.computerId,
            exists: cr.exists,
            files: {
              planned: cr.files.length,
              successful: cr.successCount,
            },
          }
        }),
        status,
      },
      "performSync completed"
    )

    if (isFailure(result)) {
      this.ui.writeMessages()
      return failure(errors)
    }

    // Update UI with final results
    this.ui.updateOperationStats({
      totalFiles: totalAttemptedFiles,
      totalComputers: allComputerIds.size,
    })
    this.ui.updateComputerResults(computerResults)

    this.ui.completeOperation(result.value)

    return result
  }

  initManualMode(): {
    controller: ManualModeController
    start: () => void
  } {
    if (this.state !== SyncManagerState.IDLE) {
      // throw error directly, this is a programming error
      throw AppError.fatal(
        `Cannot start manual mode in state: ${SyncManagerState[this.state]}`,
        "SyncManager"
      )
    }

    try {
      this.ui.setMode(SyncMode.MANUAL)
      const manualController = new ManualModeController(this, this.ui)
      this.activeModeController = manualController

      // Listen for controller state changes
      manualController.on(SyncEvent.STARTED, () => {
        this.setState(SyncManagerState.RUNNING)
        this.log.trace("manualController SyncEvent.STARTED")
        this.ui.start()
      })

      // The controller has already stopped
      manualController.on(SyncEvent.STOPPED, () => {
        this.setState(SyncManagerState.STOPPED)
        this.log.trace("manualController SyncEvent.STOPPED")
        this.ui.stop()
      })

      // High level controller functions should emit a SYNC_ERROR when they catch thrown errors from subordinate functions
      // eslint-disable-next-line n/handle-callback-err
      manualController.on(SyncEvent.SYNC_ERROR, (error) => {
        // Handle based on severity
        // if (error.severity === ErrorSeverity.FATAL) {
        //   this.log.fatal(error, "MANUAL mode")
        //   this.setErrorState(error)
        // } else {
        //   this.log.error(error, "MANUAL mode")
        //   // continue operations
        // }
      })

      const manualControllerStart = () => {
        this.setState(SyncManagerState.STARTING)

        manualController.run().catch((error: unknown) => {
          // Fatal error from run
          this.setErrorState(error)

          this.log.error({ error }, "fatal exception during run")

          this.stop().catch((err: unknown) => {
            throw AppError.from(err, {
              defaultMessage: "Unexpected error stopping",
              severity: ErrorSeverity.FATAL,
              source: "SyncManager",
            })
          })
        })
      }

      return {
        controller: manualController,
        start: manualControllerStart.bind(this),
      }
    } catch (error) {
      const appError = AppError.from(error, {
        severity: ErrorSeverity.FATAL,
        source: "SyncManager",
      })
      this.setErrorState(appError)
      throw appError
    }
  }

  initWatchMode(): {
    controller: WatchModeController
    start: () => void
  } {
    if (this.state !== SyncManagerState.IDLE) {
      // throw error directly, this is a programming error
      throw AppError.fatal(
        `Cannot start watch mode in state: ${SyncManagerState[this.state]}`,
        "SyncManager"
      )
    }

    try {
      this.ui.setMode(SyncMode.WATCH)

      const watchController = new WatchModeController(
        this,
        this.config,
        this.ui
      )
      this.activeModeController = watchController

      // Listen for controller state changes
      watchController.on(SyncEvent.STARTED, () => {
        this.setState(SyncManagerState.RUNNING)
        this.log.trace("watchController SyncEvent.STARTED")
        this.ui.start()
      })

      watchController.on(SyncEvent.STOPPED, () => {
        this.setState(SyncManagerState.STOPPED)
        this.log.trace("watchController SyncEvent.STOPPED")
        this.ui.stop()
      })

      // eslint-disable-next-line n/handle-callback-err
      watchController.on(SyncEvent.SYNC_ERROR, (error) => {
        // Handle based on severity
        // if (error.severity === ErrorSeverity.FATAL) {
        //   this.log.fatal(error, "WATCH mode")
        //   this.setErrorState(error)
        // } else {
        //   this.log.error(error, "WATCH mode")
        //   // continue operations
        // }
      })

      const watchControllerStart = () => {
        this.setState(SyncManagerState.STARTING)

        watchController.run().catch((error: unknown) => {
          // Fatal error from run
          this.setErrorState(error)

          this.log.error({ error }, "fatal exception during run")

          this.stop().catch((err: unknown) => {
            throw AppError.from(err, {
              defaultMessage: "Unexpected error stopping",
              severity: ErrorSeverity.FATAL,
              source: "SyncManager",
            })
          })
        })
      }

      return {
        controller: watchController,
        start: watchControllerStart.bind(this),
      }
    } catch (error) {
      const appError = AppError.from(error, {
        severity: ErrorSeverity.FATAL,
        source: "SyncManager",
      })
      this.setErrorState(appError)
      throw appError
    }
  }

  /**
   * Stops the controller and UI
   */
  async stop(): Promise<void> {
    if (
      this.state === SyncManagerState.STOPPED ||
      this.state === SyncManagerState.STOPPING
    )
      return
    this.setState(SyncManagerState.STOPPING)

    try {
      this.ui.stop()

      if (this.activeModeController) {
        await this.activeModeController.stop()
        this.activeModeController = null
      }
      this.setState(SyncManagerState.STOPPED)
    } catch (error) {
      const appError = AppError.from(error, {
        severity: ErrorSeverity.FATAL,
        source: "SyncManager.stop",
      })
      this.setErrorState(appError)
      throw appError
    }
  }
}

/**
 * Base controller for common functionality between manual and watch modes
 */
abstract class BaseController<T extends BaseControllerEvents> {
  private _logger: pino.Logger | null = null
  protected get log() {
    if (!this._logger) {
      this._logger = getLogger().child({ component: "Controller" })
    }
    return this._logger
  }
  protected events = createTypedEmitter<T>()
  protected keyHandler: KeyHandler | null = null

  constructor(
    protected syncManager: SyncManager,
    protected ui: UI | null = null
  ) {
    this.cleanup = this.cleanup.bind(this)
    Object.defineProperty(this, "cleanup", {
      writable: false, // Prevents reassigning in subclass
      configurable: false, // Prevents deletion or redefinition
    })
  }

  emit<K extends keyof T>(
    event: K,
    data?: T[K] extends undefined ? never : T[K]
  ) {
    return this.events.emit(event, data)
  }

  on<K extends keyof T>(
    event: K,
    listener: T[K] extends undefined ? () => void : (data: T[K]) => void
  ) {
    this.events.on(event, listener)
  }

  once<K extends keyof T>(
    event: K,
    listener: T[K] extends undefined ? () => void : (data: T[K]) => void
  ) {
    this.events.once(event, listener)
  }

  off<K extends keyof T>(
    event: K,
    listener: T[K] extends undefined ? () => void : (data: T[K]) => void
  ) {
    this.events.off(event, listener)
  }

  /**
   * Creates a basic error operation result from an error message
   */
  protected createErrorOperationResult(
    errorMessage: string,
    missingComputerIds: string[] = []
  ): SyncOperationResult {
    return {
      status: SyncStatus.ERROR,
      timestamp: Date.now(),
      summary: {
        totalFiles: 0,
        successfulFiles: 0,
        failedFiles: 0,
        totalComputers: 0,
        fullySuccessfulComputers: 0,
        partiallySuccessfulComputers: 0,
        failedComputers: 0,
        missingComputers: missingComputerIds.length,
      },
      computerResults: [],
      errors: [errorMessage],
    }
  }

  abstract run(): Promise<void>
  abstract stop(): Promise<void>

  /**
   * This cleanup function should be called by child classes, and NOT overriden.
   */
  protected async cleanup(): Promise<Result<void>> {
    try {
      this.events.removeAllListeners()
      this.log.trace("BaseController event emitter disposed")
      await this.cleanupSpecific()
      return okVoid()
    } catch (error) {
      return failure([
        AppError.from(error, {
          severity: ErrorSeverity.ERROR,
          source: "BaseController.cleanup",
        }),
      ])
    }
  }

  /**
   * Should not be called by the child class directly. Instead, call the parent class's {@link cleanup} which will ensure common cleanup is performed in addition to controller-specific cleanup
   */
  protected abstract cleanupSpecific(): Promise<void>
}

class ManualModeController extends BaseController<ManualSyncEvents> {
  constructor(syncManager: SyncManager, ui: UI | null = null) {
    super(syncManager, ui)
  }

  async run(): Promise<void> {
    this.emit(SyncEvent.STARTED) // Signal ready to run

    try {
      this.ui?.clear()

      while (this.syncManager.getState() === SyncManagerState.RUNNING) {
        const syncResult = await this.performSyncCycle()

        if (!isOk(syncResult)) {
          // Only emit for notifications
          syncResult.errors.forEach((error) => {
            this.emit(SyncEvent.SYNC_ERROR, error)
          })

          if (isFailure(syncResult)) {
            // Check if any error is fatal
            const fatalErrors = syncResult.errors.filter(
              (error) => error.severity === ErrorSeverity.FATAL
            )
            if (fatalErrors.length > 0) {
              // Stop on fatal errors
              throw AppError.fatal(
                "Fatal error caused run to stop",
                "ManualModeController.run",
                fatalErrors[0]
              )
            }
          }
        }

        this.ui?.setReady()

        await this.waitForUserInput()
      }
    } catch (error) {
      if (error instanceof AppError) {
        this.emit(SyncEvent.SYNC_ERROR, error)
        throw error
      }
      const fatalAppError = AppError.from(error, {
        severity: ErrorSeverity.FATAL,
        source: "ManualModeController.run",
      })
      this.emit(SyncEvent.SYNC_ERROR, fatalAppError)
      throw fatalAppError
    }
  }

  async stop(): Promise<void> {
    try {
      // Call the Base class cleanup which will include cleanupSpecific for this controller
      await this.cleanup()
      this.emit(SyncEvent.STOPPED)
    } catch (error) {
      // Log but don't throw during stop to ensure clean shutdown
      this.log.error(
        `Error during ManualController cleanup: ${getErrorMessage(error)}`
      )
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  protected async cleanupSpecific() {
    if (this.keyHandler) {
      this.keyHandler.stop()
      this.keyHandler = null
      this.log.trace("keyHandler stopped.")
    }
    this.log.trace("ManualController specific cleanup complete.")
  }

  public async performSyncCycle(): Promise<Result<void>> {
    if (this.syncManager.getState() !== SyncManagerState.RUNNING) {
      // throw this, a programming error
      throw AppError.error(
        "Cannot perform sync when not in RUNNING state",
        "ManualModeController.performSyncCycle"
      )
    }

    // Update UI status
    this.ui?.startSyncOperation()

    this.log.debug("manualController started a new sync cycle.")

    // Performance tracking
    const syncCycleStartTime = process.hrtime.bigint()

    try {
      const syncPlan = await this.syncManager.createSyncPlan()
      this.emit(SyncEvent.SYNC_PLANNED, syncPlan)

      // Display issues to UI
      displaySyncPlanIssues(syncPlan, this.ui, this.log)

      // Check if the plan has critical issues
      if (!syncPlan.isValid) {
        // Create an AppError and emit it
        const errorMessage = getSyncPlanErrorMessage(syncPlan)

        const syncPlanError = AppError.error(
          "Sync plan creation failed: " + errorMessage,
          "ManualModeController.createSyncPlan"
        )

        this.log.error({ error: syncPlanError })

        this.ui?.completeOperation(
          this.createErrorOperationResult(
            errorMessage,
            syncPlan.missingComputerIds
          )
        )
        // Stop here, don't proceed with sync
        return failure([syncPlanError])
      }

      const performSyncResult = await this.syncManager.performSync(syncPlan)

      if (!isOk(performSyncResult)) {
        const errors = performSyncResult.errors
        if (isFailure(performSyncResult)) {
          // Handle failed performSync
          return failure(errors)
        } else {
          // Handle the partial sync
          this.emit(SyncEvent.SYNC_COMPLETE, performSyncResult.value)
          return partialVoid(errors)
        }
      } else {
        // Handle the successful performSync
        this.emit(SyncEvent.SYNC_COMPLETE, performSyncResult.value)
        return okVoid()
      }
    } catch (error) {
      const fatalAppError = AppError.from(error, {
        severity: ErrorSeverity.FATAL,
        source: "ManualModeController.performSyncCycle",
      })
      return failure([fatalAppError])
    } finally {
      // Performance tracking
      const endTime = process.hrtime.bigint()
      const duration = Number(endTime - syncCycleStartTime) / 1_000_000 // Convert to ms
      this.log.debug(
        {
          mode: SyncMode.MANUAL,
          syncCycleDuration: duration,
        },
        `performSyncCycle complete (${duration} ms)`
      )
    }
  }

  private waitForUserInput(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.setupKeyHandler(resolve)
    })
  }

  private setupKeyHandler(continueCallback: () => void): void {
    if (this.keyHandler) {
      this.keyHandler.stop()
    }

    this.keyHandler = new KeyHandler({
      onSpace: () => {
        this.log.info(
          { action: "manual_sync", trigger: "keypress_space" },
          "User triggered manual sync"
        )
        continueCallback()
      },
      onEsc: async () => {
        this.log.info(
          { action: "exit", trigger: "keypress_esc" },
          "User triggered exit"
        )
        await this.syncManager.stop()
      },
      onCtrlC: async () => {
        this.log.info(
          { action: "exit", trigger: "keypress_ctrlc" },
          "User triggered terminate"
        )
        try {
          await this.syncManager.stop()
          continueCallback()
        } catch (error) {
          // Just log here as we're exiting anyway
          console.error(`Error during shutdown: ${getErrorMessage(error)}`)
          process.exit(1)
        }
      },
    })

    this.keyHandler.start()
    this.log.debug("manualController keyHandler started")
  }
}

class WatchModeController extends BaseController<WatchSyncEvents> {
  private watcher: ReturnType<typeof watch> | null = null

  /**
   * The initial set of files to be watched that were passed to the watcher. The actual, *current* set of watched files is {@link watchedFiles}, which will be different than 'originalWatchedFiles' when watched files are renamed, moved, or deleted during watch mode.
   */
  private originalWatchedFiles: Set<string> = new Set()

  /**
   * Files being watched or tracked for file changes
   */
  private watchedFiles: Set<string> = new Set()

  /**
   * Files that have changed and are waiting to be synced in the next operation.
   * Changes are accumulated here during debounce periods or while a sync is in progress.
   */
  private pendingChanges: Set<string> = new Set()

  /**
   * Files that are currently being processed in an active sync operation.
   * This is an atomic snapshot of pendingChanges at the moment a sync begins.
   */
  private activeChanges: Set<string> = new Set()

  private isInitialSync = true

  // Debouncing/throttling
  private onChangeSyncInProgress = false
  private onChangeSyncDebounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    syncManager: SyncManager,
    private config: Config,
    ui: UI | null = null
  ) {
    super(syncManager, ui)
  }

  getInternalState() {
    return {
      isInitialSync: this.isInitialSync,
      debounceDelay: PROCESS_CHANGES_DELAY,
    }
  }

  /**
   * Returns the set of files currently being watched by the watcher.
   *
   * @returns Array of absolute file paths being watched
   */
  getWatchedFiles() {
    return [...this.watchedFiles]
  }

  /**
   * Returns the set of files that should be synced in the current operation.
   * During the initial sync, returns undefined to sync all matching files.
   * For subsequent syncs, returns the activeChanges set.
   *
   * @returns Set of file paths to sync, or undefined for initial sync
   */
  getChangedFiles(): Set<string> | undefined {
    return this.isInitialSync ? undefined : this.activeChanges
  }

  async run(): Promise<void> {
    try {
      this.setupKeyHandler()
      try {
        await this.setupWatcher()
      } catch (error: unknown) {
        if (error instanceof AppError) {
          this.emit(SyncEvent.SYNC_ERROR, error)
          throw error
        } else {
          const appError = AppError.fatal(
            `Unknown error in setupWatcher: ${getErrorMessage(error)}`,
            "WatchModeController.run",
            error
          )
          this.emit(SyncEvent.SYNC_ERROR, appError)
          throw appError
        }
      }

      this.emit(SyncEvent.STARTED) // Signal ready to run

      this.ui?.clear()

      if (this.syncManager.getState() !== SyncManagerState.RUNNING) {
        throw AppError.fatal(
          `Cannot run while syncManager state is: ${this.syncManager.getState()}`
        )
      }
      // Peform initial sync
      const initialSyncResult = await this.performSyncCycle()

      if (!isOk(initialSyncResult)) {
        // Only emit for notifications
        initialSyncResult.errors.forEach((error) => {
          this.emit(SyncEvent.SYNC_ERROR, error)
        })

        if (isFailure(initialSyncResult)) {
          // Check if any error is fatal
          const fatalErrors = initialSyncResult.errors.filter(
            (error) => error.severity === ErrorSeverity.FATAL
          )
          if (fatalErrors.length > 0) {
            // Stop on fatal errors
            throw AppError.fatal(
              "Fatal error caused run to stop",
              "WatchModeController.run",
              fatalErrors[0]
            )
          }
        }
      }

      this.ui?.setReady()

      // Keep running until state changes
      while (this.syncManager.getState() === SyncManagerState.RUNNING) {
        await new Promise((resolve) => {
          // eslint-disable-next-line @typescript-eslint/no-floating-promises
          setTimeoutPromise(100, resolve)
        })
      }
    } catch (error) {
      if (error instanceof AppError) {
        this.emit(SyncEvent.SYNC_ERROR, error)
        throw error
      }
      const fatalAppError = AppError.from(error, {
        severity: ErrorSeverity.FATAL,
        source: "WatchModeController.run",
      })
      this.emit(SyncEvent.SYNC_ERROR, fatalAppError)
      throw fatalAppError
    }
  }

  async stop(): Promise<void> {
    try {
      // Call the Base class cleanup which will include cleanupSpecific for this controller
      await this.cleanup()
      this.emit(SyncEvent.STOPPED)
    } catch (error) {
      // Log but don't throw during stop to ensure clean shutdown
      console.error(
        `Error during controller cleanup: ${getErrorMessage(error)}`
      )
    }
  }

  protected async cleanupSpecific() {
    if (this.keyHandler) {
      this.keyHandler.stop()
      this.keyHandler = null
      this.log.trace("keyHandler stopped.")
    }

    if (this.onChangeSyncDebounceTimer) {
      clearTimeout(this.onChangeSyncDebounceTimer)
      this.onChangeSyncDebounceTimer = null
    }

    if (this.watcher) {
      try {
        this.watcher.removeAllListeners("change")
        this.watcher.removeAllListeners("unlink")
        this.watcher.removeAllListeners("error")
        this.watcher.removeAllListeners("ready")
        this.watcher.removeAllListeners("all")
        await this.watcher.close()
      } catch (err) {
        this.log.error(`Error closing watcher: ${err}`)
      }
      this.watcher = null
    }
    this.pendingChanges.clear()
    this.activeChanges.clear()
    this.watchedFiles.clear()

    this.log.trace("WatchController specific cleanup complete.")
  }

  private async performSyncCycle(): Promise<Result<void>> {
    // Throw exception here as this is unexpected bad state
    if (this.syncManager.getState() !== SyncManagerState.RUNNING) {
      throw AppError.error(
        "Cannot perform sync when not in RUNNING state",
        "WatchModeController.performSyncCycle"
      )
    }

    // Update UI status
    this.ui?.startSyncOperation()

    // Performance tracking
    const syncCycleStartTime = process.hrtime.bigint()

    try {
      const syncPlan = await this.syncManager.createSyncPlan({
        changedFiles: this.isInitialSync ? undefined : this.activeChanges,
      })

      this.emit(SyncEvent.SYNC_PLANNED, syncPlan)

      // If we're not in initial sync and have no files to sync, add a warning
      if (
        !this.isInitialSync &&
        this.activeChanges.size > 0 &&
        syncPlan.resolvedFileRules.length === 0
      ) {
        this.log.warn(
          "No files matched for sync despite having changed files",
          { changedFiles: [...this.activeChanges] }
        )
      }

      // Add File(s) changed message to UI
      if (this.activeChanges.size > 0) {
        const filesText = pluralize("File")(this.activeChanges.size)
        const fileNames = [...this.activeChanges].map((p) =>
          getRelativePath(p, this.config.sourceRoot, { includeRootName: true })
        )
        this.ui?.addMessage(
          UIMessageType.INFO,
          `${filesText} changed: ${fileNames.join(", ")}`
        )
      }

      // Add each error message to UI
      displaySyncPlanIssues(syncPlan, this.ui, this.log)

      // Check if the plan has critical issues
      if (!syncPlan.isValid) {
        // Create an AppError and emit it
        const errorMessage = getSyncPlanErrorMessage(syncPlan)

        const syncPlanError = AppError.error(
          "Sync plan creation failed: " + errorMessage,
          "WatchModeController.createSyncPlan"
        )

        this.log.error({ error: syncPlanError })

        this.ui?.completeOperation(
          this.createErrorOperationResult(
            errorMessage,
            syncPlan.missingComputerIds
          )
        )
        // Stop here, don't proceed with sync

        return failure([syncPlanError])
      }

      // Perform sync
      const performSyncResult = await this.syncManager.performSync(syncPlan)

      const handleSyncComplete = (
        isInitialSync: boolean,
        result: Result<SyncOperationResult>
      ) => {
        if (isInitialSync) {
          this.isInitialSync = false
          this.emit(SyncEvent.INITIAL_SYNC_COMPLETE, result.value)
        } else {
          this.emit(SyncEvent.SYNC_COMPLETE, result.value)
          // Clear changed files after successful non-initial sync
          this.activeChanges.clear()
        }
        this.log.debug(`${this.isInitialSync ? "Initial " : ""}Sync Complete.`)

        // Set back to ready state after operation completes
        this.ui?.setReady()
      }

      if (!isOk(performSyncResult)) {
        const errors = performSyncResult.errors
        if (isFailure(performSyncResult)) {
          // Handle failed performSync
          return failure(errors)
        } else {
          // Handle the partial sync
          // TODO: if sync was only partial, we want to keep those files in
          // this.activeChanges for another round...
          handleSyncComplete(this.isInitialSync, performSyncResult)
          return partialVoid(errors)
        }
      } else {
        // Handle the successful performSync
        handleSyncComplete(this.isInitialSync, performSyncResult)
        return okVoid()
      }
    } catch (error) {
      const fatalAppError = AppError.from(error, {
        severity: ErrorSeverity.FATAL,
        source: "WatchModeController.performSyncCycle",
      })
      return failure([fatalAppError])
    } finally {
      // Performance tracking
      const endTime = process.hrtime.bigint()
      const duration = Number(endTime - syncCycleStartTime) / 1_000_000 // Convert to ms
      this.log.debug(
        {
          mode: SyncMode.WATCH,
          syncCycleDuration: duration,
        },
        `performSyncCycle complete (${duration} ms)`
      )
    }
  }

  private setupKeyHandler(): void {
    if (this.keyHandler) {
      this.log.warn(
        "watchController setupKeyHandler called while another was active"
      )
      this.keyHandler.stop()
    }

    this.keyHandler = new KeyHandler({
      onEsc: async () => {
        this.log.info(
          { action: "exit", trigger: "keypress_esc" },
          "User triggered exit"
        )
        await this.syncManager.stop()
      },
      onCtrlC: async () => {
        this.log.info(
          { action: "exit", trigger: "keypress_ctrlc" },
          "User triggered terminate"
        )
        try {
          await this.syncManager.stop()
        } catch (error) {
          // Just log here as we're exiting anyway
          console.error(`Error during shutdown: ${getErrorMessage(error)}`)
          process.exit(1)
        }
      },
    })

    this.keyHandler.start()
    this.log.debug("watchController keyHandler started")
  }

  /**
   * Compiles a Set of unique file paths from the sync rules in the config, using `glob` to match files based on glob patterns
   */
  private async resolveFilesForWatcher(): Promise<void> {
    try {
      // Get all unique file paths from glob patterns
      const uniqueSourcePaths = new Set<string>()

      for (const rule of this.config.rules) {
        const sourcePath = processPath(
          path.join(this.config.sourceRoot, rule.source),
          false // Don't strip trailing slash for globs
        )
        const matches = await glob(sourcePath, { absolute: true })

        // Filter out directories to only include files
        const fileMatches = await filterFilesOnly(matches)
        fileMatches.forEach((match) =>
          uniqueSourcePaths.add(processPath(match))
        )
      }

      // Convert to array and store in watchedFiles
      const patterns = Array.from(uniqueSourcePaths)
      this.watchedFiles = new Set(patterns)
      this.originalWatchedFiles = new Set(this.watchedFiles)
    } catch (error) {
      const appError = AppError.fatal(
        `Failed to resolve watch patterns: ${getErrorMessage(error)}`,
        "WatchModeController.resolveWatchPatterns",
        error
      )

      throw appError
    }
  }

  /**
   * Identifies the file paths that were in the original watcher and compares them to the files currently in the watcher. Then reports these file paths to the UI.
   *
   * This allows warning messages to be added to the UI when watched files are renamed or deleted, which removes them from the current watched files
   */
  private reportMissingWatchedFiles() {
    if (this.originalWatchedFiles.size === 0 || this.watchedFiles.size === 0)
      return

    // Set.difference() is a Node 22 built in
    // const noLongerWatchedFiles = this.originalWatchedFiles.difference(
    //   this.watchedFiles
    // )

    // Manually calculate the difference
    const noLongerWatchedFiles = new Set(
      [...this.originalWatchedFiles].filter((f) => !this.watchedFiles.has(f))
    )

    if (noLongerWatchedFiles.size > 0) {
      const relativePaths = [...noLongerWatchedFiles].map((f) => {
        return getRelativePath(f, this.config.sourceRoot, {
          includeRootName: true,
        })
      })
      this.ui?.addMessage(
        UIMessageType.WARNING,
        `The following files were removed or renamed and are no longer being watched: ${relativePaths.join(", ")}`,
        "Restart watch mode to update watched files"
      )
      this.log.warn(
        { noLongerWatchedFiles: relativePaths },
        "Files are missing compared to when the watcher was initiated. Suspect they were renamed or deleted."
      )
    }
  }

  /**
   * Processes any pending file changes by moving them to activeChanges and
   * triggering a sync operation. Handles race conditions by ensuring changes
   * that occur during sync are captured for the next sync cycle.
   *
   * @returns Promise that resolves when the sync is complete
   * @throws AppError if the sync operation fails
   */
  private async processPendingChanges(): Promise<void> {
    // Safety check - only proceed if we have changes
    if (this.pendingChanges.size === 0) {
      return
    }

    this.onChangeSyncInProgress = true
    // Transfer pending to active - atomic operation
    this.activeChanges = new Set(this.pendingChanges)
    this.pendingChanges.clear()

    this.log.debug(
      {
        fileCount: this.activeChanges.size,
      },
      "Processing changes"
    )

    try {
      // Execute sync with current set of changes
      const syncResult = await this.performSyncCycle()

      if (!isOk(syncResult)) {
        // Only emit for notifications
        syncResult.errors.forEach((error) => {
          this.emit(SyncEvent.SYNC_ERROR, error)
        })
        if (isFailure(syncResult)) {
          // Check if any error is fatal
          const fatalErrors = syncResult.errors.filter(
            (error) => error.severity === ErrorSeverity.FATAL
          )
          if (fatalErrors.length > 0) {
            // Stop on fatal errors
            throw AppError.fatal(
              "Fatal error caused run to stop",
              "WatchModeController.run",
              fatalErrors[0]
            )
          }
        }
      }
    } catch (error) {
      if (error instanceof AppError) {
        this.emit(SyncEvent.SYNC_ERROR, error)
        throw error
      }
      const fatalAppError = AppError.from(error, {
        severity: ErrorSeverity.FATAL,
        source: "WatchModeController.run",
      })
      this.emit(SyncEvent.SYNC_ERROR, fatalAppError)
      throw fatalAppError
    } finally {
      this.onChangeSyncInProgress = false
      this.activeChanges.clear()

      // Process any changes that accumulated during sync
      if (this.pendingChanges.size > 0) {
        this.log.info(
          { pendingChangeCount: this.pendingChanges.size },
          "Additional changes detected during sync, processing"
        )

        // Schedule processing of new changes
        this.onChangeSyncDebounceTimer = setTimeout(() => {
          this.onChangeSyncDebounceTimer = null
          this.processPendingChanges().catch((error: unknown) => {
            this.emit(
              SyncEvent.SYNC_ERROR,
              AppError.error(
                `Error processing pending changes: ${getErrorMessage(error)}`,
                "WatchModeController.processPendingChanges",
                error
              )
            )
          })
        }, PROCESS_CHANGES_DELAY)
      }
    }
  }

  /**
   * Handles file change events from the watcher.
   * Adds the changed file to pendingChanges and schedules processing.
   * If a sync is already in progress, the change will be picked up afterward.
   *
   * @param changedPath The absolute path of the changed file
   */
  private handleWatcherOnChange(changedPath: string) {
    this.log.info({ changedPath }, `watchController watcher detected change`)

    if (this.syncManager.getState() !== SyncManagerState.RUNNING) {
      return
    }

    // check if we are no longer watching files from the original and add warning messages to the UI
    this.reportMissingWatchedFiles()

    // Add the changed file to our set of pending changes
    const normalizedPath = processPath(changedPath)
    this.pendingChanges.add(normalizedPath)

    this.log.trace(
      { changedFiles: [...this.pendingChanges] },
      "Added to pending changes, waiting for more changes before syncing"
    )

    // If we already have a timer, clear it
    if (this.onChangeSyncDebounceTimer) {
      clearTimeout(this.onChangeSyncDebounceTimer)
      this.onChangeSyncDebounceTimer = null
    }

    // Don't schedule if sync already in progress - it will be picked up afterwards
    if (!this.onChangeSyncInProgress) {
      this.onChangeSyncDebounceTimer = setTimeout(() => {
        this.onChangeSyncDebounceTimer = null
        // eslint-disable-next-line no-void
        void this.processPendingChanges()
      }, PROCESS_CHANGES_DELAY)
    }
  }

  private handleWatchOnUnlink(unlinkedPath: string) {
    if (this.syncManager.getState() !== SyncManagerState.RUNNING) {
      return
    }

    this.log.info(
      { unlinkedPath },
      `watchController watcher detected file removal or rename`
    )

    // Remove from watched files set
    const normalizedPath = processPath(unlinkedPath)
    if (this.watchedFiles.has(normalizedPath)) {
      this.watchedFiles.delete(normalizedPath)

      // When files are removed/renamed, invalidate the sync plan cache
      // since directory structures might have changed
      this.syncManager.invalidateCache(
        "A watched file has been renamed/moved/deleted"
      )

      // Notify user through UI
      if (this.ui) {
        const filename = path.basename(unlinkedPath)
        this.ui.addMessage(
          UIMessageType.WARNING,
          `File '${filename}' was removed or renamed and will no longer be watched`,
          "Restart watch mode to update watched files"
        )
        this.ui.writeMessages({ persist: true, clearMessagesOnWrite: true })
      }

      this.log.warn(
        {
          removedPath: getRelativePath(unlinkedPath, this.config.sourceRoot, {
            includeRootName: true,
          }),
        },
        "File was removed or renamed and will no longer be watched"
      )
    }
  }

  /**
   * Sets up the file watcher for the source files defined in the configuration.
   * Resolves all glob patterns to actual file paths and starts watching those files.
   *
   * @returns Promise that resolves when the watcher is ready
   * @throws AppError if watcher setup fails
   */
  private async setupWatcher(): Promise<void> {
    try {
      // Get actual file paths to watch
      await this.resolveFilesForWatcher()

      const usePolling =
        process.env.CI === "true" || this.config.advanced.usePolling

      this.watcher = watch([...this.watchedFiles], {
        ignoreInitial: true,
        usePolling,
        awaitWriteFinish: {
          stabilityThreshold: 1000,
          pollInterval: 100, // ms
        },
      })

      this.log.debug(
        {
          watchedFiles: [...this.watchedFiles].map((f) =>
            getRelativePath(f, this.config.sourceRoot, {
              includeRootName: true,
            })
          ),
          strategy: usePolling ? "polling" : "native OS events",
        },
        `watchController set up a chokidar watcher with:`
      )

      // Handle file change
      this.watcher.on("change", this.handleWatcherOnChange.bind(this))

      // Handle file deletions or renames
      this.watcher.on("unlink", this.handleWatchOnUnlink.bind(this))

      // this.watcher.on("all", (ev, path) => {
      //   console.debug(ev, path)
      // })

      // TODO: should this just swallow the errors here??
      this.watcher.on("error", (error) => {
        const watcherError = AppError.fatal(
          `File watcher error: ${getErrorMessage(error)}`,
          "WatchModeController.watcher",
          error
        )
        // Notifications only
        this.emit(SyncEvent.SYNC_ERROR, watcherError)

        this.log.error(
          { error: watcherError },
          "File watcher encountered an error"
        )
      })

      // If no files to watch, throw error
      if (this.watchedFiles.size === 0) {
        throw new AppError(
          "Watch mode could not be started with 0 matched files.",
          ErrorSeverity.FATAL,
          "WatchModeController.setupWatcher",
          undefined,
          "Watch mode cannot be started with 0 matched files."
        )
      }

      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new AppError(
              "Watcher failed to become ready after timeout",
              ErrorSeverity.FATAL,
              "WatchModeController.setupWatcher"
            )
          )
        }, 2000) // 2 second timeout

        this.watcher?.on("ready", () => {
          clearTimeout(timeout)
          this.log.info("watcher is ready")
          resolve()
        })

        this.watcher?.on("error", (err) => {
          clearTimeout(timeout)
          reject(AppError.from(err))
        })
      })
    } catch (error) {
      if (error instanceof AppError) {
        throw error
      }
      throw AppError.fatal(
        `Failed to setup file watcher: ${getErrorMessage(error)}`,
        "WatchModeController.setupWatcher",
        error
      )
    }
  }
}
