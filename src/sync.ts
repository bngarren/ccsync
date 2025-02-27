import { watch } from "chokidar"
import path from "node:path"
import type { Config } from "./config"
import { createLogger, type Logger } from "./log"
import {
  type Computer,
  type ValidationResult,
  type SyncResult,
  createTypedEmitter,
  type ManualSyncEvents,
  type WatchSyncEvents,
  SyncEvent,
  type ResolvedFileRule,
  type ComputerSyncResult,
} from "./types"
import {
  validateMinecraftSave,
  findMinecraftComputers,
  resolveSyncRules,
  copyFilesToComputer,
  normalizePath,
} from "./utils"
import { KeyHandler } from "./keys"
import { setTimeout } from "node:timers/promises"
import { glob } from "glob"
import { AppError, ErrorSeverity, getErrorMessage } from "./errors"
import { UI } from "./ui"

enum SyncManagerState {
  IDLE,
  STARTING,
  RUNNING,
  STOPPING,
  STOPPED,
  ERROR,
}

export class SyncManager {
  private log: Logger
  private ui: UI | null = null
  private activeModeController:
    | ManualModeController
    | WatchModeController
    | null = null
  private lastValidation: Readonly<{
    validation: Readonly<ValidationResult>
    computers: ReadonlyArray<Computer>
    timestamp: number
  }> | null = null

  // STATE
  private state: SyncManagerState = SyncManagerState.IDLE
  private setState(newState: SyncManagerState) {
    // const oldState = this.state
    this.state = newState
    // this.log.verbose(
    //   `State transition: ${SyncManagerState[oldState]} → ${SyncManagerState[newState]}`
    // );
  }

  constructor(private config: Config) {
    this.log = createLogger({ verbose: config.advanced.verbose })
  }

  // Public state query methods
  public isRunning(): boolean {
    return this.state === SyncManagerState.RUNNING
  }

  public getState(): SyncManagerState {
    return this.state
  }

  // Cache management
  private isCacheValid(): boolean {
    if (!this.lastValidation?.timestamp) return false
    if (this.activeModeController instanceof WatchModeController) return false

    const timeSinceLastValidation = Date.now() - this.lastValidation.timestamp
    this.log.verbose(`Time since last validation: ${timeSinceLastValidation}ms`)
    const isValid = timeSinceLastValidation < this.config.advanced.cache_ttl
    this.log.verbose(`Cache valid? ${isValid}`)

    return isValid
  }

  public invalidateCache(): void {
    this.lastValidation = null
  }

