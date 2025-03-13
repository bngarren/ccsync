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
