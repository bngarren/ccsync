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
} from "./types"
import {
  validateMinecraftSave,
  findMinecraftComputers,
  validateFileSync,
  getFormattedDate,
  copyFilesToComputer,
} from "./utils"
import { theme } from "./theme"
import * as p from "@clack/prompts"
import { KeyHandler } from "./keys"
import { setTimeout } from "node:timers/promises"
import { glob } from "glob"

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

    // Validate save directory
    const saveDirValidation = await validateMinecraftSave(
      this.config.minecraftSavePath
    )
    if (!saveDirValidation.isValid) {
      throw new Error(saveDirValidation.errors[0])
    }

    // Discover computers
    const computers = await findMinecraftComputers(
      this.config.minecraftSavePath
    )
    if (computers.length === 0) {
      this.log.error("No computers found in the save directory.")
      this.log.info(
        "Sometimes a computer placed in the world isn't fully loaded until its file system is modified. Try adding a dummy file and then re-run CC:Sync."
      )
      throw new Error("No computers found in the save directory")
    }

    // Get changed files from watch mode if applicable
    const changedFiles =
      this.activeModeController instanceof WatchModeController
        ? this.activeModeController.getChangedFiles()
        : undefined

    try {
      const validation = await validateFileSync(
        this.config,
        computers,
        changedFiles
      )

      if (validation.errors.length > 0) {
        this.log.error(`Could not continue due to the following errors:`)
        validation.errors.forEach((error) =>
          this.log.error(`${validation.errors.length > 1 ? "• " : ""}${error}`)
        )
        throw new Error("File sync validation failed")
      }

      // Cache validation results
      this.lastValidation = {
        validation,
        computers,
        timestamp: Date.now(),
      }
      return validation
    } catch (err) {
      this.lastValidation = null
      throw err
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

    const spinner = p.spinner()
    const result: SyncResult = {
      successCount: 0,
      errorCount: 0,
      missingCount: 0,
    }
    const fileResults = new Map<
      string,
      Array<{ computerId: string; success: boolean }>
    >()

    // Initialize results map
    for (const file of validation.resolvedFileRules) {
      const relativePath = path.relative(
        this.config.sourceRoot,
        file.sourcePath
      )
      fileResults.set(relativePath, [])
    }

    // Process each computer
    for (const computer of validation.availableComputers) {
      spinner.start(`Copying files to computer ${computer.id}`)

      const syncResult = await this.syncToComputer(
        computer,
        validation.resolvedFileRules
      )

      // Record results for each file
      syncResult.copiedFiles.forEach((filePath) => {
        const relativePath = path.relative(this.config.sourceRoot, filePath)
        const results = fileResults.get(relativePath) ?? []
        results.push({ computerId: computer.id, success: true })
        fileResults.set(relativePath, results)
      })

      syncResult.skippedFiles.forEach((filePath) => {
        const relativePath = path.relative(this.config.sourceRoot, filePath)
        const results = fileResults.get(relativePath) ?? []
        results.push({ computerId: computer.id, success: false })
        fileResults.set(relativePath, results)
      })

      // Log any errors
      if (syncResult.errors.length > 0) {
        spinner.stop(`Error copying files to computer ${computer.id}:`)
        syncResult.errors.forEach((error) => this.log.warn(`  ${error}`))
        result.errorCount++
      } else if (syncResult.copiedFiles.length > 0) {
        result.successCount++
      }
    }

    spinner.stop("Sync finished.")

    // Display final status for each file
    for (const [filePath, results] of fileResults.entries()) {
      const file = validation.resolvedFileRules.find(
        (f) => path.relative(this.config.sourceRoot, f.sourcePath) === filePath
      )
      if (!file) continue

      // Add missing computers as failed results
      file.computers.forEach((computerId) => {
        if (validation.missingComputerIds.some((mc) => mc === computerId)) {
          results.push({ computerId, success: false })
          result.missingCount++
        }
      })

      // Sort and display results
      const sortedResults = results.sort((a, b) =>
        a.computerId.localeCompare(b.computerId)
      )

      const computerStatus = sortedResults
        .map(
          (r) =>
            `${r.computerId}${
              r.success ? theme.success("✓") : theme.error("✗")
            }`
        )
        .join(" ")

      this.log.info(
        `  ${theme.success("✓")} ${filePath} ${theme.dim(
          `→ ${file.targetPath}`
        )} ${theme.dim("[")}${computerStatus}${theme.dim("]")}`
      )
    }

    // Cache invalidation for watch mode
    if (this.activeModeController instanceof WatchModeController) {
      this.invalidateCache()
    }

    return result
  }
  async startManualMode(): Promise<ManualModeController> {
    if (this.state !== SyncManagerState.IDLE) {
      throw new Error(
        `Cannot start manual mode in state: ${SyncManagerState[this.state]}`
      )
    }

    try {
      this.setState(SyncManagerState.STARTING)
      const manualController = new ManualModeController(this, this.log)
      this.activeModeController = manualController

      // Listen for controller state changes
      manualController.on(SyncEvent.STARTED, () => {
        this.setState(SyncManagerState.RUNNING)
      })

      // Listen for controller state changes
      manualController.on(SyncEvent.STOPPED, () => {
        this.setState(SyncManagerState.STOPPED)
      })

      manualController.on(SyncEvent.SYNC_ERROR, ({ fatal }) => {
        if (fatal) {
          this.setState(SyncManagerState.ERROR)
          this.stop()
        }
      })

      // Start the controller
      manualController.start().catch((error) => {
        this.setState(SyncManagerState.ERROR)
        this.log.error(`Controller failed to start: ${error}`)
        this.stop()
      })

      return manualController
    } catch (error) {
      this.setState(SyncManagerState.ERROR)
      throw error
    }
  }
  async startWatchMode(): Promise<WatchModeController> {
    if (this.state !== SyncManagerState.IDLE) {
      throw new Error(
        `Cannot start watch mode in state: ${SyncManagerState[this.state]}`
      )
    }

    try {
      this.setState(SyncManagerState.STARTING)
      const watchController = new WatchModeController(
        this,
        this.config,
        this.log
      )
      this.activeModeController = watchController

      // Listen for controller state changes
      watchController.on(SyncEvent.STARTED, () => {
        this.setState(SyncManagerState.RUNNING)
      })

      watchController.on(SyncEvent.STOPPED, () => {
        this.setState(SyncManagerState.STOPPED)
      })

      watchController.on(SyncEvent.SYNC_ERROR, ({ fatal }) => {
        if (fatal) {
          this.setState(SyncManagerState.ERROR)
          this.stop()
        }
      })

      // Start the controller
      watchController.start().catch((error) => {
        this.setState(SyncManagerState.ERROR)
        this.log.error(`Controller failed to start: ${error}`)
        this.stop()
      })

      return watchController
    } catch (error) {
      this.setState(SyncManagerState.ERROR)
      throw error
    }
  }

  async stop(): Promise<void> {
    if (
      this.state === SyncManagerState.STOPPED ||
      this.state === SyncManagerState.STOPPING
    )
      return

    this.setState(SyncManagerState.STOPPING)

    try {
      if (this.activeModeController) {
        await this.activeModeController.stop()
        this.activeModeController = null
      }
      this.setState(SyncManagerState.STOPPED)
    } catch (error) {
      this.setState(SyncManagerState.ERROR)
      throw error
    }
  }
}

