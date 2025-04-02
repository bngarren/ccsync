import { EventEmitter } from "node:events"
import type { SyncPlan } from "./syncplan"
import type { SyncOperationSummary } from "./results"

export enum SyncMode {
  MANUAL = "manual",
  WATCH = "watch",
}

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
     * Raw normalized target path WITHOUT considering 'flatten' flag.
     *
     * IMPORTANT: This is NOT the final resolved path that should be used for file operations.
     * - For 'file' type: This is the complete target path including filename.
     * - For 'directory' type: This is just the directory path WITHOUT any filename or source structure.
     *
     * In general, to ensure you are using the fully resolved path, use the utility function `resolveTargetPath()` which will return the actual path with filename, properly accounting for source structure preservation when 'flatten' is false.
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

/**
 * @deprecated
 */
export interface SyncToComputerResult {
  computerId: string
  copiedFiles: string[]
  skippedFiles: string[]
}

export enum SyncStatus {
  /** No sync operation has been attempted yet */
  NONE = "none",
  /** All files were synced successfully with no sync-related warnings. */
  SUCCESS = "success",
  /** All files synced successfully but with some sync-related warnings */
  WARNING = "warning",
  /** Operation failed completely with errors */
  ERROR = "error",
  /** Some files synced successfully, some failed */
  PARTIAL = "partial",
}

export enum SyncEvent {
  RUN_STARTED,
  CONTROLLER_STOPPED,
  SYNC_PLANNED,
  SYNC_STARTED,
  SYNC_COMPLETE,
  INITIAL_SYNC_COMPLETE,
  FILE_CHANGED,
}

export type BaseControllerEvents = {
  [SyncEvent.CONTROLLER_STOPPED]: undefined
  [SyncEvent.RUN_STARTED]: undefined
  [SyncEvent.SYNC_PLANNED]: SyncPlan
  [SyncEvent.SYNC_STARTED]: SyncPlan
  [SyncEvent.SYNC_COMPLETE]: SyncOperationSummary
}

// Event maps for each mode type
export type ManualSyncEvents = BaseControllerEvents

export type WatchSyncEvents = {
  [SyncEvent.INITIAL_SYNC_COMPLETE]: SyncOperationSummary
  [SyncEvent.FILE_CHANGED]: string
} & BaseControllerEvents

export type AllSyncEvents = BaseControllerEvents &
  // eslint-disable-next-line @typescript-eslint/no-duplicate-type-constituents
  ManualSyncEvents &
  WatchSyncEvents

// Type-safe event emitter factory
export function createTypedEmitter<T extends Record<string, unknown>>() {
  const emitter = new EventEmitter()
  return {
    emit<K extends keyof T>(
      event: K,
      data?: T[K] extends undefined ? never : T[K]
    ): boolean {
      return emitter.emit(event as string, data)
    },
    on<K extends keyof T>(
      event: K,
      listener: T[K] extends undefined ? () => void : (data: T[K]) => void
    ): void {
      emitter.on(event as string, listener)
    },
    once<K extends keyof T>(
      event: K,
      listener: T[K] extends undefined ? () => void : (data: T[K]) => void
    ): void {
      emitter.once(event as string, listener)
    },
    off<K extends keyof T>(
      event: K,
      listener: T[K] extends undefined ? () => void : (data: T[K]) => void
    ): void {
      emitter.off(event as string, listener)
    },
    removeAllListeners(event?: keyof T): void {
      if (event !== undefined) {
        emitter.removeAllListeners(event as string)
      } else {
        emitter.removeAllListeners()
      }
    },
  }
}

export type TargetType = "directory" | "file"

// ---- HELPERS ----

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}
