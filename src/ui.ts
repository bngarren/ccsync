import { setInterval, clearInterval, setTimeout } from "node:timers"

import logUpdate from "log-update"
import figures from "figures"
import chalk from "chalk"
import {
  SyncMode,
  SyncStatus,
  type ComputerSyncResult,
  type SyncOperationResult,
} from "./types"
import boxen from "boxen"
import { pluralize } from "./utils"
import stripAnsi from "strip-ansi"
import { getLogger } from "./log"
import type { Logger } from "pino"

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
  lineDouble: figures.lineDouble,
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
  suggestion?: string
  timestamp: Date
}

export interface OperationStats {
  totalFiles: number
  totalComputers: number
}

interface UIState {
  mode: SyncMode | null
  status: UIStatus
  operationResult: SyncOperationResult | null
  operationsStats: OperationStats
  computerResults: ComputerSyncResult[]
  lastUpdated: Date
  messages: UIMessage[]
  /**
   * Past sync outputs
   */
  syncHistory: string[]
}

interface UIOptions {
  verbose?: boolean
  renderDynamicElements?: boolean
}

// Minimal interval between renders (ms)
const MIN_RENDER_INTERVAL = 50

export class UI {
  private _logger: Logger | null = null
  private get log() {
    if (!this._logger) {
      this._logger = getLogger().child({ component: "UI" })
    }
    return this._logger
  }
  private state: UIState
  private timer: ReturnType<typeof setInterval> | null = null
  private isActive = false

  // options
  private renderVerbose
  private shouldRenderDynamicElements

  private isRendering = false // lock to prevent concurrent renders
  private lastRenderTime = 0 // Timestamp of last render
  private renderTimer: ReturnType<typeof setTimeout> | null = null // Timer for debounced rendering
  private syncsComplete = 0

  // Add a class property to track the spinner animation
  private spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  private spinnerIndex = 0

