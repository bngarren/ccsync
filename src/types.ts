import { EventEmitter } from "node:events"
import type { IAppError } from "./errors"
import type { SyncPlan } from "./syncplan"

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

/**
 * Result of syncing a single file to a computer.
 * Contains details about the source, target, and success status.
 */
export interface FileSyncResult {
  /** Full target path where the file should have been copied */
  targetPath: string

  /** Full source path where the file was copied from */
  sourcePath: string

  /** Whether the file was successfully copied */
  success: boolean

  /** Optional error message if the sync failed */
  error?: string
}

/**
 * Results of syncing multiple files to a single computer.
 * Tracks both the detailed file results and summary counts.
 */
export interface ComputerSyncResult {
  /** ID of the computer */
  computerId: string

  /** Whether the computer exists in the save directory */
  exists: boolean

  /** Detailed results for each file synced to this computer */
  files: FileSyncResult[]

  /** Number of files successfully synced to this computer */
  successCount: number

  /** Number of files that failed to sync to this computer.
   *
   * If a computer does not exist, it will have a failureCount of 0, as no files would even be attempted to copy.
   */
  failureCount: number
}

/**
 * Comprehensive result of a complete sync operation.
 * Contains both summary statistics and detailed results per computer.
 */
export interface SyncOperationResult {
  /** Overall status of the operation */
  status: SyncStatus

  /** Timestamp when the operation completed */
  timestamp: number

  /** Summary statistics for the entire operation */
  summary: {
    /** Total number of file copies attempted.
     *
     * For example, 1 file → 2 computers = 2 totalFiles */
    totalFiles: number

    /** Number of files successfully synced */
    successfulFiles: number

    /** Number of files that failed to sync */
    failedFiles: number

    /** Number of computers attempted */
    totalComputers: number

    /** Number of computers where all files synced successfully */
    fullySuccessfulComputers: number

    /** Number of computers where some files succeeded and others failed */
    partiallySuccessfulComputers: number

    /** Number of computers where all file syncs failed */
    failedComputers: number

    /** Number of computers referenced but not found */
    missingComputers: number
  }

  /** Detailed results for each computer.
   *
   * Note: A computer will only generate a {@link ComputerSyncResult} if it was targeted by a sync rule that actually matched files. In other words, if a sync rule source pattern does not match a file, the computers in the target will not show up in this array (unless they are part of another sync rule).  */
  computerResults: ComputerSyncResult[]

  /** Error messages that occurred during the operation */
  errors: string[]
}

export enum SyncEvent {
  STARTED,
  STOPPED,
  SYNC_PLANNED,
  SYNC_COMPLETE,
  SYNC_ERROR,
  INITIAL_SYNC_COMPLETE,
}

export type BaseControllerEvents = {
  [SyncEvent.STOPPED]: undefined
  [SyncEvent.STARTED]: undefined
  [SyncEvent.SYNC_PLANNED]: SyncPlan
  [SyncEvent.SYNC_COMPLETE]: SyncOperationResult
  [SyncEvent.SYNC_ERROR]: IAppError
}

// Event maps for each mode type
export type ManualSyncEvents = BaseControllerEvents

export type WatchSyncEvents = {
  [SyncEvent.INITIAL_SYNC_COMPLETE]: SyncOperationResult
} & BaseControllerEvents

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
