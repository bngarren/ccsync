import { setInterval, clearInterval, setTimeout } from "node:timers"

import logUpdate from "log-update"
import figures from "figures"
import chalk from "chalk"
import type { ResolvedFileRule } from "./types"
import path from "node:path"
import boxen from "boxen"
import { pluralize } from "./utils"

const theme = {
  primary: chalk.hex("#61AFEF"), // Bright blue
  secondary: chalk.hex("#98C379"), // Green
  highlight: chalk.hex("#C678DD"), // Purple
  warning: chalk.hex("#E5C07B"), // Yellow
  error: chalk.hex("#E06C75"), // Red
  dim: chalk.hex("#5C6370"), // Gray
  info: chalk.hex("#56B6C2"), // Cyan
  success: chalk.hex("#98C379"), // Green
  border: chalk.hex("#61AFEF"), // Blue borders
  normal: chalk.hex("#ABB2BF"), // Light gray for regular text
  subtle: chalk.hex("#4B5363"), // Darker gray for backgrounds
  bold: chalk.bold,
  heading: (str: string) => chalk.hex("#61AFEF").bold(str),
  keyHint: (str: string) => chalk.bgHex("#5C6370").hex("#FFFFFF")(` ${str} `),
}

// Symbols
const symbols = {
  check: figures.tick,
  cross: figures.cross,
  warning: figures.warning,
  info: figures.info,
  bullet: figures.bullet,
  pointer: figures.pointer,
  line: figures.line,
  ellipsis: figures.ellipsis,
}

interface CounterStats {
  success: number
  error: number
  missing: number
  total: number
}

interface FileResult {
  path: string
  targetPath: string
  results: Array<{ computerId: string; success: boolean }>
}

interface UIState {
  mode: "watch" | "manual"
  status: "idle" | "running" | "success" | "error" | "partial"
  stats: CounterStats
  fileResults: FileResult[]
  lastUpdated: Date
  message?: string
}

// Minimal interval between renders (ms)
const MIN_RENDER_INTERVAL = 50

export class UI {
  private state: UIState
  private timer: ReturnType<typeof setInterval> | null = null
  private isActive = false
  private sourceRoot: string
  private isRendering = false // lock to prevent concurrent renders
  private lastRenderTime = 0 // Timestamp of last render
  private renderTimer: ReturnType<typeof setTimeout> | null = null // Timer for debounced rendering
  private pendingStateUpdates: Partial<UIState> = {}
  private hasPendingUpdates = false
  private syncsComplete = 0

  constructor(sourceRoot: string, mode: "watch" | "manual") {
    // super();
    this.sourceRoot = sourceRoot
    this.state = {
      mode,
      status: "idle",
      stats: { success: 0, error: 0, missing: 0, total: 0 },
      fileResults: [],
      lastUpdated: new Date(),
    }

    this.setupTerminationHandlers()
  }

  private setupTerminationHandlers(): void {
    const cleanup = () => {
      this.stop()
    }
    // These will be automatically removed when the process exits
    process.on("SIGINT", cleanup)
    process.on("SIGTERM", cleanup)
    process.on("exit", cleanup)
  }

  // Clear the entire screen
  private clearScreen() {
    console.clear()
  }

  start(): void {
    // Clear any existing UI state
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    this.isActive = true
    this.isRendering = false
    this.hasPendingUpdates = false
    this.pendingStateUpdates = {}
    this.syncsComplete = 0

    this.clearScreen()

    // Start a refresh timer to update elapsed time
    this.timer = setInterval(() => {
      if (this.isActive) this.renderDynamicElements()
    }, 1000)

    console.log(
      theme.primary(
        `CC: Sync - ${this.state.mode.toUpperCase()} mode started at ${this.state.lastUpdated.toLocaleString()}\n`
      )
    )

    // Initial render of dynamic elements
    this.renderDynamicElements()
  }

  stop(): void {
    this.isActive = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    if (this.renderTimer) {
      clearTimeout(this.renderTimer)
      this.renderTimer = null
    }

    // Final clear of dynamic elements
    logUpdate.clear()
    logUpdate.done()
  }

