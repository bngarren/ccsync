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
}

/**
 * Application error class that can be thrown and includes severity information.
 */
export class AppError extends Error implements IAppError {
  severity: ErrorSeverity
  source?: string
  originalError?: unknown

  /**
   * Create a new application error.
   * @param message Human readable error message
   * @param severity Error severity level
   * @param source Component that generated the error
   * @param originalError Original error (for logging/debugging)
   */
  constructor(
    message: string,
    severity: ErrorSeverity = ErrorSeverity.ERROR,
    source?: string,
    originalError?: unknown
  ) {
    super(message)
    this.name = "AppError"
    this.severity = severity
    this.source = source
    this.originalError = originalError

    // This is needed for instanceof to work correctly with custom error classes
    Object.setPrototypeOf(this, AppError.prototype)
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
   * @param defaultMessage Message to use if error is not an Error object
   * @param severity Default severity level
   * @param source Component that caught the error
   */
  static from(
    error: unknown,
    defaultMessage = "An unknown error occurred",
    severity = ErrorSeverity.ERROR,
    source?: string
  ): AppError {
    if (error instanceof AppError) {
      return error // Return the original AppError
    }

    const message = error instanceof Error ? error.message : defaultMessage
    return new AppError(message, severity, source, error)
  }
}
