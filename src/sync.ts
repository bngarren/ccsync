import { watch } from "chokidar"
import path from "node:path"
import type { Config } from "./config"
import {
  type Computer,
  type SyncResult,
  createTypedEmitter,
  type ManualSyncEvents,
  type WatchSyncEvents,
  SyncEvent,
  type ResolvedFileRule,
  type ComputerSyncResult,
  SyncMode,
  SyncOperationResult,
  type BaseControllerEvents,
} from "./types"
import {
  validateMinecraftSave,
  findMinecraftComputers,
  resolveSyncRules,
  copyFilesToComputer,
  normalizePath,
  pluralize,
  resolveTargetPath,
} from "./utils"
import { KeyHandler } from "./keys"
import { setTimeout } from "node:timers/promises"
import { glob } from "glob"
import { AppError, ErrorSeverity, getErrorMessage } from "./errors"
import { UI, UIMessageType } from "./ui"
import {
  createEmptySyncPlan,
  createSyncPlanIssue,
  SyncPlanIssueCategory,
  SyncPlanIssueSeverity,
  type SyncPlan,
} from "./syncplan"

enum SyncManagerState {
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
function displaySyncPlanIssues(syncPlan: SyncPlan, ui: UI | null): void {
  if (!ui) return

  // Display errors
  syncPlan.issues
    .filter((issue) => issue.severity === SyncPlanIssueSeverity.ERROR)
    .forEach((issue) => {
      ui.addMessage(UIMessageType.ERROR, issue.message, issue.suggestion)
    })

  // Display warnings
  syncPlan.issues
    .filter((issue) => issue.severity === SyncPlanIssueSeverity.WARNING)
    .forEach((issue) => {
      ui.addMessage(UIMessageType.WARNING, issue.message, issue.suggestion)
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
  private ui: UI | null = null
  private activeModeController:
    | ManualModeController
    | WatchModeController
    | null = null
  private lastSyncPlan: Readonly<SyncPlan> | null = null

  // STATE
  private state: SyncManagerState = SyncManagerState.IDLE
  private setState(newState: SyncManagerState) {
    // const oldState = this.state
    this.state = newState
    // this.log.verbose(
    //   `State transition: ${SyncManagerState[oldState]} → ${SyncManagerState[newState]}`
    // );
  }

  constructor(private config: Config) {}

  // Public state query methods
  public isRunning(): boolean {
    return this.state === SyncManagerState.RUNNING
  }

  public getState(): SyncManagerState {
    return this.state
  }

  // Cache management
  private isCacheValid(changedFiles?: Set<string>): boolean {
    if (!this.lastSyncPlan?.timestamp) return false

    // If there are changed files, invalidate the cache
    if (changedFiles && changedFiles.size > 0) return false

    const timeSinceLastPlan = Date.now() - this.lastSyncPlan.timestamp
    return timeSinceLastPlan < this.config.advanced.cache_ttl
  }

  public invalidateCache(): void {
    //this.log.verbose("Sync plan cache invalidated")
    this.lastSyncPlan = null
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

    // Check cache first
    if (!forceRefresh && this.isCacheValid(changedFiles) && this.lastSyncPlan) {
      return this.lastSyncPlan
    }

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
                  suggestion: `Ensure this is a valid Minecraft at '${saveDirValidation.savePath}'`,
                }
              )
            )
          })

          if (saveDirValidation.missingFiles?.length > 0) {
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
          return plan
        }
      } catch (err) {
        plan.issues.push(
          createSyncPlanIssue(
            `Failed to validate save directory: ${err instanceof Error ? err.message : String(err)}`,
            SyncPlanIssueCategory.SAVE_DIRECTORY,
            SyncPlanIssueSeverity.ERROR,
            { source: "createSyncPlan" }
          )
        )
        plan.isValid = false
        return plan
      }

      // Step 2: Discover computers
      let computers: Computer[] = []
      try {
        computers = await findMinecraftComputers(this.config.minecraftSavePath)

        if (computers.length === 0) {
          plan.issues.push(
            createSyncPlanIssue(
              "No computers found in the save directory",
              SyncPlanIssueCategory.COMPUTER,
              SyncPlanIssueSeverity.WARNING,
              {
                source: "findMinecraftComputers",
                suggestion:
                  "Create a computer in-game first, or if using a test environment, add a dummy file to a computer directory",
              }
            )
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
        return plan
      }

      // Step 3: Get changed files from watch mode if applicable
      const changedFiles =
        this.activeModeController instanceof WatchModeController
          ? this.activeModeController.getChangedFiles()
          : undefined

      // Step 4: Resolve sync rules
      try {
        const ruleResolution = await resolveSyncRules(
          this.config,
          computers,
          changedFiles
        )

        // Add resolved files to the plan
        plan.resolvedFileRules = ruleResolution.resolvedFileRules
        plan.availableComputers = ruleResolution.availableComputers
        plan.missingComputerIds = ruleResolution.missingComputerIds

        // Add any errors as issues
        if (ruleResolution.errors.length > 0) {
          ruleResolution.errors.forEach((error) => {
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
        }

        // Add missing computers as warnings
        const missing = ruleResolution.missingComputerIds
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
        return plan
      }

      // Determine if the plan is valid (no ERROR severity issues)
      plan.isValid = !plan.issues.some(
        (issue) => issue.severity === SyncPlanIssueSeverity.ERROR
      )

      // Cache successful plan
      if (plan.isValid) {
        this.lastSyncPlan = { ...plan, timestamp: Date.now() }
      } else {
        this.lastSyncPlan = null
      }

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
      this.lastSyncPlan = null
      return plan
    }
  }

  private async syncToComputer(
    computer: Computer,
    fileRules: ResolvedFileRule[]
  ): Promise<{
    computerId: string
    copiedFiles: string[]
    skippedFiles: string[]
    errors: string[]
  }> {
    const filesToCopy = fileRules.filter((file) =>
      file.computers.includes(computer.id)
    )

    if (filesToCopy.length === 0) {
      return {
        computerId: computer.id,
        copiedFiles: [],
        skippedFiles: [],
        errors: [],
      }
    }

    const copyResult = await copyFilesToComputer(filesToCopy, computer.path)
    await setTimeout(100) // Small delay between computers

    return {
      computerId: computer.id,
      ...copyResult,
    }
  }

  public async performSync(syncPlan: SyncPlan): Promise<SyncResult> {
    if (this.state !== SyncManagerState.RUNNING) {
      throw new Error("Cannot perform sync when not in RUNNING state")
    }

    const computerResults: ComputerSyncResult[] = []

    const allComputerIds = new Set<string>()

    let totalAttemptedFiles = 0

    // First create entries for all computers
    for (const fileRule of syncPlan.resolvedFileRules) {
      for (const computerId of fileRule.computers) {
        // Create computer if it doesn't exist yet
        if (!allComputerIds.has(computerId)) {
          allComputerIds.add(computerId)

          // Check if this is a missing computer
          const isExisting = syncPlan.availableComputers.some(
            (c) => c.id === computerId
          )

          computerResults.push({
            computerId,
            exists: isExisting,
            files: [],
          })
        }

        // Get the computer result
        const computerResult = computerResults.find(
          (cr) => cr.computerId === computerId
        )!

        // Prepare target path based on target type
        const targetPath = resolveTargetPath(fileRule)

        // Add file entry with explicit type information
        computerResult.files.push({
          targetPath,
          targetType: fileRule.target.type,
          sourcePath: fileRule.sourceAbsolutePath,
          success: false, // Mark all as unsuccessful initially
        })
        totalAttemptedFiles++
      }
    }

    const result: SyncResult = {
      successCount: 0,
      errorCount: 0,
      missingCount: syncPlan.missingComputerIds.length,
    }

    // Record warnings during sync for UI display
    const warningMessages: string[] = []

    /**
     * Execute the actual sync operation for each available computer:
     * 1. Copy the files to each computer according to resolved rules
     * 2. Track successful and failed file transfers
     * 3. //TODO Handle duplicate rule scenarios (multiple rules targeting the same file)
     * 4. Update UI with results for each computer
     * 5. Aggregate results to determine overall sync status
     *
     * This is the core synchronization process where file transfers actually occur
     * and success/failure is determined for the operation.
     */
    for (const computer of syncPlan.availableComputers) {
      const syncResult = await this.syncToComputer(
        computer,
        syncPlan.resolvedFileRules
      )

      // Find this computer in our results array
      const computerResult = computerResults.find(
        (cr) => cr.computerId === computer.id
      )
      if (!computerResult) continue // Should never happen but TypeScript needs this check

      // Process all copied files (successes)
      for (const filePath of syncResult.copiedFiles) {
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
          }
        }
      }

      // Handle errors
      if (syncResult.errors.length > 0) {
        result.errorCount++

        // Report each error to the UI
        if (this.ui) {
          syncResult.errors.forEach((error) => {
            this.ui?.addMessage(
              UIMessageType.ERROR,
              `Error copying to computer ${computer.id}: ${error}`
            )
          })
        }
      } else if (syncResult.copiedFiles.length > 0) {
        result.successCount++
      }

      // Handle skipped files as warnings
      if (syncResult.skippedFiles.length > 0) {
        const skipMessage = `Skipped ${syncResult.skippedFiles.length} file(s) for computer ${computer.id}`
        warningMessages.push(skipMessage)

        if (this.ui) {
          this.ui.addMessage(UIMessageType.WARNING, skipMessage)
        }
      }
    }

    // Determine overall operation result
    let operationResult = SyncOperationResult.SUCCESS

    if (result.errorCount > 0 && result.successCount === 0) {
      operationResult = SyncOperationResult.ERROR
    } else if (result.errorCount > 0) {
      operationResult = SyncOperationResult.PARTIAL
    } else if (warningMessages.length > 0) {
      operationResult = SyncOperationResult.WARNING
    }

    // Update UI with final results
    if (this.ui) {
      this.ui.updateOperationStats({
        totalFiles: totalAttemptedFiles,
        totalComputers: allComputerIds.size,
      })
      this.ui.updateComputerResults(computerResults)
      this.ui.completeOperation(operationResult)
    }

    // Cache invalidation for watch mode
    if (this.activeModeController instanceof WatchModeController) {
      this.invalidateCache()
    }

    return result
  }

  async startManualMode(): Promise<ManualModeController> {
    if (this.state !== SyncManagerState.IDLE) {
      // throw error directly, this is a programming error
      throw AppError.fatal(
        `Cannot start manual mode in state: ${SyncManagerState[this.state]}`,
        "SyncManager"
      )
    }

    try {
      this.setState(SyncManagerState.STARTING)

      // Initialize UI for manual mode
      this.ui = new UI(this.config.sourceRoot, SyncMode.MANUAL)

      const manualController = new ManualModeController(this, this.ui)
      this.activeModeController = manualController

      // Listen for controller state changes
      manualController.on(SyncEvent.STARTED, () => {
        this.setState(SyncManagerState.RUNNING)
        this.ui?.start()
      })

      // The controller has already stopped
      manualController.on(SyncEvent.STOPPED, async () => {
        this.setState(SyncManagerState.STOPPED)
        this.ui?.stop()
      })

      // High level controller functions should emit a SYNC_ERROR when they catch thrown errors from subordinate functions
      manualController.on(SyncEvent.SYNC_ERROR, async (error) => {
        if (this.ui) {
          this.ui.addMessage(UIMessageType.ERROR, error.message)
        } else {
          console.error(error)
        }
        // Handle based on severity
        if (error.severity === ErrorSeverity.FATAL) {
          this.setState(SyncManagerState.ERROR)
          await this.stop()
        }
      })

      manualController.start().catch(async (error) => {
        // Controller start failed - this is a fatal error
        this.setState(SyncManagerState.ERROR)

        await this.stop()

        throw AppError.fatal(
          `Failed to start manual mode: ${getErrorMessage(error)}`,
          "SyncManager.startManualMode",
          error
        )
      })
      return manualController
    } catch (error) {
      this.setState(SyncManagerState.ERROR)
      // If error is already AppError, rethrow it
      if (error instanceof AppError) {
        throw error
      }
      throw AppError.fatal(
        `Manual mode initialization failed: ${getErrorMessage(error)}`,
        "SyncManager.startManualMode",
        error
      )
    }
  }
  async startWatchMode(): Promise<WatchModeController> {
    if (this.state !== SyncManagerState.IDLE) {
      // throw error directly, this is a programming error
      throw AppError.fatal(
        `Cannot start watch mode in state: ${SyncManagerState[this.state]}`,
        "SyncManager"
      )
    }

    try {
      this.setState(SyncManagerState.STARTING)

      // Initialize UI for watch mode
      this.ui = new UI(this.config.sourceRoot, SyncMode.WATCH)

      const watchController = new WatchModeController(
        this,
        this.config,
        this.ui
      )
      this.activeModeController = watchController

      // Listen for controller state changes
      watchController.on(SyncEvent.STARTED, () => {
        this.setState(SyncManagerState.RUNNING)
        this.ui?.start()
      })

      watchController.on(SyncEvent.STOPPED, async () => {
        this.setState(SyncManagerState.STOPPED)
        this.ui?.stop()
      })

      watchController.on(SyncEvent.SYNC_ERROR, async (error) => {
        if (this.ui) {
          this.ui.addMessage(UIMessageType.ERROR, error.message)
        } else {
          console.error(error)
        }

        // Handle based on severity
        if (error.severity === ErrorSeverity.FATAL) {
          this.setState(SyncManagerState.ERROR)
          await this.stop()
        }
      })

      // Start the watch controller (do NOT await it!)
      watchController.start().catch(async (error) => {
        // Controller start failed - this is a fatal error
        this.setState(SyncManagerState.ERROR)

        await this.stop()

        // Convert to AppError and rethrow
        throw AppError.fatal(
          `Failed to start watch mode: ${getErrorMessage(error)}`,
          "SyncManager.startWatchMode",
          error
        )
      })

      return watchController
    } catch (error) {
      this.setState(SyncManagerState.ERROR)
      // If error is already AppError, rethrow it
      if (error instanceof AppError) {
        throw error
      }
      throw AppError.fatal(
        `Watch mode initialization failed: ${getErrorMessage(error)}`,
        "SyncManager.startWatchMode",
        error
      )
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
      if (this.ui) {
        this.ui.stop()
        this.ui = null
      }

      if (this.activeModeController) {
        await this.activeModeController.stop()
        this.activeModeController = null
      }
      this.setState(SyncManagerState.STOPPED)
    } catch (error) {
      this.setState(SyncManagerState.ERROR)
      if (error instanceof AppError) {
        throw error
      }
      throw AppError.error(
        `Failed to stop sync manager: ${getErrorMessage(error)}`,
        "SyncManager.stop",
        error
      )
    }
  }
}

