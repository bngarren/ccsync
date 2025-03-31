import type { AppError } from "./errors"
import { SyncStatus } from "./types"

// For a single file sync operation
export interface FileSyncResult {
  targetPath: string
  sourcePath: string
  success: boolean
  error?: AppError
}

// Summary for a collection of file operations
export interface FileSyncSummary {
  succeededFiles: FileSyncResult[]
  failedFiles: FileSyncResult[]
  allSucceeded: boolean
  anySucceeded: boolean
  errors: AppError[]
}

// For syncing to a computer
export interface ComputerSyncSummary {
  computerId: string
  exists: boolean
  fileResults: FileSyncResult[]
  successCount: number
  failureCount: number
  errors: AppError[]
  allSucceeded: boolean
  anySucceeded: boolean
}

export interface SyncWarning {
  message: string
  suggestion?: string
}

// For the entire sync operation
export interface SyncOperationSummary {
  timestamp: number
  status: SyncStatus
  computerResults: ComputerSyncSummary[]
  summary: {
    totalFiles: number
    succeededFiles: number
    failedFiles: number
    totalComputers: number
    fullySuccessfulComputers: number
    partiallySuccessfulComputers: number
    failedComputers: number
    missingComputers: number
  }
  warnings: SyncWarning[]
  errors: AppError[]
  allSucceeded: boolean
  anySucceeded: boolean
}

// - - - - HELPERS - - - -
//

export function createFileSyncResult(
  sourcePath: string,
  targetPath: string,
  success: boolean,
  error?: AppError
): FileSyncResult {
  return { sourcePath, targetPath, success, error }
}

export function createFileSyncSummary(
  fileResults: FileSyncResult[] = []
): FileSyncSummary {
  const succeededFiles = fileResults.filter((file) => file.success)
  const failedFiles = fileResults.filter((file) => !file.success)

  // Extract errors from failed file results
  const errors = failedFiles
    .map((file) => file.error)
    .filter((error): error is AppError => error !== undefined)

  return {
    succeededFiles,
    failedFiles,
    allSucceeded: failedFiles.length === 0,
    anySucceeded: succeededFiles.length > 0,
    errors,
  }
}

export function createComputerSyncSummary(
  computerId: string,
  exists: boolean,
  fileResults: FileSyncResult[] = [],
  additionalErrors: AppError[] = []
): ComputerSyncSummary {
  const succeededFiles = fileResults.filter((file) => file.success)
  const failedFiles = fileResults.filter((file) => !file.success)

  // Extract errors from failed file results and add additional errors
  const errors = [
    ...failedFiles
      .map((file) => file.error)
      .filter((error): error is AppError => error !== undefined),
    ...additionalErrors,
  ]

  return {
    computerId,
    exists,
    fileResults,
    successCount: succeededFiles.length,
    failureCount: failedFiles.length,
    errors,
    allSucceeded: failedFiles.length === 0 && additionalErrors.length === 0,
    anySucceeded: succeededFiles.length > 0,
  }
}

// Function to combine multiple computer results into a final operation summary
export function createSyncOperationSummary(
  status: SyncStatus,
  computerResults: ComputerSyncSummary[],
  additionalErrors: AppError[] = [],
  additionalWarnings: SyncWarning[] = []
): SyncOperationSummary {
  const allFileResults = computerResults.flatMap((comp) => comp.fileResults)
  const succeededFiles = allFileResults.filter((file) => file.success)
  const failedFiles = allFileResults.filter((file) => !file.success)

  // Count categories of computers
  const fullySuccessfulComputers = computerResults.filter(
    (comp) =>
      comp.exists && comp.fileResults.length > 0 && comp.failureCount === 0
  ).length

  const partiallySuccessfulComputers = computerResults.filter(
    (comp) => comp.exists && comp.successCount > 0 && comp.failureCount > 0
  ).length

  const failedComputers = computerResults.filter(
    (comp) =>
      comp.exists && comp.fileResults.length > 0 && comp.successCount === 0
  ).length

  const missingComputers = computerResults.filter((comp) => !comp.exists).length

  // Aggregate all errors
  const errors = [
    ...computerResults.flatMap((comp) => comp.errors),
    ...additionalErrors,
  ]

  // Combine all warnings
  const warnings = [...additionalWarnings]

  return {
    timestamp: Date.now(),
    status,
    computerResults,
    summary: {
      totalFiles: allFileResults.length,
      succeededFiles: succeededFiles.length,
      failedFiles: failedFiles.length,
      totalComputers: computerResults.length,
      fullySuccessfulComputers,
      partiallySuccessfulComputers,
      failedComputers,
      missingComputers,
    },
    warnings,
    errors,
    allSucceeded: failedFiles.length === 0 && errors.length === 0,
    anySucceeded: succeededFiles.length > 0,
  }
}

/**
 * @deprecated
 */
export function getSyncOperationStatus(
  syncOperationSummary: SyncOperationSummary
) {
  if (
    syncOperationSummary.summary.totalFiles === 0 ||
    syncOperationSummary.summary.missingComputers > 0
  ) {
    return SyncStatus.WARNING
  } else if (syncOperationSummary.allSucceeded) {
    return SyncStatus.SUCCESS
  } else if (!syncOperationSummary.anySucceeded) {
    return SyncStatus.ERROR
  } else {
    return SyncStatus.PARTIAL
  }
}
