import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "path"
import os from "os"
import crypto from "crypto"
import { SyncEvent, type Computer, type ResolvedFileRule } from "../src/types"
import {
  getComputerShortPath,
  isRecursiveGlob,
  pathIsLikelyFile,
} from "../src/utils"
import * as p from "@clack/prompts"
import { expect, mock } from "bun:test"
import { DEFAULT_CONFIG, type Config, type SyncRule } from "../src/config"
import * as yaml from "yaml"
import { getErrorMessage, type IAppError } from "../src/errors"
import stripAnsi from "strip-ansi"
import { rmSync } from "node:fs"

/**
 * Creates a new tmp directory in the operating system's default directory for temporary files.
 * This can be used to test actual file operations.
 *
 * **Example:**  /path/to/os/tmp/**ccsync-test-uniqueId**
 *
 * *Appends a random string to the tmp dir such that separate tests can run in parallel.*
 *
 * @returns Full path to tmp directory
 */
export function createUniqueTempDir() {
  const uniqueId = crypto.randomBytes(16).toString("hex")
  return path.join(os.tmpdir(), "ccsync-test", uniqueId)
}

/**
 * Creates some files/dir that mimic a Minecraft save dir, including a computercraft/computer directory
 * @param saveDir
 */
export async function createTestSave(saveDir: string) {
  // Create main directories
  await mkdir(path.join(saveDir, "region"), { recursive: true })
  await mkdir(path.join(saveDir, "computercraft", "computer"), {
    recursive: true,
  })

  // Create required files
  await writeFile(path.join(saveDir, "level.dat"), "")
  await writeFile(path.join(saveDir, "session.lock"), "")
}

/**
 * Creates a new computer with a dummy 'startup.lua' file
 * @param computersDir Full path to the computercraft/computers directory
 * @param id Computer ID must be a non-negative integer (string)
 */
export async function createTestComputer(
  computersDir: string,
  id: string,
  options: { createStartup?: boolean } = { createStartup: true }
) {
  const computerDir = path.join(computersDir, id)
  await mkdir(computerDir, { recursive: true })
  // Add a dummy file to simulate computer data
  if (options.createStartup) {
    await writeFile(path.join(computerDir, "startup.lua"), "")
  }
}

/**
 * Creates a set of files in the specified directory
 *
 * These mimic some typical files and directory structure that might exist in a CC project and that would be tracked for syncing with CC: Sync
 *
 * ```
 * /targetDir
 *   - program.lua // "print('Hello')"
 *   - startup.lua // "print('Startup')"
 *   /lib
 *     - utils.lua // "-- Utils"
 * ```
 *
 * @param targetDir
 */
export async function createTestFiles(targetDir: string) {
  await mkdir(targetDir, { recursive: true })
  await writeFile(path.join(targetDir, "program.lua"), "print('Hello')")
  await writeFile(path.join(targetDir, "startup.lua"), "print('Startup')")
  await mkdir(path.join(targetDir, "lib"), { recursive: true })
  await writeFile(path.join(targetDir, "lib/utils.lua"), "-- Utils")
}

/**
 * Helper function to create {@link Computer} object
 * @param id Computer ID must be a non-negative integer (string)
 * @param saveName Name of the Minecraft save
 * @param pathToComputersDir Full path to the computercraft/computers dir
 * @returns Computer object
 */
export function createComputerObject(
  id: string,
  saveName: string,
  pathToComputersDir: string
): Computer {
  return {
    id,
    path: path.join(pathToComputersDir, id),
    shortPath: getComputerShortPath(saveName, id),
  }
}

/**
 * Writes a config file to the given path. Can pass a partial Config object that will be merged with default config.
 * @param configPath Path to file, i.e. use a temp path for testing
 * @param configChanges Key/values to merge
 */
export const writeConfig = async (
  configPath: string,
  configChanges: Partial<typeof DEFAULT_CONFIG> = {}
) => {
  const config = { ...DEFAULT_CONFIG, ...configChanges }
  await writeFile(configPath, yaml.stringify(config))
}

