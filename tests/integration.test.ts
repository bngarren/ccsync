import { expect, test, describe, beforeEach, afterEach, mock } from "bun:test"
import * as fs from "node:fs/promises"
import path from "path"
import { loadConfig } from "../src/config"
import { SyncManager } from "../src/sync"
import {
  TempCleaner,
  createUniqueTempDir,
  createTestSave,
  createTestFiles,
  spyOnClackPrompts,
  createTestComputer,
  withDefaultConfig,
} from "./test-helpers"
import { stringify } from "yaml"
import { SyncEvent } from "../src/types"

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
      const manualLoop = await syncManager.startManualMode()

      await new Promise<void>((resolve, reject) => {
        manualLoop.on(SyncEvent.SYNC_COMPLETE, async ({ successCount }) => {
          try {
            const targetFile = path.join(computersDir, "1", "program.lua")
            expect(await fs.exists(targetFile)).toBe(true)
            expect(successCount).toBe(1)
            await manualLoop.stop()
            resolve()
          } catch (err) {
            reject(err)
          }
        })

        manualLoop.on(SyncEvent.SYNC_ERROR, (error) => {
          reject(error)
        })
      })
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

    try {
      // eslint-disable-next-line no-async-promise-executor
      return new Promise<void>(async (resolve, reject) => {
        const watchController = await syncManager.startWatchMode()

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
              expect(successCount).toBe(2) // Both computers synced
              expect(errorCount).toBe(0)
              expect(missingCount).toBe(0)

              // Verify files were copied
              expect(
                await fs.exists(path.join(computersDir, "1", "program.lua"))
              ).toBe(true)
              expect(
                await fs.exists(path.join(computersDir, "2", "program.lua"))
              ).toBe(true)

              // Modify source file to trigger watch
              await fs.writeFile(
                path.join(sourceDir, "program.lua"),
                "print('Updated')"
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
              expect(successCount).toBe(2)
              expect(errorCount).toBe(0)
              expect(missingCount).toBe(0)

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

              // Test complete
              await syncManager.stop()
              resolve()
            } catch (err) {
              reject(err)
            }
          }
        )

        // Handle errors
        watchController.on(SyncEvent.SYNC_ERROR, async ({ error }) => {
          await syncManager.stop()
          reject(error)
        })

        // Set timeout for test
        const timeout = setTimeout(async () => {
          await syncManager.stop()
          reject(new Error("Test timeout - watch events not received"))
        }, 5000)

        // Clean up timeout on success
        process.once("beforeExit", () => clearTimeout(timeout))
      })
    } finally {
      await syncManager.stop()
    }
  })

  test("handles multiple sync rules with complex patterns", async () => {
    const configPath = path.join(tempDir, ".ccsync.yaml")

    // Create additional test files
    await fs.mkdir(path.join(sourceDir, "programs"), { recursive: true })
    await fs.mkdir(path.join(sourceDir, "scripts"), { recursive: true })
    await fs.writeFile(
      path.join(sourceDir, "programs/main.lua"),
      "print('Main Program')"
    )
    await fs.writeFile(
      path.join(sourceDir, "programs/util.lua"),
      "print('Utility')"
    )
    await fs.writeFile(
      path.join(sourceDir, "scripts/startup.lua"),
      "print('Custom Startup')"
    )

    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        // Rule 1: Copy all program files to root directory
        {
          source: "programs/*.lua",
          target: "/",
          computers: ["1"],
        },
        // Rule 2: Copy the same program files to a subdirectory
        {
          source: "programs/*.lua",
          target: "/backup/",
          computers: ["1"],
        },
        // Rule 3: Copy specific file to multiple locations
        {
          source: "scripts/startup.lua",
          target: "/startup.lua",
          computers: ["1"],
        },
        {
          source: "scripts/startup.lua",
          target: "/system/startup.lua",
          computers: ["1"],
        },
        // Rule 4: Overlapping glob pattern
        {
          source: "**/*.lua",
          target: "/all/",
          computers: ["2"],
        },
      ],
    })

    const configContent = stringify(configObject)
    await fs.writeFile(configPath, configContent)

    // Create target computers
    await createTestComputer(computersDir, "1", { createStartup: false })
    await createTestComputer(computersDir, "2", { createStartup: false })

    const { config } = await loadConfig(configPath)
    if (!config) throw new Error("Failed to load config")
    const syncManager = new SyncManager(config)

    // Start manual mode and wait for sync
    // eslint-disable-next-line no-async-promise-executor
    return new Promise<void>(async (resolve, reject) => {
      try {
        const manualController = await syncManager.startManualMode()

        manualController.on(
          SyncEvent.SYNC_COMPLETE,
          async ({ successCount, errorCount, missingCount }) => {
            try {
              // Verify sync statistics
              expect(successCount).toBe(2) // Both computers synced
              expect(errorCount).toBe(0)
              expect(missingCount).toBe(0)

              // Computer 1: Verify files in root directory
              const computer1Dir = path.join(computersDir, "1")
              expect(await fs.exists(path.join(computer1Dir, "main.lua"))).toBe(
                true
              )
              expect(await fs.exists(path.join(computer1Dir, "util.lua"))).toBe(
                true
              )

              // Computer 1: Verify files in backup directory
              expect(
                await fs.exists(path.join(computer1Dir, "backup", "main.lua"))
              ).toBe(true)
              expect(
                await fs.exists(path.join(computer1Dir, "backup", "util.lua"))
              ).toBe(true)

              // Computer 1: Verify startup file in multiple locations
              expect(
                await fs.exists(path.join(computer1Dir, "startup.lua"))
              ).toBe(true)
              expect(
                await fs.exists(
                  path.join(computer1Dir, "system", "startup.lua")
                )
              ).toBe(true)

              // Verify content is identical for duplicated files
              const startupContent1 = await fs.readFile(
                path.join(computer1Dir, "startup.lua"),
                "utf8"
              )
              const startupContent2 = await fs.readFile(
                path.join(computer1Dir, "system", "startup.lua"),
                "utf8"
              )
              expect(startupContent1).toBe(startupContent2)
              expect(startupContent1).toBe("print('Custom Startup')")

              // Computer 2: Verify all Lua files are in all/ directory
              const computer2Dir = path.join(computersDir, "2")
              expect(
                await fs.exists(path.join(computer2Dir, "all", "main.lua"))
              ).toBe(true)
              expect(
                await fs.exists(path.join(computer2Dir, "all", "util.lua"))
              ).toBe(true)
              expect(
                await fs.exists(path.join(computer2Dir, "all", "startup.lua"))
              ).toBe(true)

              // Computer 2: Verify files aren't in root
              expect(await fs.exists(path.join(computer2Dir, "main.lua"))).toBe(
                false
              )
              expect(
                await fs.exists(path.join(computer2Dir, "startup.lua"))
              ).toBe(false)

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
          reject(error)
        })
      } catch (err) {
        await syncManager.stop()
        reject(err)
      }
    })
  })

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

    // eslint-disable-next-line no-async-promise-executor
    return new Promise<void>(async (resolve, reject) => {
      try {
        const watchController = await syncManager.startWatchMode()

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
        watchController.on(SyncEvent.SYNC_ERROR, ({ error }) => {
          reject(error)
        })

        // Set timeout for test
        const timeout = setTimeout(async () => {
          await syncManager.stop()
          reject(new Error("Test timeout - watch events not received"))
        }, 5000)

        // Clean up timeout on success
        process.once("beforeExit", () => clearTimeout(timeout))
      } catch (err) {
        await syncManager.stop()
        reject(err)
      }
    })
  })

  test.skip("handles path edge cases in sync operation", async () => {
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

    try {
      // eslint-disable-next-line no-async-promise-executor
      return new Promise<void>(async (resolve, reject) => {
        const manualController = await syncManager.startManualMode()

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
          reject(error)
        })
      })
    } finally {
      await syncManager.stop()
    }
  })
})
