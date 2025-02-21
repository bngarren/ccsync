type KeyCallback = () => void | Promise<void>

interface KeyHandlerOptions {
  onEsc?: KeyCallback
  onSpace?: KeyCallback
  onCtrlC?: KeyCallback
}

export class KeyHandler {
  private isActive = false
  private keyCallbacks: KeyHandlerOptions
  private currentHandler: ((data: Buffer) => void) | null = null
  private keepAliveInterval: Timer | null = null

  constructor(options: KeyHandlerOptions = {}) {
    this.keyCallbacks = options

    // Default Ctrl+C handler if none provided
    if (!this.keyCallbacks.onCtrlC) {
      this.keyCallbacks.onCtrlC = () => {
        console.log("Terminated")
        process.exit(0)
      }
    }
  }

  start() {
    if (this.isActive) return

    try {
      this.isActive = true

      // Ensure clean state
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false)
      }
      process.stdin.pause()

      // Setup stdin
      process.stdin.setEncoding("utf8")
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true)
      }
      process.stdin.resume()

      // Bind the handler
      this.currentHandler = this.handleKeypress.bind(this)
      process.stdin.removeAllListeners("data") // Remove any existing listeners
      process.stdin.on("data", this.currentHandler)

      // Keep-alive interval
      if (this.keepAliveInterval) {
        clearInterval(this.keepAliveInterval)
      }
      this.keepAliveInterval = setInterval(() => {
        if (this.isActive && process.stdin.isTTY) {
          process.stdin.resume()
          process.stdin.setRawMode(true)
        } else {
          this.stop()
        }
      }, 100)
    } catch (err) {
      console.error("Error starting key handler:", err)
      this.stop()
    }
  }

  stop() {
    if (!this.isActive) return

    try {
      this.isActive = false

      if (this.keepAliveInterval) {
        clearInterval(this.keepAliveInterval)
        this.keepAliveInterval = null
      }

      if (this.currentHandler) {
        process.stdin.removeListener("data", this.currentHandler)
        this.currentHandler = null
      }

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false)
      }
      process.stdin.pause()
    } catch (err) {
      console.error("Error stopping key handler:", err)
    }
  }

  private async handleKeypress(data: Buffer) {
    if (!this.isActive) return

    const key = data.toString()

    // Handle Ctrl+C (End of Text character)
    if (key === "\u0003" && this.keyCallbacks.onCtrlC) {
      await this.keyCallbacks.onCtrlC()
      return
    }

    // Handle ESC
    if (key === "\u001b" && this.keyCallbacks.onEsc) {
      await this.keyCallbacks.onEsc()
      return
    }

    // Handle Space
    if (key === " " && this.keyCallbacks.onSpace) {
      await this.keyCallbacks.onSpace()
    }
  }

  isListening() {
    return this.isActive
  }
}