  // Replace the existing updateStatus method
  updateStatus(status: UIState["status"], message?: string): void {
    const prevStatus = this.state.status

    // When status changes from "running" to a completion state
    if (
      prevStatus === "running" &&
      (status === "success" || status === "error" || status === "partial")
    ) {
      // First clear any dynamic content
      logUpdate.clear()

      // Then update the state
      this.state = {
        ...this.state,
        status,
        message: message !== undefined ? message : this.state.message,
        lastUpdated: new Date(),
      }

      // Log the static output
      this.logSyncSummary()

      // After logging static content, re-render dynamic elements
      this.renderDynamicElements()
      this.syncsComplete++
    } else {
      // For other status changes (including to "running"), use normal state updates
      this.queueStateUpdate({
        status,
        message: message !== undefined ? message : this.state.message,
        lastUpdated: new Date(),
      })
    }
  }

  updateStats(stats: Partial<CounterStats>): void {
    const updatedStats = {
      ...this.state.stats,
      ...stats,
    }

    updatedStats.total =
      (stats.success || this.state.stats.success) +
      (stats.error || this.state.stats.error) +
      (stats.missing || this.state.stats.missing)

    this.queueStateUpdate({ stats: updatedStats })
  }

  updateFileResults(
    resolvedFiles: ResolvedFileRule[],
    fileResults: Map<string, Array<{ computerId: string; success: boolean }>>
  ): void {
    const newFileResults: FileResult[] = []

    for (const [filePath, results] of fileResults.entries()) {
      const file = resolvedFiles.find(
        (f) => path.relative(this.sourceRoot, f.sourceAbsolutePath) === filePath
      )

      if (file) {
        newFileResults.push({
          path: filePath,
          targetPath: file.targetPath,
          results: results.sort((a, b) =>
            a.computerId.localeCompare(b.computerId)
          ),
        })
      }
    }

    this.queueStateUpdate({
      fileResults: newFileResults,
      lastUpdated: new Date(),
    })
  }

  clear(): void {
    logUpdate.clear()
  }

  private getStatusColor() {
    switch (this.state.status) {
      case "success":
        return theme.success
      case "error":
        return theme.error
      case "partial":
        return theme.warning
      case "running":
        return theme.info
      default:
        return theme.normal
    }
  }

  private getStatusSymbol(): string {
    switch (this.state.status) {
      case "success":
        return symbols.check
      case "error":
        return symbols.cross
      case "partial":
        return symbols.warning
      case "running":
        return symbols.line
      default:
        return symbols.info
    }
  }

  private formatElapsedTime(): string {
    const elapsed =
      (new Date().getTime() - this.state.lastUpdated.getTime()) / 1000
    if (elapsed < 60) return `${Math.floor(elapsed)}s ago`
    if (elapsed < 3600)
      return `${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s ago`
    return `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m ago`
  }

  private renderHeaderLine(): string {
    const { success, error, missing, total } = this.state.stats

    const date = this.state.lastUpdated.toLocaleString()

    return theme.bold(
      `#${this.syncsComplete + 1} [${this.state.mode.toUpperCase()}] [${date}] [Attempted to sync to ${total} ${pluralize("computer")(total)}] ` +
        `${theme.success(`Success: ${success}`)}. ` +
        `${error > 0 ? theme.error(`Error: ${error}`) : `Error: ${error}`}` +
        (missing > 0 ? `. ${theme.warning(`Missing: ${missing}`)}` : "")
    )
  }

  private renderFileResults(): string {
    if (this.state.fileResults.length === 0) {
      return theme.dim("  No files synced yet.")
    }

    // Reorganize data by computer
    const computerMap = new Map<
      string,
      {
        totalFiles: number
        successFiles: number
        fileDetails: Array<{
          sourcePath: string
          targetPath: string
          success: boolean
        }>
      }
    >()

    // Process and organize file results by computer
    for (const file of this.state.fileResults) {
      for (const result of file.results) {
        if (!computerMap.has(result.computerId)) {
          computerMap.set(result.computerId, {
            totalFiles: 0,
            successFiles: 0,
            fileDetails: [],
          })
        }

        const computerData = computerMap.get(result.computerId)!
        computerData.totalFiles++

        if (result.success) {
          computerData.successFiles++
        }

        computerData.fileDetails.push({
          sourcePath: file.path,
          targetPath: file.targetPath,
          success: result.success,
        })
      }
    }

    // Sort computers numerically if possible
    const sortedComputers = Array.from(computerMap.keys()).sort((a, b) => {
      const numA = parseInt(a, 10)
      const numB = parseInt(b, 10)

      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB
      }
      return a.localeCompare(b)
    })

    let output = ""

