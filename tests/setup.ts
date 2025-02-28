import { beforeAll, afterAll, mock } from "bun:test"

// Store original console.log
export const testLog = console.log

mock.module("../src/log", () => ({
  createLogger: () => ({
    verbose: () => {},
    info: () => {},
    step: () => {},
    success: () => {},
    warn: () => {},
    error: () => {},
    status: () => {},
  }),
}))

beforeAll(() => {
  console.log = mock(() => {})
  console.clear = mock(() => {})
})

afterAll(() => {
  // global teardown
  mock.restore()

  // Restore original console.log
  console.log = testLog
})
