import { beforeAll, afterAll, mock } from "bun:test"
import { initializeLogger } from "../src/log"
import { setTimeout } from "node:timers/promises"

// Store original console.log
export const testLog = console.log

const USE_FILE_LOGGING = true

beforeAll(() => {
  // Initialize logger with testing configuration
  initializeLogger({
    logToFile: USE_FILE_LOGGING,
    logLevel: "trace",
    isTest: true, // This will enable synchronous writes and change the filename
  })

  // Trying not to pollute the terminal output when running tests since our program utilizes lots of console and stdout output
  console.log = mock(() => {})
  console.clear = mock(() => {})
  process.stdout.write = mock(() => false)
})

afterAll(async () => {
  // global teardown
  mock.restore()

  // Restore original console.log
  console.log = testLog

  // small delay to finish writing logs
  if (USE_FILE_LOGGING) {
    await setTimeout(100)
  }
})