/**
 * Base controller for common functionality between manual and watch modes
 */
abstract class BaseController<T extends BaseControllerEvents> {
  protected events = createTypedEmitter<T>()
  protected keyHandler: KeyHandler | null = null

  constructor(
    protected syncManager: SyncManager,
    protected ui: UI | null = null
  ) {}

  emit<K extends keyof T>(event: K, data?: T[K] extends void ? void : T[K]) {
    return this.events.emit(event, data)
  }

  on<K extends keyof T>(
    event: K,
    listener: T[K] extends void ? () => void : (data: T[K]) => void
  ) {
    this.events.on(event, listener)
  }

  once<K extends keyof T>(
    event: K,
    listener: T[K] extends void ? () => void : (data: T[K]) => void
  ) {
    this.events.once(event, listener)
  }

  off<K extends keyof T>(
    event: K,
    listener: T[K] extends void ? () => void : (data: T[K]) => void
  ) {
    this.events.off(event, listener)
  }

  /**
   * Base cleanup functionality for controllers
   */
  protected async cleanupBase(): Promise<void> {
    if (this.keyHandler) {
      this.keyHandler.stop()
      this.keyHandler = null
    }
  }

  abstract start(): Promise<void>
  abstract stop(): Promise<void>
}

class ManualModeController extends BaseController<ManualSyncEvents> {
  constructor(syncManager: SyncManager, ui: UI | null = null) {
    super(syncManager, ui)
  }

