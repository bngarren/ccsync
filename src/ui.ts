import { setInterval, clearInterval, setTimeout } from "node:timers"

import logUpdate from "log-update"
import figures from "figures"
import chalk from "chalk"
import {
  SyncOperationResult,
  type ComputerSyncResult,
  type SyncMode,
} from "./types"
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

export enum UIStatus {
  /**
   * No controller active, initial state
   */
  IDLE = "idle",
  /**
   * Controller active, awaiting user input
   */
  READY = "ready",
  /**
   * // Active sync operation (file(s) copying) in progress
   */
  SYNCING = "syncing",
  /**
   * // Fatal error, application stopping
   */
  TERMINATED = "terminated",
}

/**
 * Types of UI notifications that can be presented to the user
 */
export enum UIMessageType {
  INFO = "info",
  WARNING = "warning",
  ERROR = "error",
}

// A message with type and content
export interface UIMessage {
  type: UIMessageType
  content: string
  timestamp: Date
}

interface CounterStats {
  success: number
  error: number
  missing: number
  total: number
}

interface UIState {
  mode: SyncMode
  status: UIStatus
  operationResult: SyncOperationResult
  stats: CounterStats
  computerResults: ComputerSyncResult[]
  lastUpdated: Date
  messages: UIMessage[]
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

  constructor(sourceRoot: string, mode: SyncMode) {
    // super();
    this.sourceRoot = sourceRoot
    this.state = {
      mode,
      status: UIStatus.IDLE,
      operationResult: SyncOperationResult.NONE,
      stats: { success: 0, error: 0, missing: 0, total: 0 },
      computerResults: [],
      lastUpdated: new Date(),
      messages: [],
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
    // this.renderDynamicElements()
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

  /**
   * Update the UI's status
   */
  updateUIStatus(newStatus: UIStatus): void {
    this.queueStateUpdate({ status: newStatus, lastUpdated: new Date() })
  }

  updateOperationResult(result: SyncOperationResult): void {
    this.queueStateUpdate({ operationResult: result, lastUpdated: new Date() })
  }

  addMessage(type: UIMessageType, content: string): void {
    const message: UIMessage = {
      type,
      content,
      timestamp: new Date(),
    }

    // Clone the current messages array and add the new message
    const messages = [...this.state.messages, message]
    this.queueStateUpdate({ messages, lastUpdated: new Date() })
  }

  clearMessages(): void {
    this.queueStateUpdate({ messages: [], lastUpdated: new Date() })
  }

  setReady(): void {
    this.queueStateUpdate({
      status: UIStatus.READY,
      lastUpdated: new Date(),
    })
  }

  /**
   *
   * In contrast to other UI methods, we don't _queue_ the UIState updates here, we peform them synchronously so that the calling code is assured it has a clean, expected state before beginning another sync operation.
   */
  startSyncOperation(
    options: { clearMessages: boolean } = { clearMessages: true }
  ): void {
    const updates: Partial<UIState> = {
      status: UIStatus.SYNCING,
      operationResult: SyncOperationResult.NONE,
      lastUpdated: new Date(),
    }

    if (options.clearMessages) {
      updates.messages = []
    }

    // Apply updates synchronously
    this.state = { ...this.state, ...updates }
  }

  // Complete an operation and log results
  completeOperation(result: SyncOperationResult): void {
    // First clear any dynamic content
    logUpdate.clear()

    // Then update the state
    this.state = {
      ...this.state,
      status: UIStatus.READY,
      operationResult: result,
      lastUpdated: new Date(),
    }

    // Log the static output
    this.logSyncSummary()

    // After logging static content, re-render dynamic elements
    this.renderDynamicElements()
    this.syncsComplete++
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

  private getResultColor() {
    switch (this.state.operationResult) {
      case SyncOperationResult.SUCCESS:
        return theme.success
      case SyncOperationResult.ERROR:
        return theme.error
      case SyncOperationResult.WARNING:
        return theme.warning
      case SyncOperationResult.PARTIAL:
        return theme.warning
      default:
        return theme.normal
    }
  }

  private getResultSymbol(): string {
    switch (this.state.operationResult) {
      case SyncOperationResult.SUCCESS:
        return symbols.check
      case SyncOperationResult.ERROR:
        return symbols.cross
      case SyncOperationResult.WARNING:
        return symbols.warning
      case SyncOperationResult.PARTIAL:
        return symbols.warning
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
    const computerOutputs = sortedComputers.map((computer) => {
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
      let computerOutput = `  ${statusColor(statusIcon)} Computer ${computer.computerId}: `

      // Summarize success/fail counts
      const successCount = computer.files.filter((f) => f.success).length
      const totalCount = computer.files.length
      computerOutput += theme.dim(`(${successCount}/${totalCount}) `)

      if (!computer.exists) {
        return computerOutput + theme.warning("Missing computer")
      }

      if (computer.files.length === 0) {
        return computerOutput + theme.dim("No files synced")
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

      return computerOutput + fileTargets.join(" | ")
    })

    // Join all computer outputs with newlines
    output += computerOutputs.join("\n")

    return output
  }

  private renderMessages(): string {
    if (this.state.messages.length === 0) {
      return ""
    }

    // Group messages by type
    const byType: Record<UIMessageType, UIMessage[]> = {
      [UIMessageType.ERROR]: [],
      [UIMessageType.WARNING]: [],
      [UIMessageType.INFO]: [],
    }

    this.state.messages.forEach((msg) => {
      byType[msg.type].push(msg)
    })

    const output: string[] = []

    // Render errors first
    if (byType[UIMessageType.ERROR].length > 0) {
      output.push(theme.error("\n  Errors:"))
      byType[UIMessageType.ERROR].forEach((msg) => {
        output.push(theme.error(`  ${symbols.cross} ${msg.content}`))
      })
    }

    // Then warnings
    if (byType[UIMessageType.WARNING].length > 0) {
      output.push(theme.warning("\n  Warnings:"))
      byType[UIMessageType.WARNING].forEach((msg) => {
        output.push(theme.warning(`  ${symbols.warning} ${msg.content}`))
      })
    }

    // Finally info messages
    if (byType[UIMessageType.INFO].length > 0) {
      output.push(theme.info("\n  Info:"))
      byType[UIMessageType.INFO].forEach((msg) => {
        output.push(theme.info(`  ${symbols.info} ${msg.content}`))
      })
    }

    return output.join("\n")
  }

  private renderControls(title = "Controls"): string {
    const controls = [
      { key: "SPACE", desc: "Re-sync", mode: "manual" },
      { key: "ESC", desc: "Exit" },
    ].filter((c) => !c.mode || c.mode === this.state.mode)

    // Add spinner to title
    const spinner = this.spinnerFrames[this.spinnerIndex]
    const titleWithSpinner = `${spinner} ${title}`

    // Only show controls box when in READY status
    if (this.state.status !== UIStatus.READY) {
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
    const messages = this.renderMessages()

    // Log the static output
    console.log(header)
    console.log(computerResults)
    console.log(messages)
    console.log(theme.dim("─".repeat(process.stdout.columns || 80))) // Separator line
  }

  // This renders the dynamic elements that change frequently with logUpdate
  private renderDynamicElements(): void {
    if (!this.isActive) return

    this.isRendering = true

    try {
      // Apply any pending state updates
      this.applyPendingUpdates()

      // Status indicator shows activity when syncing
      let statusIndicator = ""
      if (this.state.status === UIStatus.SYNCING) {
        statusIndicator = theme.info(
          `\n  ${this.spinnerFrames[this.spinnerIndex]} Syncing files to computers...`
        )
      }

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