/**
 * Bypasses the normal `loadConfig` and instead returns a direct yaml.parse of the passed config string. Helpful for testing. Will throw on error.
 * @param configString
 * @returns Config
 */
export const unsafeParseConfig = (configString: string) => {
  return yaml.parse(configString) as Config
}

// Cleanup helper
export async function cleanupTempDir(tempDir: string) {
  try {
    await rm(tempDir, { recursive: true, force: true })
  } catch (err) {
    console.warn(`Warning: Failed to clean up test directory ${tempDir}:`, err)
  }
}

export function spyOnClackPrompts() {
  const messages: string[] = []

  // Store original methods
  const original = {
    info: p.log.info,
    success: p.log.success,
    error: p.log.error,
    warn: p.log.warn,
  }

  // Replace with spy versions
  p.log.info = (msg: string) => {
    messages.push(`info: ${msg}`)
  }
  p.log.success = (msg: string) => {
    messages.push(`success: ${msg}`)
  }
  p.log.error = (msg: string) => {
    messages.push(`error: ${msg}`)
  }
  p.log.warn = (msg: string) => {
    messages.push(`warn: ${msg}`)
  }

  // Mock the entire @clack/prompts module for spinner
  // eslint-disable-next-line no-void
  void mock.module("@clack/prompts", () => ({
    ...p, // Keep all other original exports
    spinner: () => ({
      start: (msg: string) => {
        messages.push(`spinner: ${msg}`)
      },
      stop: (msg?: string) => {
        if (msg) messages.push(`spinner stop: ${msg}`)
      },
    }),
  }))

  // Return cleanup function and message getter
  return {
    messages,
    cleanup: () => {
      p.log.info = original.info
      p.log.success = original.success
      p.log.error = original.error
      p.log.warn = original.warn
      mock.restore()
    },
  }
}

interface CreateResolvedFileOptions {
  sourceRoot: string // Root of source files, per the config.sourceRoot
  sourcePath: string // Path relative to sourceRoot
  flatten?: boolean // Whether to flatten sources files into target dir
  targetPath: string
  computers: string | string[] // Computer IDs or array of IDs
}

/**
 * Creates a ResolvedFileRule for testing
 * @example
 * createResolvedFile({
 *   sourceRoot: "/src",
 *   sourcePath: "lib/utils.lua",
 *   targetPath: "/lib/",
 *   computers: ["1", "2"]
 * })
 */
export function createResolvedFile(
  opts: CreateResolvedFileOptions
): ResolvedFileRule {
  const sourceRoot = opts.sourceRoot
  const computers = Array.isArray(opts.computers)
    ? opts.computers
    : [opts.computers]

  // Determine if target is likely a directory
  const isDirectory = !pathIsLikelyFile(opts.targetPath)

  const flatten = opts.flatten !== undefined ? opts.flatten : true

  return {
    sourceAbsolutePath: path.resolve(sourceRoot, opts.sourcePath),
    sourceRelativePath: opts.sourcePath,
    flatten,
    target: {
      type: isDirectory ? "directory" : "file",
      path: opts.targetPath,
    },
    computers,
  }
}

/**
 * Creates multiple ResolvedFileRules for testing
 */
export function createResolvedFiles(
  sourceRoot: string,
  rules: SyncRule[]
): ResolvedFileRule[] {
  return rules.map((rule) => {
    return createResolvedFile({
      sourceRoot,
      sourcePath: rule.source,
      flatten: !isRecursiveGlob(rule.source) || rule.flatten,
      targetPath: rule.target,
      computers: rule.computers,
    })
  })
}

/**
 * Manages tmp directories created and helps to destroy them.
 *
 * Registers an on "exit" listener that will cleanup all tmp dirs if there is an unexpected termination during operation
 */
export class TempCleaner {
  private static instance: TempCleaner | null = null
  private tempDirs: Set<string> = new Set()
  private handlerRegistered = false

  private constructor() {
    // Register only once
    if (!this.handlerRegistered) {
      process.on("exit", () => {
        console.warn("Running test cleanup after unexpected termination!")
        this.cleanup()
      })
      this.handlerRegistered = true
    }
  }

