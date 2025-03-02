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
const DEFAULT_LOG_LEVEL: LogLevel = "debug"

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

  // Use ISO date format for the base log file name
  return path.join(logDir, "ccsync")
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

  // Setup transport with pino-roll
  const transport = pino.transport({
    target: "pino-roll",
    options: {
      file: logFilePath,
      frequency: "daily", // Rotate logs daily
      mkdir: true, // Create the directory if it doesn't exist
      size: "10m", // Also rotate if a log file reaches 10 MB
      extension: ".log", // Add .log extension to the files
      symlink: true, // Create a symlink to the current log file
      dateFormat: "yyyy-MM-dd", // Format for date in filename
      limit: {
        count: 2, // Keep 2 days of logs
      },
      messageFormat: "{if component} [{component}]: {end}{msg}",
    },
  })

  // Create the logger with serializers for better error reporting
  logger = pino(
    {
      level: options.logLevel || DEFAULT_LOG_LEVEL,
      timestamp: pino.stdTimeFunctions.isoTime,
      serializers: {
        err: pino.stdSerializers.err, // Standard error serializer
        error: pino.stdSerializers.err, // Also handle 'error' property name
      },
    },
    transport
  )

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
