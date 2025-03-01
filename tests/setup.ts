import { beforeAll, afterAll, mock } from "bun:test"
import { initializeLogger } from "../src/log"

// Store original console.log
export const testLog = console.log

beforeAll(() => {
  // Initialize logger with testing configuration - silent and not to file
  initializeLogger({
    logToFile: false,
    logLevel: "silent",
  })

  // Mock the logger module for tests
  mock.module("../src/logger", () => ({
    default: {
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    },
    getLogger: () => ({
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
    }),
    initializeLogger: () => {},
  }))

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
