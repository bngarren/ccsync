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
import { mock } from "bun:test"
import { DEFAULT_CONFIG, type SyncRule } from "../src/config"
import * as yaml from "yaml"
import type { IAppError } from "../src/errors"

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
  mock.module("@clack/prompts", () => ({
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
  private static instance: TempCleaner
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
      require("fs").rmSync(dir, { recursive: true })
    }
    this.tempDirs.clear()
  }
}

/**
 * Creates a promise that resolves when an event is emitted or rejects on error/timeout
 */
export function waitForEvent<T>(
  emitter: {
    on: (event: any, callback: any) => void
    off: (event: any, callback: any) => void
  },
  awaitedEvent: SyncEvent,
  timeoutMs = 5000
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
      cleanup()
      reject(new Error(`Operation failed: ${error.message}`))
    }

    // Clean up listeners
    // The specific event listeners (handleSuccess and handleError) are removed so they don't continue to listen for events after the promise has settled
    const cleanup = () => {
      clearTimeout(timeout)
      emitter.off(awaitedEvent, handleSuccess)
      emitter.off(SyncEvent.SYNC_ERROR, handleError)
    }

    // Register listeners
    emitter.on(awaitedEvent, handleSuccess)
    emitter.on(SyncEvent.SYNC_ERROR, handleError)
  })
}
