import type { ResolvedFileRule, Computer } from "./types"

/**
 * Severity level for issues encountered during sync plan creation
 */
export enum SyncPlanIssueSeverity {
  /**
   * Operation can proceed, but user should be informed
   */
  WARNING = "warning",

  /**
   * Operation cannot proceed, requires user action
   */
  ERROR = "error",
}

/**
 * Categories of issues for better organization and handling
 */
export enum SyncPlanIssueCategory {
  /**
   * Issues with the Minecraft save directory
   */
  SAVE_DIRECTORY = "save_directory",

  /**
   * Issues with computer access/discovery
   */
  COMPUTER = "computer",

  /**
   * Issues with file sync rules
   */
  RULE = "rule",

  /**
   * Issues with file system access
   */
  FILE_SYSTEM = "file_system",

  /**
   * Miscellaneous issues
   */
  OTHER = "other",
}

/**
 * Structured issue encountered during sync plan creation
 */
export interface SyncPlanIssue {
  /**
   * Human-readable message describing the issue
   */
  message: string

  /**
   * Category of the issue
   */
  category: SyncPlanIssueCategory

  /**
   * Severity of the issue (whether it blocks operation)
   */
  severity: SyncPlanIssueSeverity

  /**
   * Optional details that can be displayed in verbose mode
   */
  details?: string

  /**
   * Optional suggestion for resolving the issue
   */
  suggestion?: string

  /**
   * Source of the issue
   */
  source?: string
}

/**
 * Results of the sync plan creation process
 */
export interface SyncPlan {
  /**
   * Whether the sync plan is valid and can be executed
   */
  isValid: boolean

  /**
   * Resolved file rules that passed validation
   */
  resolvedFileRules: ResolvedFileRule[]

  /**
   * Computers that are available in the save directory
   */
  availableComputers: Computer[]

  /**
   * Computer IDs that were referenced but not found
   */
  missingComputerIds: string[]

  /**
   * Structured issues encountered during plan creation
   */
  issues: SyncPlanIssue[]

  /**
   * Time when the plan was created
   */
  timestamp: number
}

/**
 * Create an issue for the sync plan
 */
export function createSyncPlanIssue(
  message: string,
  category: SyncPlanIssueCategory,
  severity: SyncPlanIssueSeverity = SyncPlanIssueSeverity.ERROR,
  options?: {
    details?: string
    suggestion?: string
    source?: string
  }
): SyncPlanIssue {
  return {
    message,
    category,
    severity,
    ...options,
  }
}

/**
 * Creates a new empty sync plan
 */
export function createEmptySyncPlan(): SyncPlan {
  return {
    isValid: true,
    resolvedFileRules: [],
    availableComputers: [],
    missingComputerIds: [],
    issues: [],
    timestamp: Date.now(),
  }
}