  // Core validation and sync methods
  public async runValidation(forceRefresh = false): Promise<ValidationResult> {
    if (!forceRefresh && this.isCacheValid()) {
      if (this.lastValidation?.validation) {
        this.log.verbose("Using cached validation results")
        return this.lastValidation.validation
      }
    }

    const result: ValidationResult = {
      resolvedFileRules: [],
      availableComputers: [],
      missingComputerIds: [],
      errors: [],
    }

    try {
      // Validate save directory
      const saveDirValidation = await validateMinecraftSave(
        this.config.minecraftSavePath
      )
      if (!saveDirValidation.isValid) {
        result.errors.push(...saveDirValidation.errors)
        return result
      }

      // Discover computers
      let computers: Computer[] = []
      try {
        computers = await findMinecraftComputers(this.config.minecraftSavePath)
      } catch (err) {
        result.errors.push(
          `Failed to find computers: ${err instanceof Error ? err.message : String(err)}`
        )
        return result
      }

      if (computers.length === 0) {
        result.errors.push(
          "No computers found in the save directory. Try adding a dummy file to a computer and then re-run CC:Sync."
        )
        return result
      }

      // Get changed files from watch mode if applicable
      const changedFiles =
        this.activeModeController instanceof WatchModeController
          ? this.activeModeController.getChangedFiles()
          : undefined

      // Validate the file sync rules
      const validation = await resolveSyncRules(
        this.config,
        computers,
        changedFiles
      )

      // If validation has errors, return them
      if (validation.errors.length > 0) {
        return validation
      }

      // Cache successful validation results
      this.lastValidation = {
        validation,
        computers,
        timestamp: Date.now(),
      }
      return validation
    } catch (err) {
      // For unexpected errors (not validation errors), add to result
      result.errors.push(
        `Unexpected validation error: ${err instanceof Error ? err.message : String(err)}`
      )
      this.lastValidation = null
      return result
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
    await setTimeout(250) // Small delay between computers

    return {
      computerId: computer.id,
      ...copyResult,
    }
  }

  public async performSync(validation: ValidationResult): Promise<SyncResult> {
    if (this.state !== SyncManagerState.RUNNING) {
      throw new Error("Cannot perform sync when not in RUNNING state")
    }

    const computerResults: ComputerSyncResult[] = []

    const allComputerIds = new Set<string>()

    // First create entries for all computers
    for (const rule of validation.resolvedFileRules) {
      for (const computerId of rule.computers) {
        // Create computer if it doesn't exist yet
        if (!allComputerIds.has(computerId)) {
          allComputerIds.add(computerId)

          // Check if this is a missing computer
          const isExisting = validation.availableComputers.some(
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
        let targetPath = rule.target.path

        // If target is a directory, append the source filename
        if (rule.target.type === "directory") {
          const sourceFilename = path.basename(rule.sourceAbsolutePath)
          targetPath = path.join(targetPath, sourceFilename)
          targetPath = normalizePath(targetPath)
        }

        // Add file entry with explicit type information
        computerResult.files.push({
          targetPath,
          targetType: rule.target.type,
          sourcePath: rule.sourceAbsolutePath,
          success: false, // Mark all as unsuccessful initially
        })
      }
    }

    // Update UI status
    if (this.ui) {
      this.ui.updateStatus("running", "Syncing files to computers...")
    }

    const result: SyncResult = {
      successCount: 0,
      errorCount: 0,
      missingCount: validation.missingComputerIds.length,
    }

    // Process each computer
    for (const computer of validation.availableComputers) {
      const syncResult = await this.syncToComputer(
        computer,
        validation.resolvedFileRules
      )

      // Find this computer in our results array
      const computerResult = computerResults.find(
        (cr) => cr.computerId === computer.id
      )
      if (!computerResult) continue // Should never happen but TypeScript needs this check

      // Process all copied files (successes)
      for (const filePath of syncResult.copiedFiles) {
        // Find the rule for this file to get target path
        const rule = validation.resolvedFileRules.find(
          (rule) =>
            rule.sourceAbsolutePath === filePath &&
            rule.computers.includes(computer.id)
        )

        if (rule) {
          // Build the complete target path including filename
          let targetPath = rule.target.path

          if (rule.target.type === "directory") {
            const filename = path.basename(filePath)
            targetPath = path.join(targetPath, filename)
            targetPath = normalizePath(targetPath)
          }

          // Find and update the file entry
          const fileEntry = computerResult.files.find(
            (f) => f.targetPath === targetPath
          )
          if (fileEntry) {
            fileEntry.success = true
          }
        }
      }

      // Log any errors
      if (syncResult.errors.length > 0) {
        if (this.ui) {
          this.ui.updateStatus(
            "error",
            `Error copying files to computer ${computer.id}: ${syncResult.errors[0]}`
          )
        }
        syncResult.errors.forEach((error) => this.log.warn(`  ${error}`))
        result.errorCount++
      } else if (syncResult.copiedFiles.length > 0) {
        result.successCount++
      }
    }

    // Determine overall status
    const statusMessage = ""
    let status: "success" | "error" | "partial" = "success"

    if (result.errorCount === 0 && result.missingCount === 0) {
      status = "success"
      // statusMessage = "Sync completed successfully!"
    } else if (result.successCount === 0) {
      status = "error"
      // statusMessage = "Sync failed. No computers were updated."
    } else {
      status = "partial"
      // statusMessage = "Partial sync completed with some errors."
    }

    // Update UI with final status
    if (this.ui) {
      this.ui.updateStats({
        success: result.successCount,
        error: result.errorCount,
        missing: result.missingCount,
      })
      this.ui.updateComputerResults(computerResults)
      this.ui.updateStatus(status, statusMessage)
      console.log("status updated")
    }

    // Cache invalidation for watch mode
    if (this.activeModeController instanceof WatchModeController) {
      this.invalidateCache()
    }

    console.log("About to return from performSync")

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
      this.ui = new UI(this.config.sourceRoot, "manual")

      const manualController = new ManualModeController(this, this.log, this.ui)
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
        // Handle based on severity
        if (error.severity === ErrorSeverity.FATAL) {
          this.setState(SyncManagerState.ERROR)
          await this.stop()
        }

        if (this.ui) {
          this.ui.updateStatus("error", error.message)
        }

        console.error(error)
      })

      try {
        await manualController.start()
      } catch (error) {
        // Controller start failed - this is a fatal error
        this.setState(SyncManagerState.ERROR)

        await this.stop()

        // Convert to SyncErrorData and rethrow
        throw AppError.fatal(
          `Failed to start manual mode: ${getErrorMessage(error)}`,
          "SyncManager.startManualMode",
          error
        )
      }
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
      this.ui = new UI(this.config.sourceRoot, "watch")

      const watchController = new WatchModeController(
        this,
        this.config,
        this.log,
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
        // Handle based on severity
        if (error.severity === ErrorSeverity.FATAL) {
          this.setState(SyncManagerState.ERROR)
          await this.stop()
        }

        if (this.ui) {
          this.ui.updateStatus("error", error.message)
        }
      })

      try {
        await watchController.start()
      } catch (error) {
        // Controller start failed - this is a fatal error
        this.setState(SyncManagerState.ERROR)

        await this.stop()

        // Convert to AppError and rethrow
        throw AppError.fatal(
          `Failed to start watch mode: ${getErrorMessage(error)}`,
          "SyncManager.startWatchMode",
          error
        )
      }

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

class ManualModeController {
  private keyHandler: KeyHandler | null = null
  protected events = createTypedEmitter<ManualSyncEvents>()

  constructor(
    private syncManager: SyncManager,
    private log: Logger,
    private ui: UI | null = null
  ) {}

  emit<K extends keyof ManualSyncEvents>(
    event: K,
    data?: ManualSyncEvents[K] extends void ? void : ManualSyncEvents[K]
  ) {
    return this.events.emit(event, data)
  }

  on<K extends keyof ManualSyncEvents>(
    event: K,
    listener: ManualSyncEvents[K] extends void
      ? () => void
      : (data: ManualSyncEvents[K]) => void
  ) {
    this.events.on(event, listener)
  }

  once<K extends keyof ManualSyncEvents>(
    event: K,
    listener: ManualSyncEvents[K] extends void
      ? () => void
      : (data: ManualSyncEvents[K]) => void
  ) {
    this.events.once(event, listener)
  }

  off<K extends keyof ManualSyncEvents>(
    event: K,
    listener: ManualSyncEvents[K] extends void
      ? () => void
      : (data: ManualSyncEvents[K]) => void
  ) {
    this.events.off(event, listener)
  }

  async start(): Promise<void> {
    this.emit(SyncEvent.STARTED) // Signal ready to run

    try {
      this.ui?.clear()

      while (this.syncManager.getState() === SyncManagerState.RUNNING) {
        await this.performSyncCycle()
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

    try {
      const validation = await this.syncManager.runValidation()
      this.emit(SyncEvent.SYNC_VALIDATION, validation)

      // console.log("ManualModeController>performSyncCycle", { validation })

      // Check if validation has errors
      if (validation.errors.length > 0) {
        this.ui?.stop()

        // this.log.error(`Could not continue due to the following errors:`)
        // validation.errors.forEach((error) =>
        //   this.log.error(`${validation.errors.length > 1 ? "• " : ""}${error}`)
        // )

        // Create an AppError and emit it
        const validationError = AppError.error(
          "Validation failed: " + validation.errors.join(", "),
          "ManualModeController.validation"
        )
        this.emit(SyncEvent.SYNC_ERROR, validationError)

        return // Stop here, don't proceed with sync
      }

      const { successCount, errorCount, missingCount } =
        await this.syncManager.performSync(validation)

      this.emit(SyncEvent.SYNC_COMPLETE, {
        successCount,
        errorCount,
        missingCount,
      })
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

      // For fatal errors, rethrow to properly terminate the controller
      if (appError.severity === ErrorSeverity.FATAL) {
        throw appError
      }
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
    if (this.keyHandler) {
      this.keyHandler.stop()
      this.keyHandler = null
    }
  }
}

class WatchModeController {
  private watcher: ReturnType<typeof watch> | null = null
  private keyHandler: KeyHandler | null = null
  /**
   * Files being watched or tracked for file changes
   */
  private watchedFiles: Set<string> = new Set()
  /**
   * Temp set of files that have just changed that will be synced. Clear when synced.
   */
  private changedFiles: Set<string> = new Set()

  private isInitialSync = true
  protected events = createTypedEmitter<WatchSyncEvents>()

  constructor(
    private syncManager: SyncManager,
    private config: Config,
    private log: Logger,
    private ui: UI | null = null
  ) {}

  emit<K extends keyof WatchSyncEvents>(
    event: K,
    data?: WatchSyncEvents[K] extends void ? void : WatchSyncEvents[K]
  ) {
    return this.events.emit(event, data)
  }

  on<K extends keyof WatchSyncEvents>(
    event: K,
    listener: WatchSyncEvents[K] extends void
      ? () => void
      : (data: WatchSyncEvents[K]) => void
  ) {
    this.events.on(event, listener)
  }

  once<K extends keyof WatchSyncEvents>(
    event: K,
    listener: WatchSyncEvents[K] extends void
      ? () => void
      : (data: WatchSyncEvents[K]) => void
  ) {
    this.events.once(event, listener)
  }

  off<K extends keyof WatchSyncEvents>(
    event: K,
    listener: WatchSyncEvents[K] extends void
      ? () => void
      : (data: WatchSyncEvents[K]) => void
  ) {
    this.events.off(event, listener)
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

    try {
      // If this is triggered by a file change, update the changedFiles set
      if (changedPath) {
        const relativePath = normalizePath(
          path.relative(this.config.sourceRoot, changedPath)
        )
        this.changedFiles.add(relativePath)
        this.syncManager.invalidateCache()
        // this.log.status(`File changed: ${changedPath}`)

        // Update UI without triggering a full re-render
        if (this.ui) {
          this.ui.updateStatus(
            "running",
            `Syncing changed file: ${path.basename(changedPath)}`
          )
        }
      }

      // Perform validation
      const validation = await this.syncManager.runValidation(true)
      this.emit(SyncEvent.SYNC_VALIDATION, validation)

      // Check if validation has errors
      if (validation.errors.length > 0) {
        // Log the validation errors
        // this.log.error(`Validation failed:`)
        // validation.errors.forEach((error) =>
        //   this.log.error(`${validation.errors.length > 1 ? "• " : ""}${error}`)
        // )

        const severity = this.isInitialSync
          ? ErrorSeverity.FATAL
          : ErrorSeverity.ERROR

        const validationError = AppError.from(
          new Error(validation.errors.join(", ")),
          "Validation failed",
          severity,
          "WatchModeController.validation"
        )

        // Emit sync error event with AppError format
        this.emit(SyncEvent.SYNC_ERROR, validationError)

        // For initial sync, throw to abort startup
        if (this.isInitialSync) {
          throw validationError
        }

        return // Don't proceed with sync
      }

      // Perform sync
      const { successCount, errorCount, missingCount } =
        await this.syncManager.performSync(validation)

      // Emit appropriate event based on sync type
      if (this.isInitialSync) {
        this.isInitialSync = false
        this.emit(SyncEvent.INITIAL_SYNC_COMPLETE, {
          successCount,
          errorCount,
          missingCount,
        })
      } else {
        this.emit(SyncEvent.SYNC_COMPLETE, {
          successCount,
          errorCount,
          missingCount,
        })
        // Clear changed files after successful non-initial sync
        this.changedFiles.clear()
      }
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

      // For fatal errors or initial sync, rethrow to properly terminate the controller
      if (appError.severity === ErrorSeverity.FATAL || this.isInitialSync) {
        throw appError
      }
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

      if (this.ui) {
        this.ui.updateStatus("error", appError.message)
      }

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

        try {
          await this.performSyncCycle(changedPath)
        } catch (error) {
          // Most error handling is done within performSyncCycle,
          // but fatal errors might be thrown
          if (
            error instanceof AppError &&
            error.severity === ErrorSeverity.FATAL
          ) {
            // For fatal errors, we need to stop watching
            await this.syncManager.stop().catch((stopError) => {
              this.log.error(
                `Failed to stop after fatal error: ${getErrorMessage(stopError)}`
              )
            })
          } else {
            // For non-fatal errors, just update UI and continue watching
            if (this.ui) {
              this.ui.updateStatus(
                "error",
                `Problem occurred during sync: ${getErrorMessage(error)}`
              )
            }
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
    if (this.keyHandler) {
      this.keyHandler.stop()
      this.keyHandler = null
    }

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