  static getInstance(): TempCleaner {
    if (!TempCleaner.instance) {
      TempCleaner.instance = new TempCleaner()
    }
    return TempCleaner.instance
  }

  add(dir: string) {
    this.tempDirs.add(dir)
    //console.log("TempCleaner added: ", dir)
  }

  remove(dir: string) {
    this.tempDirs.delete(dir)
    //console.log("TempCleaner removed: ", dir)
  }

  async cleanDir(dir: string) {
    try {
      await rm(dir, { recursive: true, force: true })
      this.remove(dir)
    } catch (err) {
      console.warn(`Warning: Failed to clean up test directory ${dir}:`, err)
    }
  }

  private cleanup() {
    for (const dir of this.tempDirs) {
      rmSync(dir, { recursive: true })
    }
    this.tempDirs.clear()
  }
}

/**
 * Waits for an event to be emitted after executing a trigger function.
 * This ensures the event listener is registered before the action that causes the event.
 *
 * @param emitter The event emitter object
 * @param awaitedEvent The event to wait for
 * @param triggerFn The function to execute that will trigger the event
 * @param timeoutMs Maximum time to wait for the event in milliseconds
 * @returns Promise that resolves with the event data
 */
export function waitForEventWithTrigger<T>(
  emitter: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    on: (event: any, callback: any) => void
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    off: (event: any, callback: any) => void
  },
  awaitedEvent: SyncEvent,
  triggerFn?: () => unknown, // Function that triggers the event
  timeoutMs = 5000,
  ignoreError = false
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // Set timeout to avoid test hanging
    const timeout = setTimeout(() => {
      cleanup()
      reject(
        new Error(
          `Timed out waiting for ${SyncEvent[awaitedEvent]} after ${timeoutMs}ms`
        )
      )
    }, timeoutMs)

    // Success handler
    const handleSuccess = (data: T) => {
      cleanup()
      resolve(data)
    }

    // Error handler
    const handleError = (error: IAppError) => {
      if (ignoreError) return

      cleanup()
      reject(new Error(`Operation failed: ${error.message}`))
    }

    // Clean up listeners
    const cleanup = () => {
      clearTimeout(timeout)
      emitter.off(awaitedEvent, handleSuccess)
      emitter.off(SyncEvent.SYNC_ERROR, handleError)
    }

    // Register listeners FIRST
    emitter.on(awaitedEvent, handleSuccess)
    emitter.on(SyncEvent.SYNC_ERROR, handleError)

    // THEN execute the trigger function
    if (triggerFn) {
      const result = triggerFn()

      if (result && result instanceof Promise) {
        result.catch((error: unknown) => {
          cleanup()
          reject(
            new Error(`Failed to execute trigger: ${getErrorMessage(error)}`)
          )
        })
      }
    }
  })
}

/**
 * Mocks stdout.write to capture and store all UI output for later verification
 */
export function captureUIOutput() {
  const output: string[] = []
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalStdoutWrite = process.stdout.write

  const mockStdoutWrite = mock((...args: unknown[]) => {
    // Capture the output
    output.push(args.join(" "))
    return true
  })

  // Replace stdout
  process.stdout.write = mockStdoutWrite

  return {
    getOutput: () => [...output],
    clear: () => {
      output.length = 0
    },
    restore: () => {
      process.stdout.write = originalStdoutWrite
    },
  }
}
// ---- UI related helpers ----

/**
 * This function helps extract just the content we care about for testing.
 *  It filters out styling/color codes and timestamps which would make tests brittle
 */
export function normalizeOutput(output: string[]): string {
  // Join all output lines
  const joinedOutput = output.join("\n")

  // Replace variable content with placeholders
  const normalized = joinedOutput
    // Replace timestamps
    .replace(
      /\[\d{1,2}\/\d{1,2}\/\d{4},\s+\d{1,2}:\d{2}:\d{2}\s+[APM]{2}\]/g,
      "[TIMESTAMP]"
    )
    // Replace file paths but preserve filenames
    // eslint-disable-next-line no-useless-escape
    .replace(/([\\\/][\w\-\.]+){2,}([\\\/]([\w\-\.]+))/g, "[PATH]/$3")
    // Replace elapsed time references
    .replace(/\d+[ms](?: \d+[ms])* ago/g, "[TIME] ago")

  // Strip the ANSI color codes and return the normalized output
  return stripAnsi(normalized)
}

