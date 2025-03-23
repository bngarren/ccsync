export const README_ADDRESS = "https://github.com/bngarren/ccsync#readme" // Define available log levels

export const LOG_LEVELS = [
  "silent",
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
] as const

// Default log level
export const LOG_ROTATION_FREQ = "daily"
export const LOG_MAX_SIZE = "10m"
export const LOG_RETENTION_COUNT = 2 // days

// INTERNALS

/**
 * Duration to wait (milliseconds) after a file change before starting a new sync.
 * This allows for batching when processing multiple or quickly changing files in watch mode.
 */
export const PROCESS_CHANGES_DELAY = 200
