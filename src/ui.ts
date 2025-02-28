import { setInterval, clearInterval, setTimeout } from "node:timers"

import logUpdate from "log-update"
import figures from "figures"
import chalk from "chalk"
import type { ComputerSyncResult } from "./types"
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

interface UIState {
  mode: "watch" | "manual"
  status: "idle" | "running" | "success" | "error" | "partial"
  stats: CounterStats
  computerResults: ComputerSyncResult[]
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

  // Add a class property to track the spinner animation
  private spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  private spinnerIndex = 0

  constructor(sourceRoot: string, mode: "watch" | "manual") {
    // super();
    this.sourceRoot = sourceRoot
    this.state = {
      mode,
      status: "idle",
      stats: { success: 0, error: 0, missing: 0, total: 0 },
      computerResults: [],
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
    this.spinnerIndex = 0

    this.clearScreen()

    // Start a refresh timer to update elapsed time and spinner
    this.timer = setInterval(() => {
      if (this.isActive) {
        // Update spinner index
        this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length
        this.renderDynamicElements()
      }
    }, 100)

    console.log(
      theme.primary(
        `\nCC: Sync - ${this.state.mode.toUpperCase()} mode started at ${this.state.lastUpdated.toLocaleString()}`
      )
    )
    console.log(theme.primary("─".repeat(process.stdout.columns || 80)) + "\n")

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
      prevStatus === "running" ||
      (prevStatus === "idle" &&
        (status === "success" || status === "error" || status === "partial"))
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

  updateComputerResults(computerResults: ComputerSyncResult[]): void {
    this.queueStateUpdate({
      computerResults,
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

    let resultStats = ""

    if (success > 0 && error === 0 && missing === 0) {
      resultStats = `${theme.success(`Success.`)}`
    } else {
      resultStats =
        `${success > 0 ? theme.success(`Success: ${success}`) : ""} ` +
        `${error > 0 ? theme.error(`Error: ${error}`) : ""} ` +
        (missing > 0 ? `${theme.warning(`Missing: ${missing}`)}` : "")
    }

    return theme.bold(
      `#${this.syncsComplete + 1} [${this.state.mode.toUpperCase()}] [${date}] [Attempted to sync to ${total} ${pluralize("computer")(total)}] ` +
        resultStats
    )
  }

  private renderComputerResults(): string {
    if (this.state.computerResults.length === 0) {
      return theme.dim("  No files synced.")
    }

    // Sort computers numerically if possible
    const sortedComputers = [...this.state.computerResults].sort((a, b) => {
      const numA = parseInt(a.computerId, 10)
      const numB = parseInt(b.computerId, 10)

      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB
      }
      return a.computerId.localeCompare(b.computerId)
    })

    let output = ""

    // Generate output for each computer
    for (const computer of sortedComputers) {
      // Determine computer status icon
      let statusIcon
      let statusColor

      if (!computer.exists) {
        statusIcon = symbols.cross
        statusColor = theme.error
      } else if (computer.files.length === 0) {
        statusIcon = symbols.warning
        statusColor = theme.warning
      } else {
        const allSuccess = computer.files.every((f) => f.success)
        const anySuccess = computer.files.some((f) => f.success)

        if (allSuccess) {
          statusIcon = symbols.check
          statusColor = theme.success
        } else if (anySuccess) {
          statusIcon = symbols.warning
          statusColor = theme.warning
        } else {
          statusIcon = symbols.cross
          statusColor = theme.error
        }
      }

      // Start line with status icon and computer ID
      output += `  ${statusColor(statusIcon)} Computer ${computer.computerId}: `

      // Summarize success/fail counts
      const successCount = computer.files.filter((f) => f.success).length
      const totalCount = computer.files.length
      output += theme.dim(`(${successCount}/${totalCount}) `)

      if (!computer.exists) {
        output += theme.warning("Missing computer")
        continue
      }

      if (computer.files.length === 0) {
        output += theme.dim("No files synced")
        continue
      }

      // Format file targets on same line
      const fileTargets = computer.files.map((file) => {
        const fileIcon = file.success ? symbols.check : symbols.cross
        const iconColor = file.success ? theme.success : theme.error

        // Just use the targetPath directly since it's already been properly
        // formatted in performSync to include the filename for directory targets
        const displayPath =
          file.targetPath === "/" ? "/<error>" : file.targetPath

        return `${iconColor(fileIcon)} ${file.success ? displayPath : theme.dim(displayPath)}`
      })

      output += fileTargets.join(" | ") + "\n"
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

    return this.state.status !== "success"
      ? messageColor("\n" + "  " + message)
      : ""
  }

  private getDefaultStatusMessage(): string {
    switch (this.state.status) {
      case "success":
        return "Sync completed successfully."
      case "error":
        return "Sync failed. No computers were updated."
      case "partial":
        return "Not all files were synced. See above output."
      case "running":
        return "Sync in progress..."
      default:
        return "Waiting to sync..."
    }
  }

  private renderControls(title = "Controls"): string {
    const controls = [
      { key: "SPACE", desc: "Re-sync", mode: "manual" },
      { key: "ESC", desc: "Exit" },
    ].filter((c) => !c.mode || c.mode === this.state.mode)

    // Add spinner to title
    const spinner = this.spinnerFrames[this.spinnerIndex]
    const titleWithSpinner = `${spinner} ${title}`

    if (this.state.status === "running") {
      return ""
    }

    return boxen(
      controls
        .map((c) => `${theme.keyHint(c.key)} ${theme.normal(c.desc)}`)
        .join("   "),
      {
        padding: 1,
        margin: { top: 1, left: 1 },
        borderStyle: "round",
        borderColor: "cyan",
        title: titleWithSpinner,
        titleAlignment: "center",
        textAlignment: "center",
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
    const computerResults = this.renderComputerResults()
    const statusMessage = this.getStatusMessage()

    // Log the static output
    console.log(header)
    console.log(computerResults)
    console.log(statusMessage)
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
        this.state.status === "running" ? `\n${this.getStatusMessage()}` : ""

      const controlsTitle =
        this.state.mode === "manual"
          ? "Awaiting user input..."
          : "Watching for file changes..."

      // Render controls and status
      logUpdate(statusIndicator + this.renderControls(controlsTitle))

      this.lastRenderTime = Date.now()
    } catch (error) {
      console.error("UI rendering error:", error)
    } finally {
      this.isRendering = false
    }
  }
}