    // Generate output for each computer with simplified file list
    for (const computerId of sortedComputers) {
      const data = computerMap.get(computerId)!
      const fileCount = `(${data.successFiles}/${data.totalFiles})`

      output += `\n  Computer ${computerId} ${theme.dim(fileCount)}: `

      // Group files by target path for cleaner display
      const filesByTarget = new Map<string, boolean>()

      data.fileDetails.forEach((file) => {
        // Store success status for each target path
        // If we have multiple files for the same target, consider it successful
        // only if all files succeeded
        const currentSuccess = filesByTarget.get(file.targetPath)
        if (currentSuccess === undefined) {
          filesByTarget.set(file.targetPath, file.success)
        } else {
          filesByTarget.set(file.targetPath, currentSuccess && file.success)
        }
      })

      // Format the file list with target paths
      const targetPaths = Array.from(filesByTarget.entries()).map(
        ([targetPath, success]) => {
          return success ? theme.success(targetPath) : theme.error(targetPath)
        }
      )

      output += targetPaths.join(", ")
    }

    return output
  }

  private getStatusMessage(): string {
    // Use custom message if available, otherwise default based on status
    const message = this.state.message || this.getDefaultStatusMessage()

    const messageColor =
      this.state.status === "error"
        ? theme.error
        : this.state.status === "partial"
          ? theme.warning
          : this.state.status === "success"
            ? theme.success
            : theme.info

    return messageColor(message)
  }

  private getDefaultStatusMessage(): string {
    switch (this.state.status) {
      case "success":
        return "Sync completed successfully."
      case "error":
        return "Sync failed. No computers were updated."
      case "partial":
        return "Partial sync completed with some errors."
      case "running":
        return "Sync in progress..."
      default:
        return "Waiting to sync..."
    }
  }

  private renderControls(): string {
    const controls = [
      { key: "SPACE", desc: "Re-sync", mode: "manual" },
      { key: "ESC", desc: "Exit" },
    ].filter((c) => !c.mode || c.mode === this.state.mode)

    return boxen(
      controls
        .map((c) => `${theme.keyHint(c.key)} ${theme.normal(c.desc)}`)
        .join("   "),
      {
        padding: 0.5,
        margin: { top: 1, left: 0 },
        borderStyle: "round",
        borderColor: "cyan",
        title: "Controls",
        titleAlignment: "center",
      }
    )
  }

  private queueStateUpdate(update: Partial<UIState>): void {
    if (!this.isActive) return

    // Merge the update with any pending updates
    this.pendingStateUpdates = { ...this.pendingStateUpdates, ...update }
    this.hasPendingUpdates = true

    // Queue a render to apply these updates
    this.queueRender()
  }

  private applyPendingUpdates(): void {
    if (!this.hasPendingUpdates) return

    // Apply all pending updates to the state
    this.state = { ...this.state, ...this.pendingStateUpdates }

    // Reset pending updates
    this.pendingStateUpdates = {}
    this.hasPendingUpdates = false
  }

  private queueRender(): void {
    if (!this.isActive) return

    // If already rendering, mark that another render is needed
    if (this.isRendering) {
      return
    }

    // If a render is already queued, don't queue another one
    if (this.renderTimer) return

    // Determine delay before next render
    const now = Date.now()
    const timeSinceLastRender = now - this.lastRenderTime
    const delay = Math.max(0, MIN_RENDER_INTERVAL - timeSinceLastRender)

    // Queue the render with appropriate delay
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null
      this.renderDynamicElements()
    }, delay)
  }

  // This logs the sync results to the console and doesn't use logUpdate
  private logSyncSummary(): void {
    // Force apply any pending updates first
    this.applyPendingUpdates()

    const header = this.renderHeaderLine()
    const fileResults = this.renderFileResults()
    const statusMessage = this.getStatusMessage()

    // Log the static output
    console.log("\n" + header)
    console.log(fileResults)
    console.log("\n" + statusMessage)
    console.log(theme.dim("─".repeat(process.stdout.columns || 80))) // Separator line
  }

  // This renders the dynamic elements that change frequently with logUpdate
  private renderDynamicElements(): void {
    if (!this.isActive) return

    this.isRendering = true

    try {
      // Apply any pending state updates
      this.applyPendingUpdates()

      // Only show status indicator if we're in running state
      const statusIndicator =
        this.state.status === "running"
          ? `\n${symbols.line} ${this.getStatusMessage()} ${theme.dim(`(${this.formatElapsedTime()})`)}`
          : ""

      // Render controls and status
      logUpdate(this.renderControls() + statusIndicator)

      this.lastRenderTime = Date.now()
    } catch (error) {
      console.error("UI rendering error:", error)
    } finally {
      this.isRendering = false
    }
  }
}