  async start(): Promise<void> {
    this.emit(SyncEvent.STARTED) // Signal ready to run

    try {
      this.ui?.clear()

      while (this.syncManager.getState() === SyncManagerState.RUNNING) {
        await this.performSyncCycle()

        this.ui?.setReady()

        await this.waitForUserInput()
      }
    } catch (error) {
      await this.cleanup()

      // Errors caught here should be fatal as they were not handled within performSyncCycle or waitForUserInput
      if (error instanceof AppError) {
        throw error
      }
      throw AppError.fatal(
        `Manual mode operation failed: ${getErrorMessage(error)}`,
        "ManualModeController.start",
        error
      )
    }
  }

  async stop(): Promise<void> {
    try {
      await this.cleanup()
      this.emit(SyncEvent.STOPPED)
    } catch (error) {
      // Log but don't throw during stop to ensure clean shutdown
      console.error(
        `Error during controller cleanup: ${getErrorMessage(error)}`
      )
    }
  }

  private async performSyncCycle(): Promise<void> {
    if (this.syncManager.getState() !== SyncManagerState.RUNNING) {
      // throw this, a programming error
      throw AppError.error(
        "Cannot perform sync when not in RUNNING state",
        "ManualModeController.performSyncCycle"
      )
    }

    // Update UI status
    this.ui?.startSyncOperation()

    try {
      const syncPlan = await this.syncManager.createSyncPlan()
      this.emit(SyncEvent.SYNC_PLANNED, syncPlan)

      // Display issues to UI
      displaySyncPlanIssues(syncPlan, this.ui)

      // Check if the plan has critical issues
      if (!syncPlan.isValid) {
        // Create an AppError and emit it
        const errorMessages = getSyncPlanErrorMessage(syncPlan)

        const syncPlanError = AppError.error(
          "Sync plan creation failed: " + errorMessages,
          "ManualModeController.createSyncPlan"
        )
        this.emit(SyncEvent.SYNC_ERROR, syncPlanError)

        this.ui?.completeOperation(SyncOperationResult.ERROR)

        return // Stop here, don't proceed with sync
      }

      const syncResult = await this.syncManager.performSync(syncPlan)
      this.emit(SyncEvent.SYNC_COMPLETE, syncResult)
    } catch (error) {
      // Convert to AppError if it isn't already
      const appError =
        error instanceof AppError
          ? error
          : AppError.fatal(
              `Unexpected error during sync: ${getErrorMessage(error)}`,
              "ManualModeController.performSyncCycle",
              error
            )

      // Emit the error event
      this.emit(SyncEvent.SYNC_ERROR, appError)

      // Emitting a fatal error (above) will cause SyncManager to stop() this controller
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
      onSpace: async () => {
        continueCallback()
      },
      onEsc: async () => {
        try {
          await this.syncManager.stop()
        } catch (error) {
          // Convert to AppError and emit
          const appError = AppError.from(
            error,
            "Failed to stop sync manager",
            ErrorSeverity.ERROR,
            "ManualModeController.keyHandler"
          )
          this.emit(SyncEvent.SYNC_ERROR, appError)
        }
      },
      onCtrlC: async () => {
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
  }

  private async cleanup(): Promise<void> {
    await this.cleanupBase()
  }
}

class WatchModeController extends BaseController<WatchSyncEvents> {
  private watcher: ReturnType<typeof watch> | null = null
  /**
   * Files being watched or tracked for file changes
   */
  private watchedFiles: Set<string> = new Set()
  /**
   * Temp set of files that have just changed that will be synced. Clear when synced.
   */
  private changedFiles: Set<string> = new Set()

  private isInitialSync = true

  constructor(
    syncManager: SyncManager,
    private config: Config,
    ui: UI | null = null
  ) {
    super(syncManager, ui)
  }

  async start(): Promise<void> {
    try {
      this.setupKeyHandler()
      await this.setupWatcher()

      this.emit(SyncEvent.STARTED) // Signal ready to run

      this.ui?.clear()

      // Peform initial sync
      await this.performSyncCycle()

      if (this.syncManager.getState() !== SyncManagerState.RUNNING) return

      this.ui?.setReady()

      // Keep running until state changes
      while (this.syncManager.getState() === SyncManagerState.RUNNING) {
        await new Promise((resolve) => setTimeout(100, resolve))
      }
    } catch (error) {
      // Convert error to AppError if needed
      if (error instanceof AppError) {
        throw error
      }
      // Errors are fatal if caught here as they weren't handled by subordinates
      throw AppError.fatal(
        `Watch mode operation failed: ${getErrorMessage(error)}`,
        "WatchModeController.start",
        error
      )
    } finally {
      await this.stop()
    }
  }

  async stop(): Promise<void> {
    try {
      await this.cleanup()
      this.emit(SyncEvent.STOPPED)
    } catch (error) {
      // Log but don't throw during stop to ensure clean shutdown
      console.error(
        `Error during controller cleanup: ${getErrorMessage(error)}`
      )
    }
  }

  getChangedFiles(): Set<string> | undefined {
    return this.isInitialSync ? undefined : this.changedFiles
  }

  private async performSyncCycle(changedPath?: string): Promise<void> {
    if (this.syncManager.getState() !== SyncManagerState.RUNNING) {
      throw AppError.error(
        "Cannot perform sync when not in RUNNING state",
        "WatchModeController.performSyncCycle"
      )
    }

    // Update UI status
    this.ui?.startSyncOperation()

    // If this is triggered by a file change, update the changedFiles set
    if (changedPath) {
      const relativePath = normalizePath(
        path.relative(this.config.sourceRoot, changedPath)
      )
      this.changedFiles.add(relativePath)

      // Update UI to show sync is starting
      if (this.ui) {
        this.ui.addMessage(
          UIMessageType.INFO,
          `File changed: ${path.basename(changedPath)}`
        )
      }
    }

    try {
      const syncPlan = await this.syncManager.createSyncPlan({
        changedFiles: this.isInitialSync ? undefined : this.changedFiles,
      })
      this.emit(SyncEvent.SYNC_PLANNED, syncPlan)

      // Add each error message to UI
      displaySyncPlanIssues(syncPlan, this.ui)

      // Check if the plan has critical issues
      if (!syncPlan.isValid) {
        // Create an AppError and emit it
        const errorMessages = syncPlan.issues
          .filter((issue) => issue.severity === SyncPlanIssueSeverity.ERROR)
          .map((issue) => issue.message)
          .join(", ")

        const syncPlanError = AppError.error(
          "Sync plan creation failed: " + errorMessages,
          "ManualModeController.createSyncPlan"
        )
        this.emit(SyncEvent.SYNC_ERROR, syncPlanError)

        this.ui?.completeOperation(SyncOperationResult.ERROR)

        return // Stop here, don't proceed with sync
      }

      // Perform sync
      const syncResult = await this.syncManager.performSync(syncPlan)

      // Emit appropriate event based on sync type
      if (this.isInitialSync) {
        this.isInitialSync = false
        this.emit(SyncEvent.INITIAL_SYNC_COMPLETE, syncResult)
      } else {
        this.emit(SyncEvent.SYNC_COMPLETE, syncResult)
        // Clear changed files after successful non-initial sync
        this.changedFiles.clear()
      }
      // Set back to ready state after operation completes
      this.ui?.setReady()
    } catch (error) {
      // Convert to AppError if it isn't already
      const appError =
        error instanceof AppError
          ? error
          : AppError.fatal(
              `Unexpected error during sync: ${getErrorMessage(error)}`,
              "WatchModeController.performSyncCycle",
              error
            )

      // Emit the error event
      this.emit(SyncEvent.SYNC_ERROR, appError)

      // Emitting a fatal error (above) will cause SyncManager to stop() this controller
    }
  }

  private setupKeyHandler(): void {
    if (this.keyHandler) {
      this.keyHandler.stop()
    }

    this.keyHandler = new KeyHandler({
      onEsc: async () => {
        try {
          await this.syncManager.stop()
        } catch (error) {
          // Convert to AppError and emit
          const appError = AppError.from(
            error,
            "Failed to stop sync manager",
            ErrorSeverity.ERROR,
            "WatchModeController.keyHandler"
          )
          this.emit(SyncEvent.SYNC_ERROR, appError)
        }
      },
      onCtrlC: async () => {
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
  }

  private async resolveWatchPatterns(): Promise<string[]> {
    try {
      // Get all unique file paths from glob patterns
      const uniqueSourcePaths = new Set<string>()

      for (const rule of this.config.rules) {
        const sourcePath = normalizePath(
          path.join(this.config.sourceRoot, rule.source),
          false // Don't strip trailing slash for globs
        )
        const matches = await glob(sourcePath, { absolute: true })
        matches.forEach((match) => uniqueSourcePaths.add(normalizePath(match)))
      }

      // Convert to array and store in watchedFiles
      const patterns = Array.from(uniqueSourcePaths)
      this.watchedFiles = new Set(patterns)

      return patterns
    } catch (error) {
      const appError = AppError.fatal(
        `Failed to resolve watch patterns: ${getErrorMessage(error)}`,
        "WatchModeController.resolveWatchPatterns",
        error
      )

      throw appError
    }
  }

  private async setupWatcher(): Promise<void> {
    try {
      // Get actual file paths to watch
      const patterns = await this.resolveWatchPatterns()

      this.watcher = watch(patterns, {
        ignoreInitial: true,
        awaitWriteFinish: {
          stabilityThreshold: 300,
          pollInterval: 100,
        },
      })

      this.watcher.on("change", async (changedPath) => {
        if (this.syncManager.getState() !== SyncManagerState.RUNNING) {
          return
        }

        // Update UI status
        this.ui?.startSyncOperation()

        try {
          await this.performSyncCycle(changedPath)
        } catch (error) {
          // Most error handling is done within performSyncCycle,
          // but fatal errors might be thrown
          if (
            error instanceof AppError &&
            error.severity === ErrorSeverity.FATAL
          ) {
            this.emit(
              SyncEvent.SYNC_ERROR,
              AppError.fatal(
                `Unexpected error during sync: ${getErrorMessage(error)}`,
                "WatchModeController.performSyncCycle",
                error
              )
            )
          } else {
            // For non-fatal errors, just log and continue watching
            console.log(
              `Problem occurred during sync: ${getErrorMessage(error)}`
            )
          }
        }
      })

      this.watcher.on("error", (error) => {
        const watcherError = AppError.fatal(
          `File watcher error: ${getErrorMessage(error)}`,
          "WatchModeController.watcher",
          error
        )
        this.emit(SyncEvent.SYNC_ERROR, watcherError)
      })
    } catch (error) {
      throw AppError.fatal(
        `Failed to setup file watcher: ${getErrorMessage(error)}`,
        "WatchModeController.setupWatcher",
        error
      )
    }
  }

  private async cleanup(): Promise<void> {
    await this.cleanupBase()

    if (this.watcher) {
      try {
        await this.watcher.close()
      } catch (err) {
        console.error(`Error closing watcher: ${err}`)
      }
      this.watcher = null
    }
    this.changedFiles.clear()
    this.watchedFiles.clear()
  }
}
