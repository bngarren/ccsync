// ---- error utilities ----

interface NodeError extends Error {
  code?: string
  stack?: string
}

/**
 * Returns the error.message or String(error)
 */
export const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(Error)
}

/**
 * Node.js errors includes properties such as 'code', but TypeScript's base Error type doesn't know about it. Can use this type guard t
 * @param error
 * @returns
 */
export const isNodeError = (error: unknown): error is NodeError => {
  return error instanceof Error && "code" in error
}

// ---- Error Types ----

export enum ErrorSeverity {
  /**
   * Issue occurred but operation can proceed
   */
  WARNING = "warning",
  /**
   * Operation failed but system can continue
   */
  ERROR = "error",
  /**
   * System cannot continue, must exit
   */
  FATAL = "fatal",
}

export interface IAppError {
  /**
   * Human readable error message
   */
  message: string
  severity: ErrorSeverity
  /**
   * Component that generated the error
   */
  source?: string
  /**
   * Original error (for logging/debugging)
   */
  originalError?: unknown
  userMessage?: string
  context?: Record<string, unknown>
}

/**
 * Application error class that can be thrown and includes severity information.
 */
export class AppError extends Error implements IAppError {
  constructor(
    message: string,
    public readonly severity: ErrorSeverity = ErrorSeverity.ERROR,
    public readonly source?: string,
    public readonly originalError?: unknown,
    public readonly userMessage?: string,
    public readonly context?: Record<string, unknown>
  ) {
    super(message)
    this.name = "AppError"

    // This is needed for instanceof to work correctly with custom error classes
    Object.setPrototypeOf(this, AppError.prototype)
  }

  /**
   * Returns a new AppError with added context, but otherwise same as the original
   */
  withContext(context: Record<string, unknown>): AppError {
    return new AppError(
      this.message,
      this.severity,
      this.source,
      this.originalError,
      this.userMessage,
      { ...this.context, ...context }
    )
  }

  /**
   * Create a warning-level application error.
   */
  static warning(
    message: string,
    source?: string,
    originalError?: unknown
  ): AppError {
    return new AppError(message, ErrorSeverity.WARNING, source, originalError)
  }

  /**
   * Create an error-level application error.
   */
  static error(
    message: string,
    source?: string,
    originalError?: unknown
  ): AppError {
    return new AppError(message, ErrorSeverity.ERROR, source, originalError)
  }

  /**
   * Create a fatal-level application error.
   */
  static fatal(
    message: string,
    source?: string,
    originalError?: unknown
  ): AppError {
    return new AppError(message, ErrorSeverity.FATAL, source, originalError)
  }

  /**
   * Create an appropriate AppError from an unknown error object.
   * @param error The original error
   * @param options Optional configuration
   * @param options.defaultMessage Message to use if error is not an Error object
   * @param options.severity Default severity level
   * @param options.source Component that caught the error
   * @param options.userMessage User friendly message that can be displayed to the UI
   */
  static from(
    error: unknown,
    options?: {
      defaultMessage?: string
      severity?: ErrorSeverity
      source?: string
      userMessage?: string
    }
  ): AppError {
    // If already an AppError, return it directly
    if (error instanceof AppError) {
      return error
    }

    // Extract options with defaults
    const {
      defaultMessage = "An unknown error occurred",
      severity = ErrorSeverity.ERROR,
      source,
      userMessage,
    } = options || {}

    // Create new AppError with appropriate message
    const message = error instanceof Error ? error.message : defaultMessage
    return new AppError(message, severity, source, error, userMessage)
  }
}
