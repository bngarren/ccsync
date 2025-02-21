import { EventEmitter } from "node:events"

export enum SyncMode {
  MANUAL = "manual",
  WATCH = "watch",
}

// Base interface for file sync configuration in .ccsync.yaml
export interface SyncRule {
  source: string // Glob pattern relative to sourceRoot
  target: string // Target path on computer
  computers?: string[] // Array of computer IDs or group names
}

/**
 * Represents a viable file resolved from a config sync rule.
 *
 * A resolved file rule has been validated such that a file exists at the source path.
 */
export interface ResolvedFileRule {
  sourcePath: string // Absolute path to source file
  targetPath: string // Relative path on computer
  computers: string[] // Resolved list of computer IDs (not group names)
}

// Represents a computer in the Minecraft save
export interface Computer {
  id: string
  path: string
  shortPath: string
}

/**
 * A SyncValidation is the result returned when the rules in the config files are validated against what's actually present in the file system.
 */
export interface ValidationResult {
  /**
   * An array of {@link ResolvedFileRule}'s
   */
  resolvedFileRules: ResolvedFileRule[]
  availableComputers: Computer[]
  missingComputerIds: string[]
  errors: string[]
}

export interface SyncResult {
  successCount: number
  errorCount: number
  missingCount: number
}

export interface SyncErrorEventData {
  error: Error // The actual error
  fatal: boolean // Whether this error should stop operations
  source?: string // Optional: where the error occurred (e.g. 'validation', 'sync', 'watcher')
}

export enum SyncEvent {
  STARTED,
  STOPPED,
  SYNC_VALIDATION,
  SYNC_COMPLETE,
  SYNC_ERROR,
  INITIAL_SYNC_COMPLETE,
  INITIAL_SYNC_ERROR,
  FILE_SYNC,
  FILE_SYNC_ERROR,
  WATCHER_ERROR,
}

type CommonSyncEvents = {
  [SyncEvent.STARTED]: void
  [SyncEvent.SYNC_VALIDATION]: ValidationResult
  [SyncEvent.SYNC_COMPLETE]: SyncResult
  [SyncEvent.SYNC_ERROR]: SyncErrorEventData
  [SyncEvent.STOPPED]: void
}

// Event maps for each mode type
export type ManualSyncEvents = CommonSyncEvents

export type WatchSyncEvents = {
  [SyncEvent.INITIAL_SYNC_COMPLETE]: SyncResult
} & CommonSyncEvents

// Type-safe event emitter factory
export function createTypedEmitter<T extends Record<string, any>>() {
  const emitter = new EventEmitter()
  return {
    emit<K extends keyof T>(
      event: K,
      data?: T[K] extends void ? void : T[K]
    ): boolean {
      return emitter.emit(event as string, data)
    },
    on<K extends keyof T>(
      event: K,
      listener: T[K] extends void ? () => void : (data: T[K]) => void
    ): void {
      emitter.on(event as string, listener)
    },
    once<K extends keyof T>(
      event: K,
      listener: T[K] extends void ? () => void : (data: T[K]) => void
    ): void {
      emitter.once(event as string, listener)
    },
    off<K extends keyof T>(
      event: K,
      listener: T[K] extends void ? () => void : (data: T[K]) => void
    ): void {
      emitter.off(event as string, listener)
    },
  }
}
