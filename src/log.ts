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
const LOG_ROTATION_FREQ = "daily"
const LOG_MAX_SIZE = "10m"
const LOG_RETENTION_COUNT = 2 // days

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
  const logDir = getLogDirectory()
  const logFilePath = getLogFilePath()

  // Setup transport with pino-roll
  const transport = pino.transport({
    target: "pino-roll",
    options: {
      file: logFilePath,
      frequency: LOG_ROTATION_FREQ, // Rotate logs daily
      mkdir: true, // Create the directory if it doesn't exist
      size: LOG_MAX_SIZE, // Also rotate if a log file reaches 10 MB
      extension: ".log", // Add .log extension to the files
      symlink: true, // Create a symlink to the current log file
      dateFormat: "yyyy-MM-dd", // Format for date in filename
      limit: {
        count: LOG_RETENTION_COUNT, // Keep 2 days of logs
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

  // ---- Log some initialization info (not critical) ----

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} bytes`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  }

  // Get information about log directory and existing logs
  let existingLogs: string[] = []
  let directorySize = 0
  const currentLogSymlink = path.join(logDir, "current.log")
  let currentLogFile = ""
  let currentFileSize: string | number = "unknown"

  try {
    if (fs.existsSync(logDir)) {
      // Get list of log files
      existingLogs = fs
        .readdirSync(logDir)
        .filter((file) => file.startsWith("ccsync") && file.endsWith(".log"))

      // Calculate total size of log directory
      directorySize = existingLogs.reduce((total, file) => {
        try {
          const stats = fs.statSync(path.join(logDir, file))
          return total + stats.size
        } catch (e) {
          return total
        }
      }, 0)

      if (fs.existsSync(currentLogSymlink)) {
        // Read where the symlink points to
        currentLogFile = fs.readlinkSync(currentLogSymlink)

        const currentLogPath = path.join(logDir, currentLogFile)

        if (fs.existsSync(currentLogPath)) {
          const stats = fs.statSync(currentLogPath)
          currentFileSize = stats.size
        }
      }
    }
  } catch (err) {
    // If we can't access the directory, just continue without this info
  }

  logger.info(
    {
      logLevel: options.logLevel,
      settings: {
        directory: logDir,
        rotationSettings: {
          frequency: LOG_ROTATION_FREQ,
          sizeLimit: LOG_MAX_SIZE,
          retentionCount: LOG_RETENTION_COUNT,
        },
      },
      stats: {
        existingLogCount: existingLogs.length,
        logFiles: existingLogs,
        directorySize: formatSize(directorySize),
      },
      currentLog: {
        path: currentLogFile,
        formattedSize:
          typeof currentFileSize === "number"
            ? formatSize(currentFileSize)
            : currentFileSize,
      },
      pino: pino.version,
      platform: process.platform,
      nodeVersion: process.version,
    },
    "pino logger intialized."
  )

  return logger
}

// Function to get the current logger instance
export function getLogger(): pino.Logger {
  return logger
}

// Export a default logger that other modules can use directly
export default logger
