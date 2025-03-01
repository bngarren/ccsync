import pino from "pino"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

// Define available log levels
export type LogLevel =
  | "silent"
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal"

// Default log level
const DEFAULT_LOG_LEVEL: LogLevel = "info"

// Helper to get OS-specific user log directory
export function getLogDirectory(): string {
  const platform = process.platform
  const homedir = os.homedir()

  if (platform === "win32") {
    // Windows: %USERPROFILE%\AppData\Local\ccsync\logs
    return path.join(homedir, "AppData", "Local", "ccsync", "logs")
  } else if (platform === "darwin") {
    // macOS: ~/Library/Logs/ccsync
    return path.join(homedir, "Library", "Logs", "ccsync")
  } else {
    // Linux/Unix: ~/.local/share/ccsync/logs
    return path.join(homedir, ".local", "share", "ccsync", "logs")
  }
}

// Helper to get the log file path
export function getLogFilePath(): string {
  const logDir = getLogDirectory()

  // Create the log directory if it doesn't exist
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }

  // Use ISO date format for log files (YYYY-MM-DD)
  const dateString = new Date().toISOString().split("T")[0]
  return path.join(logDir, `ccsync-${dateString}.log`)
}

// Logger instance that will be exported and used throughout the app
let logger: pino.Logger = pino({
  level: DEFAULT_LOG_LEVEL,
})

// Initialize logger with the given configuration
export function initializeLogger(options: {
  logToFile: boolean
  logLevel: LogLevel
}): pino.Logger {
  if (!options.logToFile) {
    // If logging to file is disabled, return a disabled logger
    logger = pino({
      level: "silent",
      enabled: false,
    })
    return logger
  }

  // Setup file destination
  const logFilePath = getLogFilePath()

  // Create file stream
  const destination = pino.destination({
    dest: logFilePath,
    sync: true, // Use sync writing to avoid losing logs on crashes
  })

  // Create the logger
  logger = pino({
    level: options.logLevel || DEFAULT_LOG_LEVEL,
    timestamp: pino.stdTimeFunctions.isoTime,
    transport: {
      target: "pino/file",
      options: { destination: logFilePath },
    },
  })

  // Add process termination handlers to flush logs
  process.on("beforeExit", () => {
    logger.info("Application shutting down")
    destination.flushSync()
  })

  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception")
    destination.flushSync()
  })

  // Log initialization
  logger.info(
    {
      logLevel: options.logLevel,
      logFile: logFilePath,
    },
    "Logger initialized"
  )

  return logger
}

// Function to get the current logger instance
export function getLogger(): pino.Logger {
  return logger
}

// Export a default logger that other modules can use directly
export default logger
