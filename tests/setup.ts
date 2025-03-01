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
  // Trying not to pollute the terminal output when running tests since our program utilizes lots of console and stdout output
  console.log = mock(() => {})
  console.clear = mock(() => {})
  process.stdout.write = mock(() => false)
})

afterAll(() => {
  // global teardown
  mock.restore()

  // Restore original console.log
  console.log = testLog
})