/**
 * Asserts that a computer's sync result in the UI output matches the provided conditions.
 *
 * @param testString - The string containing the sync result to be tested.
 * @param computerId - The ID of the computer (e.g., 1, 2).
 * @param options - Optional configuration for additional checks.
 * @param options.successCount - The number of successfully synced files. (Optional)
 * @param options.totalCount - The total number of files attempted to sync. (Optional)
 * @param options.additionalString - Additional string or regular expression to match after the computer sync result. (Optional)
 * @param options.computerIcon - A string or regex to match the computer icon before the "Computer X" string. (Optional)
 *
 * @example
 * // Test for Computer 1 with a success icon, success count of 2, and total count of 2
 * // e.g. "✔ Computer 1: (2/2) /program.lua"
 * expectComputerResult(testString, 1, { computerIcon: figures.tick, successCount: 2, totalCount: 2 });
 *
 * @example
 * // Test for Computer 2 with a success count of 1 and total count of 1, and check if a specific file path is mentioned
 * // e.g. "Computer 2: (1/1) /program.lua"
 * expectComputerResult(testString, 2, { successCount: 1, totalCount: 1, additionalString: '/program.lua' });
 *
 * @example
 * // Test for Computer 1, success count of 2, and total count of 2, with a regex to check for any file paths
 * // e.g. "Computer 1: (2/2) test.lua"
 * expectComputerResult(testString, 1, { successCount: 2, totalCount: 2, additionalString: /\/.*\.lua/ });
 */
export function expectComputerResult(
  testString: string,
  computerId: number | string,
  options: {
    successCount?: number
    totalCount?: number
    additionalString?: string | RegExp
    computerIcon?: string | RegExp
  } = {}
) {
  // Regex to match "Computer X" (where X is the computer ID)
  const computerRegex = new RegExp(`Computer ${String(computerId)}:`)

  let regexPattern = computerRegex

  // If options.computerIcon is provided, match the icon string before "Computer X"
  if (options.computerIcon) {
    const iconPattern =
      options.computerIcon instanceof RegExp
        ? options.computerIcon.source
        : options.computerIcon
    regexPattern = new RegExp(`(${iconPattern})?${regexPattern.source}`)
  }

  // If successCount and totalCount are provided, match them as well
  if (options.successCount && options.totalCount) {
    regexPattern = new RegExp(
      `${regexPattern.source} \\(${options.successCount}/${options.totalCount}\\)`
    )
  } else if (options.successCount) {
    regexPattern = new RegExp(
      `${regexPattern.source} \\(${options.successCount}\\)`
    )
  } else if (options.totalCount) {
    regexPattern = new RegExp(
      `${regexPattern.source} \\(${options.totalCount}\\)`
    )
  }

  // If additionalString is provided, use it as a regex or string
  if (options.additionalString) {
    if (options.additionalString instanceof RegExp) {
      regexPattern = new RegExp(
        `${regexPattern.source}.*${options.additionalString.source}`
      )
    } else {
      regexPattern = new RegExp(
        `${regexPattern.source}.*${options.additionalString}`
      )
    }
  }

  // Perform the actual test
  expect(testString).toMatch(regexPattern)
}

// ---- Expect helpers ----

/**
 * This function checks if value is defined using expect(value).toBeDefined(). If the value is defined, the function returns value but narrows its type to T (not T | undefined | null), allowing you to safely access its properties in the calling code.
 * @param value
 * @returns value (cast to T) or it fails the expect
 */
export const expectToBeDefined = <T>(
  value: T | undefined | null,
  name?: string
): T => {
  const msg = name && `'${name}' should not be undefined!`
  expect(value, msg).toBeDefined() // Fail the test if value is undefined or null
  return value as T // Return the value, which TypeScript can now narrow
}
