interface NodeError extends Error {
  code?: string
  stack?: string
}

/**
 * Node.js errors includes properties such as 'code', but TypeScript's base Error type doesn't know about it. Can use this type guard t
 * @param error
 * @returns
 */
export const isNodeError = (error: unknown): error is NodeError => {
  return error instanceof Error && "code" in error
}
