import { expect, test, describe, beforeEach, afterEach, mock } from "bun:test"
import * as fs from "node:fs/promises"
import path from "path"
import { loadConfig, withDefaultConfig } from "../src/config"
import { SyncManager } from "../src/sync"
import {
  TempCleaner,
  createUniqueTempDir,
  createTestSave,
  createTestFiles,
  spyOnClackPrompts,
  createTestComputer,
  waitForEvent,
  captureUIOutput,
} from "./test-helpers"
import { stringify } from "yaml"
import { SyncEvent, type SyncResult } from "../src/types"
import stripAnsi from "strip-ansi"

describe("Integration: SyncManager", () => {
  let tempDir: string
  let sourceDir: string
  let savePath: string
  let computersDir: string

  let clackPromptsSpy: ReturnType<typeof spyOnClackPrompts>
  const cleanup = TempCleaner.getInstance()

  beforeEach(async () => {
    tempDir = createUniqueTempDir()
    cleanup.add(tempDir)

    sourceDir = path.join(tempDir, "src")
    savePath = path.join(tempDir, "mc/saves/test_world")
    computersDir = path.join(savePath, "computercraft/computer")

    // Setup test environment
    await fs.mkdir(sourceDir, { recursive: true })
    await fs.mkdir(path.dirname(savePath), { recursive: true })
    await createTestSave(savePath)
    await createTestFiles(sourceDir)

    // Setup @clack/prompts spy
    clackPromptsSpy = spyOnClackPrompts()
  })

  afterEach(async () => {
    // Ensure synchronous cleanup
    try {
      await cleanup.cleanDir(tempDir)
    } catch (err) {
      console.warn(
        `Warning: Failed to clean up test directory ${tempDir}:`,
        err
      )
    }
    mock.restore()
    clackPromptsSpy.cleanup()
  })

  test("performs manual sync", async () => {
    const configPath = path.join(tempDir, ".ccsync.yaml")
    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        { source: "program.lua", target: "/program.lua", computers: ["1"] },
      ],
    })

    const configContent = stringify(configObject)

    await fs.writeFile(configPath, configContent)
    await fs.mkdir(path.join(computersDir, "1"), { recursive: true })

    const { config } = await loadConfig(configPath)

    if (!config) throw new Error("Failed to load config")

    const syncManager = new SyncManager(config)

    try {
      // Start manual mode and wait for first sync
      const manualController = await syncManager.startManualMode()

      const syncResult = await waitForEvent<SyncResult>(
        manualController,
        SyncEvent.SYNC_COMPLETE
      )

      // Verify results
      const targetFile = path.join(computersDir, "1", "program.lua")
      expect(await fs.exists(targetFile)).toBe(true)
      expect(syncResult.successCount).toBe(1)
      const content = await fs.readFile(
        path.join(computersDir, "1", "program.lua"),
        "utf8"
      )
      expect(content).toBe("print('Hello')")
    } finally {
      await syncManager.stop()
    }
  })

  test("handles file changes in watch mode", async () => {
    const configPath = path.join(tempDir, ".ccsync.yaml")
    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        {
          source: "program.lua",
          target: "/program.lua",
          computers: ["1", "2"],
        },
      ],
    })

    const configContent = stringify(configObject)
    await fs.writeFile(configPath, configContent)

    // Create target computers
    await createTestComputer(computersDir, "1")
    await createTestComputer(computersDir, "2")

    const { config } = await loadConfig(configPath)
    if (!config) throw new Error("Failed to load config")
    const syncManager = new SyncManager(config)

    const watchController = await syncManager.startWatchMode()
    try {
      const initialSyncResult = await waitForEvent<SyncResult>(
        watchController,
        SyncEvent.INITIAL_SYNC_COMPLETE
      )

      // Verify initial sync results
      expect(initialSyncResult.successCount).toBe(2) // Both computers synced
      expect(initialSyncResult.errorCount).toBe(0)
      expect(initialSyncResult.missingCount).toBe(0)

      // Verify files were copied
      expect(await fs.exists(path.join(computersDir, "1", "program.lua"))).toBe(
        true
      )
      expect(await fs.exists(path.join(computersDir, "2", "program.lua"))).toBe(
        true
      )

      // Modify source file to trigger watch
      await fs.writeFile(
        path.join(sourceDir, "program.lua"),
        "print('Updated')"
      )

      const triggeredSyncResult = await waitForEvent<SyncResult>(
        watchController,
        SyncEvent.SYNC_COMPLETE
      )

      // Verify sync results
      expect(triggeredSyncResult.successCount).toBe(2)
      expect(triggeredSyncResult.errorCount).toBe(0)
      expect(triggeredSyncResult.missingCount).toBe(0)

      // Verify updated content was copied
      const content1 = await fs.readFile(
        path.join(computersDir, "1", "program.lua"),
        "utf8"
      )
      const content2 = await fs.readFile(
        path.join(computersDir, "2", "program.lua"),
        "utf8"
      )
      expect(content1).toBe("print('Updated')")
      expect(content2).toBe("print('Updated')")
    } finally {
      await syncManager.stop()
    }
  })

  /**
   * Tests complex file sync scenarios with multiple rules and glob patterns.
   *
   * Test validates:
   * 1. Basic glob pattern syncing ("*.lua" -> "/" flattens files to root)
   * 2. Directory-specific glob patterns ("programs/*.lua" -> "/" flattens from programs/ to root)
   * 3. Directory preservation with target directories ("lib/*.lua" -> "/lib/" maintains utils.lua)
   * 4. Directory structure preservation with recursive globs when flatten=false (** / *.lua -> /all/)
   * 5. Multiple computers getting different sets of files based on rules
   */
  test("handles multiple sync rules with complex patterns", async () => {
    // Create base test files
    await createTestFiles(sourceDir)

    // Add test file in programs/ directory
    await fs.mkdir(path.join(sourceDir, "programs"), { recursive: true })
    await fs.writeFile(
      path.join(sourceDir, "programs/main.lua"),
      "print('Main Program')"
    )

    const configPath = path.join(tempDir, ".ccsync.yaml")
    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        // Computer 1: Root files to root directory (flattened)
        { source: "*.lua", target: "/", computers: ["1"] },
        // Computer 1: Programs files to root directory (flattened)
        { source: "programs/*.lua", target: "/", computers: ["1"] },
        // Computer 1: Root files to backup directory (flattened)
        { source: "*.lua", target: "/backup/", computers: ["1"] },
        // Computer 1: Programs files to backup directory (flattened)
        { source: "programs/*.lua", target: "/backup/", computers: ["1"] },
        // Both computers: lib files to lib directory
        { source: "lib/*.lua", target: "/lib/", computers: ["1", "2"] },
        // Computer 2: All files to /all/ preserving source directory structure
        {
          source: "**/*.lua", // Matches all .lua files recursively
          target: "/all/",
          computers: ["2"],
          flatten: false, // Preserve source structure relative to sourceRoot
        },
      ],
    })

    await fs.writeFile(configPath, stringify(configObject))
    await Promise.all([
      createTestComputer(computersDir, "1", { createStartup: false }),
      createTestComputer(computersDir, "2", { createStartup: false }),
    ])

    const { config } = await loadConfig(configPath)
    if (!config) throw new Error("Failed to load config")

    const syncManager = new SyncManager(config)
    const manualController = await syncManager.startManualMode()
    let syncCompleted = false

    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          manualController.off(SyncEvent.SYNC_COMPLETE, handleSyncComplete)
          manualController.off(SyncEvent.SYNC_ERROR, handleSyncError)
        }

        const handleSyncComplete = async ({
          successCount,
          errorCount,
          missingCount,
        }: SyncResult) => {
          try {
            // Verify sync statistics
            expect(successCount).toBe(2) // Both computers processed
            expect(errorCount).toBe(0) // No errors
            expect(missingCount).toBe(0) // No missing computers

            // Verify both computers' file states
            await Promise.all([
              verifyComputer1Files(path.join(computersDir, "1")),
              verifyComputer2Files(path.join(computersDir, "2")),
            ])

            syncCompleted = true
            cleanup()
            resolve()
          } catch (err) {
            cleanup()
            reject(err)
          }
        }

        const handleSyncError = (error: unknown) => {
          cleanup()
          reject(error)
        }

        manualController.once(SyncEvent.SYNC_COMPLETE, handleSyncComplete)
        manualController.once(SyncEvent.SYNC_ERROR, handleSyncError)
      })

      expect(syncCompleted).toBe(true)
    } finally {
      await manualController.stop()
      await syncManager.stop()
    }
  })

  async function verifyComputer1Files(computer1Dir: string) {
    // Check root level files
    const rootFiles = await Promise.all([
      fs.exists(path.join(computer1Dir, "program.lua")), // from root
      fs.exists(path.join(computer1Dir, "startup.lua")), // from root
      fs.exists(path.join(computer1Dir, "main.lua")), // from programs/
      fs.exists(path.join(computer1Dir, "lib/utils.lua")), // from lib/
    ])
    rootFiles.forEach((exists) => expect(exists).toBe(true))

    // Check backup directory
    const backupFiles = await Promise.all([
      fs.exists(path.join(computer1Dir, "backup/program.lua")), // from root
      fs.exists(path.join(computer1Dir, "backup/startup.lua")), // from root
      fs.exists(path.join(computer1Dir, "backup/main.lua")), // from programs/
    ])
    backupFiles.forEach((exists) => expect(exists).toBe(true))

    // Verify content of one file to ensure proper copying
    const content = await fs.readFile(
      path.join(computer1Dir, "program.lua"),
      "utf8"
    )
    expect(content).toBe("print('Hello')")
  }

  async function verifyComputer2Files(computer2Dir: string) {
    // Verify lib files exist in root lib directory
    await expect(
      fs.exists(path.join(computer2Dir, "lib/utils.lua"))
    ).resolves.toBe(true)

    // Check all directory has files with preserved structure
    const allDirFiles = await Promise.all([
      fs.exists(path.join(computer2Dir, "all/program.lua")), // from root
      fs.exists(path.join(computer2Dir, "all/startup.lua")), // fromt root
      fs.exists(path.join(computer2Dir, "all/programs/main.lua")), // from programs/
      fs.exists(path.join(computer2Dir, "all/lib/utils.lua")), // from lib/
    ])
    allDirFiles.forEach((exists) => expect(exists).toBe(true))

    // Verify files don't exist in root (except lib)
    const rootFiles = await Promise.all([
      fs.exists(path.join(computer2Dir, "program.lua")),
      fs.exists(path.join(computer2Dir, "startup.lua")),
      fs.exists(path.join(computer2Dir, "main.lua")),
    ])
    rootFiles.forEach((exists) => expect(exists).toBe(false))
  }

  test("handles glob pattern with multiple matching files in watch mode", async () => {
    const configPath = path.join(tempDir, ".ccsync.yaml")

    // Create multiple lua files
    await fs.writeFile(path.join(sourceDir, "first.lua"), "print('First')")
    await fs.writeFile(path.join(sourceDir, "second.lua"), "print('Second')")
    await fs.writeFile(path.join(sourceDir, "third.lua"), "print('Third')")

    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        {
          source: "*.lua", // Glob pattern matching multiple files
          target: "/lib/",
          computers: ["1"],
        },
      ],
    })

    const configContent = stringify(configObject)
    await fs.writeFile(configPath, configContent)

    // Create target computer
    await createTestComputer(computersDir, "1")

    const { config } = await loadConfig(configPath)
    if (!config) throw new Error("Failed to load config")
    const syncManager = new SyncManager(config)
    const watchController = await syncManager.startWatchMode()

    await new Promise<void>((resolve, reject) => {
      try {
        // Track test phases
        let initialSyncCompleted = false
        let fileChangeDetected = false
        let fileChangeSynced = false

        // Listen for initial sync completion
        watchController.on(
          SyncEvent.INITIAL_SYNC_COMPLETE,
          async ({ successCount, errorCount, missingCount }) => {
            try {
              initialSyncCompleted = true

              // Verify initial sync results
              expect(successCount).toBe(1) // One computer synced
              expect(errorCount).toBe(0)
              expect(missingCount).toBe(0)

              // Verify all files were copied
              const computer1LibDir = path.join(computersDir, "1", "lib")
              expect(
                await fs.exists(path.join(computer1LibDir, "first.lua"))
              ).toBe(true)
              expect(
                await fs.exists(path.join(computer1LibDir, "second.lua"))
              ).toBe(true)
              expect(
                await fs.exists(path.join(computer1LibDir, "third.lua"))
              ).toBe(true)

              // Modify one of the files to trigger watch
              await fs.writeFile(
                path.join(sourceDir, "second.lua"),
                "print('Updated Second')"
              )
              fileChangeDetected = true
            } catch (err) {
              reject(err)
            }
          }
        )

        // Listen for file change sync
        watchController.on(
          SyncEvent.SYNC_COMPLETE,
          async ({ successCount, errorCount, missingCount }) => {
            if (
              !initialSyncCompleted ||
              !fileChangeDetected ||
              fileChangeSynced
            ) {
              return // Only handle the first file change after initial sync
            }

            try {
              fileChangeSynced = true

              // Verify sync results
              expect(successCount).toBe(1)
              expect(errorCount).toBe(0)
              expect(missingCount).toBe(0)

              // Verify only the changed file was updated
              const computer1LibDir = path.join(computersDir, "1", "lib")
              const content1 = await fs.readFile(
                path.join(computer1LibDir, "first.lua"),
                "utf8"
              )
              const content2 = await fs.readFile(
                path.join(computer1LibDir, "second.lua"),
                "utf8"
              )
              const content3 = await fs.readFile(
                path.join(computer1LibDir, "third.lua"),
                "utf8"
              )

              expect(content1).toBe("print('First')") // Unchanged
              expect(content2).toBe("print('Updated Second')") // Changed
              expect(content3).toBe("print('Third')") // Unchanged

              // Test complete
              await syncManager.stop()
              resolve()
            } catch (err) {
              reject(err)
            }
          }
        )

        // Handle errors
        watchController.on(SyncEvent.SYNC_ERROR, (error) => {
          reject(error.message)
        })

        // Set timeout for test
        const timeout = setTimeout(async () => {
          await syncManager.stop()
          reject(new Error("Test timeout - watch events not received"))
        }, 5000)

        // Clean up timeout on success
        process.once("beforeExit", () => clearTimeout(timeout))
      } catch (err) {
        reject(err)
      }
    })
    await syncManager.stop()
  })

  test("handles path edge cases in sync operation", async () => {
    const configPath = path.join(tempDir, ".ccsync.yaml")

    // Create test files with various path cases
    await fs.mkdir(path.join(sourceDir, "folder with spaces"), {
      recursive: true,
    })
    await fs.mkdir(path.join(sourceDir, "deep/nested/path"), {
      recursive: true,
    })
    await fs.mkdir(path.join(sourceDir, "windows/style/path"), {
      recursive: true,
    })
    await fs.mkdir(path.join(sourceDir, "mixed/style/path"), {
      recursive: true,
    })

    // Create test files
    const testFiles = [
      {
        path: "folder with spaces/test.lua",
        content: "print('spaces')",
      },
      {
        path: "deep/nested/path/deep.lua",
        content: "print('deep')",
      },
      {
        path: "windows/style/path/win.lua",
        content: "print('windows')",
      },
      {
        path: "mixed/style/path/mixed.lua",
        content: "print('mixed')",
      },
    ]

    // Create all test files
    for (const file of testFiles) {
      await fs.writeFile(path.join(sourceDir, file.path), file.content)
    }

    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        // Test spaces in paths
        {
          source: "folder with spaces/*.lua",
          target: "/path with spaces/",
          computers: ["1"],
        },
        // Test nested paths
        {
          source: "deep/nested/path/*.lua",
          target: "/very/deep/nested/target/",
          computers: ["1"],
        },
        // Test Windows-style target paths
        {
          source: "windows/style/path/*.lua",
          target: "windows\\target\\folder\\", // Windows separators in target
          computers: ["1"],
        },
        // Test mixed path styles in target
        {
          source: "mixed/style/path/*.lua",
          target: "mixed\\style/target\\", // Mixed separators in target
          computers: ["1"],
        },
        // Test all files with Windows-style target
        {
          source: "**/*.lua",
          target: "backup\\all\\files\\", // Windows separators
          computers: ["2"],
        },
      ],
    })

    await fs.writeFile(configPath, stringify(configObject))

    // Create target computers
    await createTestComputer(computersDir, "1", { createStartup: false })
    await createTestComputer(computersDir, "2", { createStartup: false })

    const { config } = await loadConfig(configPath)
    if (!config) throw new Error("Failed to load config")
    const syncManager = new SyncManager(config)

    const manualController = await syncManager.startManualMode()

    try {
      await new Promise<void>((resolve, reject) => {
        manualController.on(
          SyncEvent.SYNC_COMPLETE,
          async ({ successCount, errorCount, missingCount }) => {
            try {
              expect(errorCount).toBe(0)
              expect(missingCount).toBe(0)
              expect(successCount).toBe(2)

              const computer1Dir = path.join(computersDir, "1")

              // Test each path case
              const verifications = [
                {
                  desc: "spaces in path",
                  path: path.join(computer1Dir, "path with spaces", "test.lua"),
                  content: "print('spaces')",
                },
                {
                  desc: "deep nested path",
                  path: path.join(
                    computer1Dir,
                    "very",
                    "deep",
                    "nested",
                    "target",
                    "deep.lua"
                  ),
                  content: "print('deep')",
                },
                {
                  desc: "Windows-style target path",
                  path: path.join(
                    computer1Dir,
                    "windows",
                    "target",
                    "folder",
                    "win.lua"
                  ),
                  content: "print('windows')",
                },
                {
                  desc: "mixed style target path",
                  path: path.join(
                    computer1Dir,
                    "mixed",
                    "style",
                    "target",
                    "mixed.lua"
                  ),
                  content: "print('mixed')",
                },
              ]

              // Verify each path and content
              for (const verify of verifications) {
                const exists = await fs.exists(verify.path)
                if (!exists) {
                  throw new Error(
                    `Failed to handle ${verify.desc}: File not found at ${verify.path}`
                  )
                }

                const content = await fs.readFile(verify.path, "utf8")
                if (content !== verify.content) {
                  throw new Error(`Content mismatch for ${verify.desc}`)
                }
              }

              // Verify Computer 2's backup folder
              const computer2Dir = path.join(computersDir, "2")
              const backupDir = path.join(
                computer2Dir,
                "backup",
                "all",
                "files"
              )

              // All files should be in backup
              for (const file of testFiles) {
                const filename = path.basename(file.path)
                const exists = await fs.exists(path.join(backupDir, filename))
                if (!exists) {
                  throw new Error(`Backup file not found: ${filename}`)
                }
              }

              await manualController.stop()
              await syncManager.stop()
              resolve()
            } catch (err) {
              await syncManager.stop()
              reject(err)
            }
          }
        )

        manualController.on(SyncEvent.SYNC_ERROR, async (error) => {
          await syncManager.stop()
          reject(error.message)
        })
      })
    } finally {
      await syncManager.stop()
    }
  })
})