  constructor(opts?: UIOptions) {
    this.state = {
      mode: null,
      status: UIStatus.IDLE,
      operationResult: null,
      operationsStats: {
        totalFiles: 0,
        totalComputers: 0,
      },
      computerResults: [],
      lastUpdated: new Date(),
      messages: [],
      syncHistory: [],
    }

    this.renderVerbose = opts?.verbose ?? false
    this.shouldRenderDynamicElements = opts?.renderDynamicElements ?? true

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

  // Refresh the entire screen including history
  private refreshScreen(): void {
    // Instead of using console.clear(), we'll use ANSI escape codes to:
    // 1. Move cursor to start of screen
    // 2. Clear everything from cursor to end of screen
    // This reduces flickering. Thanks Claude!!
    // process.stdout.write("\x1B[1;1H\x1B[0J")

    console.clear()

    const syncModeText = theme.bold(
      this.state.mode != null ? ` ${this.state.mode.toUpperCase()} mode` : ""
    )

    // Show the persistent header
    process.stdout.write(
      theme.primary(
        `\nCC: Sync -${syncModeText} started at ${this.state.lastUpdated.toLocaleString()}`
      ) +
        "\n" +
        theme.primary(symbols.lineDouble.repeat(process.stdout.columns || 80)) +
        "\n\n"
    )

    // Display history (if any) in plain text
    for (const pastOutput of this.state.syncHistory) {
      process.stdout.write(this.stripColors(pastOutput))
    }
  }

  // Utility to strip ANSI color codes
  private stripColors(text: string): string {
    return theme.dim(
      // text.replace(
      //   // eslint-disable-next-line no-control-regex
      //   /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
      //   ""
      // )
      stripAnsi(text)
    )
  }

  setMode(mode: SyncMode) {
    this.updateState({ mode })
    this.log.trace({ mode }, "UI SyncMode set")
  }

  start(): void {
    // Clear any existing UI state
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    this.isActive = true
    this.isRendering = false
    this.syncsComplete = 0
    this.spinnerIndex = 0

    this.refreshScreen()

    // Start a refresh timer to update elapsed time and spinner
    this.timer = setInterval(() => {
      if (this.isActive) {
        // Update spinner index
        this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length
        this.queueDynamicRender({ immediate: true }) // Spinner updates should be immediate
      }
    }, 100)

    this.log.info("UI started.")
  }

  stop(): void {
    this.isActive = false
    this.updateState({ status: UIStatus.IDLE })
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

    this.log.info("UI stopped.")
  }

  private updateState(update: Partial<UIState>): void {
    // Apply updates immediately to the state
    this.state = { ...this.state, ...update }

    if (!this.isActive) return
    // Queue a render with debouncing preserved
    this.queueDynamicRender()
  }

  updateUIStatus(newStatus: UIStatus): void {
    this.updateState({ status: newStatus, lastUpdated: new Date() })
  }

  updateOperationStats(stats: OperationStats): void {
    this.updateState({ operationsStats: stats })
  }

  addMessage(type: UIMessageType, content: string, suggestion?: string): void {
    const message: UIMessage = {
      type,
      content,
      suggestion,
      timestamp: new Date(),
    }

    // Clone the current messages array and add the new message
    const messages = [...this.state.messages, message]
    this.updateState({ messages, lastUpdated: new Date() })
  }

  clearMessages(): void {
    this.updateState({ messages: [], lastUpdated: new Date() })
  }

  setReady(): void {
    this.updateState({
      status: UIStatus.READY,
      lastUpdated: new Date(),
    })
  }

  private writeOutput(output: string): void {
    // First clear any dynamic content
    logUpdate.clear()

    // Refresh the screen with history
    this.refreshScreen()

    // Store in history before logging
    this.addToHistory(output)

    // Write the new output
    process.stdout.write(output)

    // After logging static content, re-render dynamic elements
    this.renderDynamicElements()
  }

  startSyncOperation(
    options: { clearMessages: boolean } = { clearMessages: false }
  ): void {
    const updates: Partial<UIState> = {
      status: UIStatus.SYNCING,
      operationResult: null,
      lastUpdated: new Date(),
    }

    if (options.clearMessages) {
      updates.messages = []
    }

    this.updateState({ ...updates })
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
      operationsStats: {
        totalFiles: result.summary.totalFiles,
        totalComputers: result.summary.totalComputers,
      },
      computerResults: result.computerResults,
      lastUpdated: new Date(),
    }

    // Generate the current log content
    const header = this.renderHeaderLine()
    const computerResults = this.renderComputerResults()
    const messages = this.renderMessages("\n")
    const separator = theme.dim("─".repeat(process.stdout.columns || 80))
    const currentOutput = `${header}\n${computerResults}${messages}\n${separator}\n`

    // Refresh the screen with history and new output
    this.refreshScreen()

    // Store in history before logging
    this.addToHistory(currentOutput)

    // Write the new output with colors
    process.stdout.write(currentOutput)

    this.log.debug(
      `UI received a 'completedOperation: ${result.status.toUpperCase()}`
    )

    this.clearMessages()

    // After logging static content, re-render dynamic elements
    this.queueDynamicRender()
    this.syncsComplete++
  }

  writeMessages(
    options: { persist: boolean; clearMessagesOnWrite: boolean } = {
      persist: false,
      clearMessagesOnWrite: true,
    }
  ): void {
    if (!this.isActive || this.state.messages.length === 0) return

    // Clear any dynamic content first
    logUpdate.clear()

    // Render messages
    const messages = this.renderMessages()
    const separator = theme.dim("─".repeat(process.stdout.columns || 80))
    const output = messages + "\n" + separator + "\n"

    // Write the messages directly, without modifying history
    process.stdout.write(output)

    if (options.persist) {
      this.addToHistory(output)
    }

    if (options.clearMessagesOnWrite) {
      this.clearMessages()
    }

    // Make sure dynamic elements are still rendered
    this.queueDynamicRender()
  }

  private addToHistory(output: string): void {
    this.state.syncHistory.push(output)

    // Keep only the last 3 entries
    if (this.state.syncHistory.length >= 3) {
      this.state.syncHistory.shift()
    }
  }

  updateComputerResults(computerResults: ComputerSyncResult[]): void {
    this.updateState({
      computerResults,
      lastUpdated: new Date(),
    })
  }

