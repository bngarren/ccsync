import pino, { type DestinationStream } from "pino"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { getErrorMessage } from "./errors"
import {
  LOG_MAX_SIZE,
  LOG_RETENTION_COUNT,
  LOG_ROTATION_FREQ,
  type LOG_LEVELS,
} from "./constants"

export type LogLevel = (typeof LOG_LEVELS)[number]

/**
 * Checks if the current environment supports filesystem symbolic links.
 *
 * @param - The directory to use for the test file and symlink.
 * @returns - Resolves to `true` if symlinks are supported, otherwise `false`.
 */
export function isSymlinkSupported(tempDir: string = os.tmpdir()) {
  const testFile = path.join(tempDir, "test-file")
  const testSymlink = path.join(tempDir, "test-symlink")

  try {
    // Create a test file
    fs.writeFileSync(testFile, "test")

    // Try creating a symlink
    fs.symlinkSync(testFile, testSymlink)

    // Ensure the symlink is accessible
    fs.accessSync(testSymlink)

    return true
  } catch {
    return false
  } finally {
    // Ensure cleanup, checking existence before deletion
    if (fs.existsSync(testSymlink)) {
      try {
        fs.unlinkSync(testSymlink)
      } catch {}
    }

    if (fs.existsSync(testFile)) {
      try {
        fs.unlinkSync(testFile)
      } catch {}
    }
  }
}

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
export function getLogFilePath(isTest = false): string {
  const logDir = getLogDirectory()

  // Create the log directory if it doesn't exist
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
  return path.join(logDir, `ccsync${isTest ? ".test" : ""}`)
}

function getNullLogger() {
  return pino({
    level: "silent",
    enabled: false,
  })
}

// Logger instance that will be exported and used throughout the app
let logger: pino.Logger = getNullLogger()

// Initialize logger with the given configuration
export function initializeLogger(options: {
  logToFile: boolean
  logLevel: LogLevel
  isTest?: boolean
}): pino.Logger {
  if (!options.logToFile) {
    // If logging to file is disabled, return a disabled logger
    return logger.level !== "silent" ? getNullLogger() : logger
  }

  try {
    // Setup file destination
    const logDir = getLogDirectory()
    const logFilePath = getLogFilePath(options.isTest)

    // Setup transport with pino-roll

    const symlinkIsSupported = isSymlinkSupported(logDir)

    let transport: DestinationStream
    if (options.isTest) {
      transport = pino.destination({
        dest: logFilePath + ".log", // Add .log extension
        sync: true, // Use synchronous writes for tests
      })
    } else {
      transport = pino.transport({
        target: "pino-roll",
        options: {
          file: logFilePath,
          frequency: LOG_ROTATION_FREQ, // Rotate logs daily
          mkdir: true, // Create the directory if it doesn't exist
          size: LOG_MAX_SIZE, // Also rotate if a log file reaches 10 MB
          extension: ".log", // Add .log extension to the files
          symlink: symlinkIsSupported, // Create a symlink to the current log file
          dateFormat: "yyyy-MM-dd", // Format for date in filename
          limit: {
            count: LOG_RETENTION_COUNT, // Keep 2 days of logs
          },
          messageFormat: "{if component} [{component}]: {end}{msg}",
        },
      }) as DestinationStream
    }

    // Create the logger with serializers for better error reporting
    logger = pino(
      {
        level: options.logLevel,
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
          symlink:
            (!options.isTest && symlinkIsSupported) ||
            "symlink is not supported in this environment!",
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

    // symlinks permissions warning, if needed
    if (!symlinkIsSupported) {
      let msg = `Symbolic links (which pino-roll uses to create a 'current.log') are not available in this environment.`
      if (process.platform === "win32") {
        msg = `${msg} On Windows, this is likely due to a lack of admin privledges.`
      }
      logger.warn(msg)
    }

    return logger
  } catch (err) {
    console.log(
      "Error: Failed to initialize pino logger: ",
      getErrorMessage(err)
    )
    return getNullLogger()
  }
}

// Function to get the current logger instance
export function getLogger(): pino.Logger {
  return logger
}

// Export a default logger that other modules can use directly
export default logger