// This function helps extract just the content we care about for testing
// It filters out styling/color codes and timestamps which would make tests brittle
function normalizeOutput(output: string[]): string {
  // Join all output lines
  const joinedOutput = output.join("\n")

  // Replace timestamps with placeholder to make tests more stable
  const withoutTimestamps = joinedOutput.replace(
    /\[\d{1,2}\/\d{1,2}\/\d{4},\s+\d{1,2}:\d{2}:\d{2}\s+[APM]{2}\]/g,
    "[TIMESTAMP]"
  )

  // Strip the ANSI color codes and return the normalized output
  return stripAnsi(withoutTimestamps)
}

describe("Integration: UI", () => {
  let tempDir: string
  let sourceDir: string
  let savePath: string
  let computersDir: string

  let clackPromptsSpy: ReturnType<typeof spyOnClackPrompts>
  let outputCapture: ReturnType<typeof captureUIOutput>
  const cleanup = TempCleaner.getInstance()

  beforeEach(async () => {
    tempDir = createUniqueTempDir()
    cleanup.add(tempDir)

    sourceDir = path.join(tempDir, "src")
    savePath = path.join(tempDir, "mc/saves/test_world")
    computersDir = path.join(savePath, "computercraft/computer")

    // Setup test environment
    await fs.mkdir(sourceDir, { recursive: true })
    await fs.mkdir(path.dirname(savePath), { recursive: true })
    await createTestSave(savePath)
    await createTestFiles(sourceDir)

    // Setup @clack/prompts spy
    clackPromptsSpy = spyOnClackPrompts()

    // Setup output capture
    outputCapture = captureUIOutput()
  })

  afterEach(async () => {
    // Ensure synchronous cleanup
    try {
      await cleanup.cleanDir(tempDir)
    } catch (err) {
      console.warn(
        `Warning: Failed to clean up test directory ${tempDir}:`,
        err
      )
    }
    outputCapture.restore()
    mock.restore()
    clackPromptsSpy.cleanup()
  })

  test("displays successful sync operation", async () => {
    // Create a basic config
    const configPath = path.join(tempDir, ".ccsync.yaml")
    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        { source: "program.lua", target: "/program.lua", computers: ["1"] },
      ],
    })

    await fs.writeFile(configPath, stringify(configObject))
    await fs.mkdir(path.join(computersDir, "1"), { recursive: true })

    const { config } = await loadConfig(configPath, {
      skipPathValidation: true,
    })
    if (!config) throw new Error("Failed to load config")

    const syncManager = new SyncManager(config)

    try {
      // Start manual mode and wait for sync
      const manualController = await syncManager.startManualMode()

      // Wait for the sync to complete
      const syncResult = await waitForEvent<SyncResult>(
        manualController,
        SyncEvent.SYNC_COMPLETE
      )

      // Check results
      expect(syncResult.successCount).toBe(1)
      expect(syncResult.errorCount).toBe(0)

      // Get the captured output
      const capturedOutput = outputCapture.getOutput()
      const normalizedOutput = normalizeOutput(capturedOutput)

      // Verify expected output contents
      expect(normalizedOutput).toContain(
        "Attempted to sync 1 total file to 1 computer"
      )
      expect(normalizedOutput).toContain("Computer 1")
      expect(normalizedOutput).toContain("/program.lua")
      expect(normalizedOutput).not.toContain("No files synced")
      expect(normalizedOutput).not.toContain("Error")
      expect(normalizedOutput).not.toContain("Warning")
    } finally {
      await syncManager.stop()
    }
  })

  test("displays warning when no matching files found", async () => {
    // Create a config with a rule that won't match any files
    const configPath = path.join(tempDir, ".ccsync.yaml")
    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        { source: "nonexistent/*.lua", target: "/test/", computers: ["1"] },
      ],
    })

    await fs.writeFile(configPath, stringify(configObject))
    await fs.mkdir(path.join(computersDir, "1"), { recursive: true })

    const { config } = await loadConfig(configPath, {
      skipPathValidation: true,
    })
    if (!config) throw new Error("Failed to load config")

    const syncManager = new SyncManager(config)

    try {
      // Start manual mode and wait for sync
      const manualController = await syncManager.startManualMode()

      // Wait for the sync to complete
      await waitForEvent<SyncResult>(manualController, SyncEvent.SYNC_COMPLETE)

      // Get the captured output
      const capturedOutput = outputCapture.getOutput()
      const normalizedOutput = normalizeOutput(capturedOutput)

      // Verify expected output contents
      expect(normalizedOutput).toContain("Attempted to sync 0 total files")
      expect(normalizedOutput).toContain("No files synced")
      expect(normalizedOutput).toContain("No matching files found for")
    } finally {
      await syncManager.stop()
    }
  })

  test("displays errors when missing computers", async () => {
    // Create a config that references a non-existent computer
    const configPath = path.join(tempDir, ".ccsync.yaml")
    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        {
          source: "",
          target: "",
          computers: ["555", "888", "999"],
        },
      ],
    })

    await createTestComputer(computersDir, "555")

    await fs.writeFile(configPath, stringify(configObject))
    // Deliberately NOT creating computer 888 and 999

    const { config } = await loadConfig(configPath, {
      skipPathValidation: true,
    })
    if (!config) throw new Error("Failed to load config")

    const syncManager = new SyncManager(config)

    try {
      // Start manual mode and wait for sync
      const manualController = await syncManager.startManualMode()

      // Wait for the sync to complete
      await waitForEvent<SyncResult>(manualController, SyncEvent.SYNC_COMPLETE)

      // Get the captured output
      const capturedOutput = outputCapture.getOutput()
      const normalizedOutput = normalizeOutput(capturedOutput)

      // Verify expected output contents
      expect(normalizedOutput).toContain("Missing computer")
      expect(normalizedOutput).toContain("888")
      expect(normalizedOutput).toContain("999")
      expect(normalizedOutput).not.toContain("555")
    } finally {
      await syncManager.stop()
    }
  })

  test("displays multiple computers with correct file counts", async () => {
    // Create a config with multiple computers
    const configPath = path.join(tempDir, ".ccsync.yaml")
    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        {
          source: "program.lua",
          target: "/program.lua",
          computers: ["1", "2"],
        },
        { source: "startup.lua", target: "/startup.lua", computers: ["1"] },
      ],
    })

    await fs.writeFile(configPath, stringify(configObject))
    await fs.mkdir(path.join(computersDir, "1"), { recursive: true })
    await fs.mkdir(path.join(computersDir, "2"), { recursive: true })

    const { config } = await loadConfig(configPath)
    if (!config) throw new Error("Failed to load config")

    const syncManager = new SyncManager(config)

    try {
      // Start manual mode and wait for sync
      const manualController = await syncManager.startManualMode()

      // Wait for the sync to complete
      await waitForEvent<SyncResult>(manualController, SyncEvent.SYNC_COMPLETE)

      // Get the captured output
      const capturedOutput = outputCapture.getOutput()
      const normalizedOutput = normalizeOutput(capturedOutput)

      // Verify expected output contents
      expect(normalizedOutput).toContain(
        "Attempted to sync 3 total files across 2 computers"
      )
      expect(normalizedOutput).toContain("Computer 1: (2/2)")
      expect(normalizedOutput).toContain("Computer 2: (1/1)")
    } finally {
      await syncManager.stop()
    }
  })

  test("shows sync history for multiple operations", async () => {
    // Create a config with a rule
    const configPath = path.join(tempDir, ".ccsync.yaml")
    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        { source: "program.lua", target: "/program.lua", computers: ["1"] },
      ],
    })

    await fs.writeFile(configPath, stringify(configObject))
    await fs.mkdir(path.join(computersDir, "1"), { recursive: true })

    const { config } = await loadConfig(configPath)
    if (!config) throw new Error("Failed to load config")

    const syncManager = new SyncManager(config)

    try {
      // Start manual mode
      const manualController = await syncManager.startManualMode()

      // First sync
      await waitForEvent<SyncResult>(manualController, SyncEvent.SYNC_COMPLETE)

      // Clear current output to analyze the next round
      outputCapture.clear()

      // Trigger another sync by simulating a key press
      manualController.performSyncCycle()

      // Wait for the second sync to complete
      await waitForEvent<SyncResult>(manualController, SyncEvent.SYNC_COMPLETE)

      // Get the captured output
      const capturedOutput = outputCapture.getOutput()
      const normalizedOutput = normalizeOutput(capturedOutput)

      // Check that it shows the second sync operation
      expect(normalizedOutput).toContain("#2")
      expect(normalizedOutput).toContain(
        "Attempted to sync 1 total file to 1 computer"
      )
    } finally {
      await syncManager.stop()
    }
  })
})
