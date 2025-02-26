import { setInterval, clearInterval } from "node:timers"

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

export class UI {
  private state: UIState
  private timer: ReturnType<typeof setInterval> | null = null
  private isActive = false
  private sourceRoot: string
  private isRendering = false // lock to prevent concurrent renders
  private pendingRender = false // Flag to track if render was requested during another render
  private initialRender = true

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

  // Clear the entire screen and reset cursor - only on first render
  private clearScreen() {
    if (this.initialRender) {
      try {
        // Use logUpdate's clear instead of raw ANSI codes to prevent flickering
        logUpdate.clear()
        this.initialRender = false
      } catch (error) {
        console.error("Error clearing screen:", error)
      }
    }
  }

  start(): void {
    // Clear any existing UI state
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    this.isActive = true
    this.isRendering = false
    this.pendingRender = false
    this.initialRender = true

    this.clearScreen()
    logUpdate.clear()

    // initial render
    this.render()

    // Start a refresh timer to update elapsed time
    this.timer = setInterval(() => {
      if (this.isActive) this.render()
    }, 1000)
  }

  stop(): void {
    this.isActive = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    // Finalize the output (wait a bit to ensure pending operations complete)
    setTimeout(() => {
      try {
        logUpdate.clear()
        logUpdate.done()
      } catch (error) {
        console.error("Error finalizing UI:", error)
      }
    }, 50)
  }

  updateStatus(status: UIState["status"], message?: string): void {
    this.state.status = status
    this.state.message = message
    this.state.lastUpdated = new Date()
    this.render()
  }

  updateStats(stats: Partial<CounterStats>): void {
    this.state.stats = {
      ...this.state.stats,
      ...stats,
      total: (stats.success || 0) + (stats.error || 0) + (stats.missing || 0),
    }
    this.render()
  }

  updateFileResults(
    resolvedFiles: ResolvedFileRule[],
    fileResults: Map<string, Array<{ computerId: string; success: boolean }>>
  ): void {
    this.state.fileResults = []

    for (const [filePath, results] of fileResults.entries()) {
      const file = resolvedFiles.find(
        (f) => path.relative(this.sourceRoot, f.sourceAbsolutePath) === filePath
      )

      if (file) {
        this.state.fileResults.push({
          path: filePath,
          targetPath: file.targetPath,
          results: results.sort((a, b) =>
            a.computerId.localeCompare(b.computerId)
          ),
        })
      }
    }

    this.state.lastUpdated = new Date()
    this.render()
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

  private renderHeader(): string {
    return (
      "\n\n" +
      theme.bold(
        theme.highlight(`  CC: Sync - ${this.state.mode.toUpperCase()} mode`)
      )
    )
  }

  private renderResultsBox(): string {
    const { success, error, missing, total } = this.state.stats

    // const content =
    //   theme.success(`${symbols.check} Success: ${success}  `).padEnd(20) +
    //   theme.error(`${symbols.cross} Error: ${error}  `).padEnd(20) +
    //   theme.warning(`${symbols.warning} Missing: ${missing}`).padEnd(20)
    // theme.normal(`Total Computers: ${total}`)

    const pluralComputer = pluralize("computer")(total)

    const content =
      theme.dim(
        `@${this.state.lastUpdated.toLocaleString()} (${this.formatElapsedTime()})\n\n`
      ) +
      theme.normal(
        `Attempted to sync to ${theme.bold(total)} ${pluralComputer}:\n\n`
      ) +
      theme[success > 0 ? "success" : "normal"](`Success: ${success}  `) +
      theme[error > 0 ? "error" : "normal"](`Error: ${error}  `) +
      theme[missing > 0 ? "warning" : "normal"](`Missing: ${missing}`)

    return boxen(content, {
      padding: 1,
      margin: { top: 2, bottom: 1, left: 1, right: 1 },
      borderStyle: "round",
      borderColor: "blue",
      title: `Sync Results`,
      titleAlignment: "center",
      width: 45,
      textAlignment: "center",
    })
  }

  private renderFileResults(): string {
    if (this.state.fileResults.length === 0) {
      return theme.dim("\nNo files synced yet.")
    }

    let output = theme.heading("\nFILE SYNC RESULTS:")

    for (const file of this.state.fileResults) {
      // Calculate summary stats for this file
      const successCount = file.results.filter((r) => r.success).length
      const totalCount = file.results.length
      const summaryColor =
        successCount === totalCount
          ? theme.success
          : successCount === 0
            ? theme.error
            : theme.warning

      output +=
        "\n" +
        theme.primary(file.path) +
        " " +
        theme.dim(`→ ${file.targetPath}`) +
        " " +
        summaryColor(`(${successCount}/${totalCount})`)

      // Render computer IDs and their statuses
      const computerStatuses = file.results
        .map((r) =>
          r.success
            ? theme.success(`${r.computerId}${symbols.check}`)
            : theme.error(`${r.computerId}${symbols.cross}`)
        )
        .join(" ")

      output += " " + theme.dim("[") + computerStatuses + theme.dim("]")
    }

    return output
  }

  private renderControls(): string {
    const controls = [
      { key: "SPACE", desc: "Re-sync", mode: "manual" },
      { key: "ESC", desc: "Exit" },
    ].filter((c) => !c.mode || c.mode === this.state.mode)

    return (
      "\n\n" +
      boxen(
        controls
          .map((c) => `${theme.keyHint(c.key)} ${theme.normal(c.desc)}`)
          .join("   "),
        {
          padding: 0.5,
          margin: { left: 1 },
          borderStyle: "round",
          borderColor: "cyan",
          title: "Controls",
          titleAlignment: "center",
        }
      )
    )
  }

  private renderMessage(): string {
    if (!this.state.message) return ""

    const messageColor =
      this.state.status === "error"
        ? theme.error
        : this.state.status === "partial"
          ? theme.warning
          : theme.info

    return "\n" + messageColor(this.state.message)
  }

  private render(): void {
    if (!this.isActive) return

    // If already rendering, mark as pending and return
    if (this.isRendering) {
      this.pendingRender = true
      return
    }

    // Set lock to prevent concurrent renders
    this.isRendering = true
    this.pendingRender = false

    try {
      this.clearScreen()

      const output =
        this.renderHeader() +
        this.renderResultsBox() +
        this.renderFileResults() +
        this.renderMessage() +
        this.renderControls()

      // Update the terminal once with complete content
      logUpdate(output)

      this.initialRender = false
    } catch (error) {
      // Prevent rendering errors from breaking the application
      console.error("UI rendering error:", error)
    } finally {
      // Release the lock
      this.isRendering = false

      // If a render was requested while rendering, do it now
      if (this.pendingRender && this.isActive) {
        // Small delay to prevent too frequent updates and flickering
        setTimeout(() => this.render(), 10)
      }
    }
  }
}