  clear(): void {
    logUpdate.clear()
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
    const date = this.state.lastUpdated.toLocaleString()

    const { totalFiles, totalComputers } = this.state.operationsStats

    let result = ""

    if (
      this.state.operationResult?.status === SyncStatus.SUCCESS &&
      this.state.messages.every((m) => m.type === UIMessageType.INFO)
    ) {
      result = theme.success("Success.")
    }

    return theme.bold(
      `#${this.syncsComplete + 1} [${date}] Attempted to sync ${totalFiles} total ${pluralize("file")(totalFiles)} ${totalComputers === 1 ? "to" : "across"} ${totalComputers} ${pluralize("computer")(totalComputers)}. ` +
        result +
        "\n"
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

  private renderMessages(prefix = ""): string {
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

    const output: string[] = [prefix]

    // Render errors first
    if (byType[UIMessageType.ERROR].length > 0) {
      // output.push(theme.error("\n"))
      byType[UIMessageType.ERROR].forEach((msg) => {
        output.push(
          theme.error(
            `  ${symbols.cross} ${msg.content} ${msg.suggestion ? theme.dim(`- ${msg.suggestion}`) : ""}`
          )
        )
      })
    }

    // Then warnings
    if (byType[UIMessageType.WARNING].length > 0) {
      // output.push(theme.warning("\n"))
      byType[UIMessageType.WARNING].forEach((msg) => {
        output.push(
          theme.warning(
            `  ${symbols.warning} ${msg.content} ${msg.suggestion ? theme.dim(`- ${msg.suggestion}`) : ""}`
          )
        )
      })
    }

    // Finally info messages
    if (byType[UIMessageType.INFO].length > 0) {
      // output.push(theme.info("\n"))
      byType[UIMessageType.INFO].forEach((msg) => {
        output.push(
          theme.info(
            `  ${symbols.info} ${msg.content} ${msg.suggestion ? theme.dim(`- ${msg.suggestion}`) : ""}`
          )
        )
      })
    }

    return output.join("\n")
  }

  private renderControls(title = "Controls"): string {
    const controls = [
      { key: "SPACE", desc: "Re-sync", mode: SyncMode.MANUAL },
      { key: "ESC", desc: "Exit" },
    ].filter((c) => !c.mode || c.mode === this.state.mode)

    // Add spinner to title
    const spinner = this.spinnerFrames[this.spinnerIndex]
    const titleWithSpinner = `${spinner} ${title}`

    // Only show controls box when in READY status
    if (this.state.status !== UIStatus.READY) {
      return ""
    }

    return (
      boxen(
        controls
          .map((c) => `${theme.keyHint(c.key)} ${theme.normal(c.desc)}`)
          .join("   "),
        {
          padding: 1,
          margin: { top: 1, left: 1 },
          borderStyle: "round",
          borderColor: "#61AFEF",
          title: titleWithSpinner,
          titleAlignment: "center",
          textAlignment: "center",
        }
      ) +
      "\n" +
      boxen(theme.dim(`Last updated ${this.formatElapsedTime()}.`), {
        textAlignment: "center",
        borderColor: "black",
        dimBorder: true,
        margin: { left: 5 },
      })
    )
  }

  private queueDynamicRender(options: { immediate?: boolean } = {}): void {
    if (!this.isActive) return

    // If already rendering, we can't do immediate anyway
    if (this.isRendering) return

    // For immediate renders that can't wait (like spinner animation)
    if (options.immediate && !this.renderTimer) {
      this.renderDynamicElements()
      return
    }

    // Don't queue another render if one is already queued
    if (this.renderTimer) return

    const now = Date.now()
    const timeSinceLastRender = now - this.lastRenderTime
    const delay = Math.max(0, MIN_RENDER_INTERVAL - timeSinceLastRender)

    this.renderTimer = setTimeout(() => {
      this.renderTimer = null
      this.renderDynamicElements()
    }, delay)
  }

  // This renders the dynamic elements that change frequently with logUpdate
  private renderDynamicElements(): void {
    if (!this.isActive) return

    if (!this.shouldRenderDynamicElements) return

    this.isRendering = true

    try {
      // Status indicator shows activity when syncing
      let statusIndicator = ""
      if (this.state.status === UIStatus.SYNCING) {
        statusIndicator = theme.info(
          `\n  ${this.spinnerFrames[this.spinnerIndex]} Syncing files to computers...`
        )
      }

      const controlsTitle =
        this.state.mode === SyncMode.MANUAL
          ? `Awaiting user input ${symbols.ellipsis}`
          : `Watching for file changes ${symbols.ellipsis}`

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