class ManualModeController {
  private keyHandler: KeyHandler | null = null
  protected events = createTypedEmitter<ManualSyncEvents>()

  constructor(
    private syncManager: SyncManager,
    private log: Logger
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
    this.log.status(`CC: Sync manual mode started at ${getFormattedDate()}`)

    try {
      while (this.syncManager.getState() === SyncManagerState.RUNNING) {
        await this.performSyncCycle()

        this.log.step(theme.bold("[Press SPACE to re-sync or ESC to exit...] "))
        await this.waitForUserInput()
      }
    } catch (error) {
      this.log.error(`Sync error: ${error}`)
      throw error
    } finally {
      await this.cleanup()
    }
  }

  async stop(): Promise<void> {
    await this.cleanup()
    this.emit(SyncEvent.STOPPED)
  }

  private async performSyncCycle(): Promise<void> {
    if (this.syncManager.getState() !== SyncManagerState.RUNNING) {
      throw new Error("Cannot perform sync when not in RUNNING state")
    }

    try {
      const validation = await this.syncManager.runValidation()

      this.emit(SyncEvent.SYNC_VALIDATION, validation)

      const { successCount, errorCount, missingCount } =
        await this.syncManager.performSync(validation)

      const fDate = theme.gray(`@ ${getFormattedDate()}`)
      const totalFails = errorCount + missingCount

      if (totalFails === 0) {
        this.log.success(`Successful sync. ${fDate}`)
      } else if (
        totalFails ===
        validation.availableComputers.length +
          validation.missingComputerIds.length
      ) {
        this.log.error(`Sync failed. ${fDate}`)
      } else {
        this.log.warn(`Partial sync. ${fDate}`)
      }

      this.log.verbose(
        `Sync completed with ${successCount}/${
          successCount + errorCount
        } computers updated.`
      )

      this.emit(SyncEvent.SYNC_COMPLETE, {
        successCount,
        errorCount,
        missingCount,
      })
    } catch (err) {
      this.emit(SyncEvent.SYNC_ERROR, {
        error: err instanceof Error ? err : new Error(String(err)),
        fatal: true,
      })
      throw err
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
        await this.syncManager.stop()
        this.log.info("CC: Sync manual mode stopped.")
      },
      onCtrlC: async () => {
        await this.syncManager.stop()
        continueCallback()
        this.log.info("CC:Sync program terminated.")
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
    private log: Logger
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
      this.log.status(`CC: Sync watch mode started at ${getFormattedDate()}`)

      // Peform initial sync
      await this.performSyncCycle()

      if (this.syncManager.getState() !== SyncManagerState.RUNNING) return

      // Keep running until state changes
      while (this.syncManager.getState() === SyncManagerState.RUNNING) {
        await new Promise((resolve) => setTimeout(100, resolve))
      }
    } catch (error) {
      this.log.error(
        `Watch mode error: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      throw error
    } finally {
      await this.stop()
    }
  }

  async stop(): Promise<void> {
    await this.cleanup()
    this.emit(SyncEvent.STOPPED)
  }

  getChangedFiles(): Set<string> | undefined {
    return this.isInitialSync ? undefined : this.changedFiles
  }

  private async performSyncCycle(changedPath?: string): Promise<void> {
    if (this.syncManager.getState() !== SyncManagerState.RUNNING) {
      throw new Error("Cannot perform sync when not in RUNNING state")
    }

    try {
      // If this is triggered by a file change, update the changedFiles set
      if (changedPath) {
        const relativePath = path.relative(this.config.sourceRoot, changedPath)
        this.changedFiles.add(relativePath)
        this.syncManager.invalidateCache()
        this.log.status(`File changed: ${changedPath}`)
      }

      // Perform validation
      const validation = await this.syncManager.runValidation(true)
      this.emit(SyncEvent.SYNC_VALIDATION, validation)

      // Perform sync
      const { successCount, errorCount, missingCount } =
        await this.syncManager.performSync(validation)

      const totalFails = errorCount + missingCount
      const fDate = theme.gray(`@ ${getFormattedDate()}`)

      // Log appropriate message based on sync result
      if (totalFails === 0) {
        this.log.success(
          `${this.isInitialSync ? "Initial sync" : "Sync"} successful. ${fDate}`
        )
      } else if (
        totalFails ===
        validation.availableComputers.length +
          validation.missingComputerIds.length
      ) {
        this.log.error(
          `${this.isInitialSync ? "Initial sync" : "Sync"} failed. ${fDate}`
        )
      } else {
        this.log.warn(
          `${this.isInitialSync ? "Initial sync" : "Sync"} partial. ${fDate}`
        )
      }

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

      // Log watch message if not initial sync
      if (!this.isInitialSync) {
        this.logWatchStatus()
      }
    } catch (err) {
      // TODO determine if sync error is FATAL or not
      this.emit(SyncEvent.SYNC_ERROR, {
        error: err instanceof Error ? err : new Error(String(err)),
        fatal: true,
      })
      if (!this.isInitialSync) {
        this.logWatchStatus()
      }
      throw err
    }
  }

  private setupKeyHandler(): void {
    if (this.keyHandler) {
      this.keyHandler.stop()
    }

    this.keyHandler = new KeyHandler({
      onEsc: async () => {
        await this.syncManager.stop()
        this.log.info("CC: Sync watch mode stopped.")
      },
      onCtrlC: async () => {
        await this.syncManager.stop()
        this.log.info("CC: Sync program terminated.")
      },
    })

    this.keyHandler.start()
  }

  private async resolveWatchPatterns(): Promise<string[]> {
    try {
      // Get all unique file paths from glob patterns
      const uniqueSourcePaths = new Set<string>()

      for (const rule of this.config.rules) {
        const sourcePath = path.join(this.config.sourceRoot, rule.source)
        const matches = await glob(sourcePath, { absolute: true })
        matches.forEach((match) => uniqueSourcePaths.add(match))
      }

      // Convert to array and store in watchedFiles
      const patterns = Array.from(uniqueSourcePaths)
      this.watchedFiles = new Set(patterns)

      return patterns
    } catch (err) {
      this.log.error(`Failed to resolve watch patterns: ${err}`)
      throw err
    }
  }

  private async setupWatcher(): Promise<void> {
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
      } catch (err) {
        // Error handling is done within performSyncCycle
        // If err is FATAL emit a SyncEvent.SYNC_ERROR with fatal
        // If err is not fatal, inform user and keep watcher going...
        this.log.warn("Problem occurred during sync")
      }
    })

    this.watcher.on("error", (err) => {
      this.emit(SyncEvent.SYNC_ERROR, {
        error: err instanceof Error ? err : new Error(String(err)),
        fatal: true,
      })
    })
  }

  private logWatchStatus(): void {
    this.log.info("Watching for file changes...")
    this.log.step(theme.bold("[Press ESC to exit...]"))
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
        this.log.error(`Error closing watcher: ${err}`)
      }
      this.watcher = null
    }
    this.changedFiles.clear()
    this.watchedFiles.clear()
  }
}
