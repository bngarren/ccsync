import { EventEmitter } from "node:events"
import type { IAppError } from "./errors"
import type { SyncPlan } from "./syncplan"

export enum SyncMode {
  MANUAL = "manual",
  WATCH = "watch",
}

// // Base interface for file sync configuration in .ccsync.yaml
// export interface SyncRule {
//   source: string // Glob pattern relative to sourceRoot
//   target: string // Target path on computer
//   computers?: string[] // Array of computer IDs or group names
// }

/**
 * Represents a viable file resolved from a config sync rule.
 *
 * A resolved file rule has been validated such that a file exists at the source path.
 */
export interface ResolvedFileRule {
  /**
   * Absolute path to source file
   */
  sourceAbsolutePath: string
  /**
   * Relative path to source file from source root
   */
  sourceRelativePath: string
  /**
   * This flag will dictate _how_ the source files are copied to the target. If _false_ **and** a _recursive glob pattern_ is used for `source`, then the files will be copied to the target directory maintaining their source directory structure. The default is _true_, in which source files are copied to a single target directory.
   */
  flatten?: boolean
  /**
   * Explicit target structure defining where files should be copied
   */
  target: {
    /**
     * Type of target destination - either a directory or specific file
     */
    type: TargetType
    /**
     * Normalized path (without trailing slash for directories)
     */
    path: string
  }
  /**
   * Resolved list of computer IDs (not group names)
   */
  computers: string[]
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

export enum SyncOperationResult {
  /**
   * No sync operation completed yet
   */
  NONE = "none",
  /**
   * All files synced successfully
   */
  SUCCESS = "success",
  /**
   * All files synced successfully with warnings
   */
  WARNING = "warning",
  /**
   * Sync operation failed with errors
   */
  ERROR = "error",
  /**
   * Some files synced successfully, some failed
   */
  PARTIAL = "partial",
}

export interface SyncResult {
  successCount: number
  errorCount: number
  missingCount: number
}

export enum SyncEvent {
  STARTED,
  STOPPED,
  SYNC_PLANNED,
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
  [SyncEvent.SYNC_PLANNED]: SyncPlan
  [SyncEvent.SYNC_COMPLETE]: SyncResult
  [SyncEvent.SYNC_ERROR]: IAppError
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

export type TargetType = "directory" | "file"

/**
 * Represents a sync result for a specific computer
 * Used for UI display
 */
export interface ComputerSyncResult {
  computerId: string
  exists: boolean
  files: Array<{
    // Store full target path for UI display
    targetPath: string
    targetType: TargetType
    // Include source path for potential filename resolution
    sourcePath: string
    success: boolean
  }>
}
