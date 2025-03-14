import {
  expect,
  test,
  describe,
  beforeEach,
  afterEach,
  mock,
  spyOn,
} from "bun:test"
import * as fs from "node:fs/promises"
import path from "path"
import { loadConfig, withDefaultConfig } from "../src/config"
import { SyncManager, SyncManagerState } from "../src/sync"
import {
  TempCleaner,
  createUniqueTempDir,
  createTestSave,
  createTestFiles,
  spyOnClackPrompts,
  createTestComputer,
  captureUIOutput,
  expectToBeDefined,
  normalizeOutput,
  expectComputerResult,
  waitForEventWithTrigger,
} from "./test-helpers"
import { stringify } from "yaml"
import { SyncEvent, SyncStatus, type SyncOperationResult } from "../src/types"
import figures from "figures"
import { setTimeout } from "node:timers/promises"
import { UI } from "../src/ui"
import { AppError, ErrorSeverity } from "../src/errors"
import type { PathLike } from "node:fs"

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
      // Verify directory was actually removed
      const exists = await fs.exists(tempDir).catch(() => false)
      if (exists) {
        console.warn(`Warning: Failed to clean up test directory ${tempDir}`)
      }
    } catch (err) {
      console.warn(`Error during cleanup: ${err}`)
    } finally {
      mock.restore()
      clackPromptsSpy.cleanup()
    }
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

    const syncManager = new SyncManager(config, new UI())

    try {
      // Start manual mode and wait for first sync
      const { controller, start } = syncManager.initManualMode()

      const syncResult = await waitForEventWithTrigger<SyncOperationResult>(
        controller,
        SyncEvent.SYNC_COMPLETE,
        start
      )

      expect(syncResult.status).toBe(SyncStatus.SUCCESS)

      // Verify timestamp is recent
      expect(typeof syncResult.timestamp).toBe("number")
      expect(Date.now() - syncResult.timestamp).toBeLessThan(5000)

      // Verify computer results structure
      expect(syncResult.computerResults).toHaveLength(1)
      expect(syncResult.computerResults[0]).toMatchObject({
        computerId: "1",
        exists: true,
        successCount: 1,
        failureCount: 0,
      })

      // Verify file level details
      const fileResult = syncResult.computerResults[0].files[0]
      expect(fileResult).toMatchObject({
        targetPath: "/program.lua",
        success: true,
      })
      expect(fileResult.sourcePath).toContain("program.lua")

      // Verify no errors
      expect(syncResult.errors).toHaveLength(0)
      expect(syncResult.summary.successfulFiles).toBe(1)
      expect(syncResult.summary.fullySuccessfulComputers).toBe(1)

      // Verify actual files
      const targetFile = path.join(computersDir, "1", "program.lua")
      expect(await fs.exists(targetFile)).toBe(true)
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
    const syncManager = new SyncManager(config, new UI())

    const { controller, start } = syncManager.initWatchMode()
    try {
      const initialSyncResult =
        await waitForEventWithTrigger<SyncOperationResult>(
          controller,
          SyncEvent.INITIAL_SYNC_COMPLETE,
          start
        )

      // Verify initial sync results
      expect(initialSyncResult.status).toBe(SyncStatus.SUCCESS)
      expect(initialSyncResult.summary).toMatchObject({
        totalFiles: 2, // Number of rule matching files (1 file to 2 computers)
        successfulFiles: 2,
        failedFiles: 0,
        totalComputers: 2,
        fullySuccessfulComputers: 2,
        partiallySuccessfulComputers: 0,
        failedComputers: 0,
        missingComputers: 0,
      })
      expect(initialSyncResult.summary.fullySuccessfulComputers).toBe(2)
      expect(initialSyncResult.summary.failedComputers).toBe(0)
      expect(initialSyncResult.summary.missingComputers).toBe(0)

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

      const triggeredSyncResult =
        await waitForEventWithTrigger<SyncOperationResult>(
          controller,
          SyncEvent.SYNC_COMPLETE
        )

      expect(triggeredSyncResult.status).toBe(SyncStatus.SUCCESS)

      // Verify all computer results have appropriate success/failure counts
      for (const computerResult of triggeredSyncResult.computerResults) {
        expect(computerResult.successCount).toBe(1)
        expect(computerResult.failureCount).toBe(0)
        expect(computerResult.files).toHaveLength(1)

        // Verify file contents were actually updated in the sync result
        const fileResult = computerResult.files[0]
        expect(fileResult.success).toBe(true)
        expect(fileResult.targetPath).toBe("/program.lua")
      }

      expect(triggeredSyncResult.summary.fullySuccessfulComputers).toBe(2)
      expect(triggeredSyncResult.summary.failedComputers).toBe(0)
      expect(triggeredSyncResult.summary.missingComputers).toBe(0)

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

    const syncManager = new SyncManager(config, new UI())
    const { controller, start } = syncManager.initManualMode()

    try {
      const syncResult = await waitForEventWithTrigger<SyncOperationResult>(
        controller,
        SyncEvent.SYNC_COMPLETE,
        start
      )

      expect(syncResult.status).toBe(SyncStatus.SUCCESS)
      // Verify sync statistics
      expect(syncResult.summary.fullySuccessfulComputers).toBe(2)
      expect(syncResult.summary.failedComputers).toBe(0)
      expect(syncResult.summary.missingComputers).toBe(0)

      // Verify both computers' file states
      await Promise.all([
        verifyComputer1Files(path.join(computersDir, "1")),
        verifyComputer2Files(path.join(computersDir, "2")),
      ])
    } finally {
      await syncManager.stop()
    }

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
      expect(fs.exists(path.join(computer2Dir, "lib/utils.lua"))).resolves.toBe(
        true
      )

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
  })

  /**
   * Tests the watch mode's ability to detect and sync changes to multiple files.
   *
   * This test verifies:
   * 1. Initial sync correctly processes multiple glob-matched files
   * 2. File changes are detected and trigger a new sync
   * 3. Only the changed file is included in the change-triggered sync
   * 4. Original files remain intact while changed files are updated
   */
  test("handles glob pattern with multiple matching files in watch mode", async () => {
    const configPath = path.join(tempDir, ".ccsync.yaml")

    // Clear out the source directory to remove any default files
    await fs.rm(sourceDir, { recursive: true, force: true })
    await fs.mkdir(sourceDir, { recursive: true })

    // Create multiple lua files with unique content
    await fs.writeFile(path.join(sourceDir, "first.lua"), "print('First')")
    await fs.writeFile(path.join(sourceDir, "second.lua"), "print('Second')")
    await fs.writeFile(path.join(sourceDir, "third.lua"), "print('Third')")

    // Create config with a glob pattern to match all Lua files
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

    await fs.writeFile(configPath, stringify(configObject))

    // Create target computer
    await createTestComputer(computersDir, "1")

    const { config } = await loadConfig(configPath)
    if (!config) throw new Error("Failed to load config")

    const syncManager = new SyncManager(config, new UI())

    try {
      const { controller, start } = syncManager.initWatchMode()

      // Step 1: Wait for initial sync to complete
      const initialSyncResult =
        await waitForEventWithTrigger<SyncOperationResult>(
          controller,
          SyncEvent.INITIAL_SYNC_COMPLETE,
          start
        )

      // Verify initial sync
      expect(initialSyncResult.summary.fullySuccessfulComputers).toBe(1)
      expect(initialSyncResult.summary.failedComputers).toBe(0)
      expect(initialSyncResult.summary.missingComputers).toBe(0)

      // Find Computer 1 in results
      const computer1 = expectToBeDefined(
        initialSyncResult.computerResults.find((c) => c.computerId === "1")
      )

      // Verify all three files were synced
      const fileNames = computer1.files
        .filter((f) => f.success)
        .map((f) => path.basename(f.targetPath))
        .sort()

      expect(fileNames).toEqual(["first.lua", "second.lua", "third.lua"])

      // Verify all paths have the correct /lib/ prefix
      const allPathsHaveLibPrefix = computer1.files.every((f) =>
        f.targetPath.startsWith("/lib/")
      )
      expect(allPathsHaveLibPrefix).toBe(true)

      // Verify the files exist on disk with correct content
      const computer1LibDir = path.join(computersDir, "1", "lib")

      const firstContent = await fs.readFile(
        path.join(computer1LibDir, "first.lua"),
        "utf8"
      )
      expect(firstContent).toBe("print('First')")

      const secondContent = await fs.readFile(
        path.join(computer1LibDir, "second.lua"),
        "utf8"
      )
      expect(secondContent).toBe("print('Second')")

      const thirdContent = await fs.readFile(
        path.join(computer1LibDir, "third.lua"),
        "utf8"
      )
      expect(thirdContent).toBe("print('Third')")

      // Step 2: Modify one file to trigger watch
      // Step 3: Wait for the file change sync to complete
      const fileChangeSyncResult =
        await waitForEventWithTrigger<SyncOperationResult>(
          controller,
          SyncEvent.SYNC_COMPLETE,
          async () => {
            await fs.writeFile(
              path.join(sourceDir, "second.lua"),
              "print('Updated Second')"
            )
          }
        )

      // Verify change-triggered sync
      expect(fileChangeSyncResult.summary.fullySuccessfulComputers).toBe(1)
      expect(fileChangeSyncResult.summary.failedComputers).toBe(0)
      expect(fileChangeSyncResult.summary.missingComputers).toBe(0)

      // Get computer result
      const computer1AfterChange = expectToBeDefined(
        fileChangeSyncResult.computerResults.find((c) => c.computerId === "1")
      )

      // Verify only one file was synced (the changed one)
      expect(computer1AfterChange.files).toHaveLength(1)
      expect(path.basename(computer1AfterChange.files[0].targetPath)).toBe(
        "second.lua"
      )
      expect(computer1AfterChange.files[0].success).toBe(true)

      // Verify file content was updated, and the other files remain unchanged
      const updatedFirstContent = await fs.readFile(
        path.join(computer1LibDir, "first.lua"),
        "utf8"
      )
      const updatedSecondContent = await fs.readFile(
        path.join(computer1LibDir, "second.lua"),
        "utf8"
      )
      const updatedThirdContent = await fs.readFile(
        path.join(computer1LibDir, "third.lua"),
        "utf8"
      )

      // First and third should be unchanged
      expect(updatedFirstContent).toBe("print('First')")
      expect(updatedThirdContent).toBe("print('Third')")

      // Only second.lua should be updated
      expect(updatedSecondContent).toBe("print('Updated Second')")
    } finally {
      // Ensure cleanup happens regardless of test outcome
      await syncManager.stop()
    }
  })

  /**
   * Tests the system's ability to handle various path edge cases during sync operations.
   *
   * This test verifies:
   * 1. Handling of paths with spaces
   * 2. Deep nested directory paths
   * 3. Windows-style backslash paths
   * 4. Mixed separator paths (forward/backslashes)
   * 5. Path normalization across platforms
   */
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

    // Create test files with descriptive content
    const testFiles = [
      {
        path: "folder with spaces/test.lua",
        content: "print('spaces')",
        description: "path with spaces",
      },
      {
        path: "deep/nested/path/deep.lua",
        content: "print('deep')",
        description: "deeply nested path",
      },
      {
        path: "windows/style/path/win.lua",
        content: "print('windows')",
        description: "Windows-style path",
      },
      {
        path: "mixed/style/path/mixed.lua",
        content: "print('mixed')",
        description: "mixed separator path",
      },
    ]

    // Create all test files
    for (const file of testFiles) {
      await fs.writeFile(path.join(sourceDir, file.path), file.content)
    }

    // Create configuration with rules for each path type
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
    const syncManager = new SyncManager(config, new UI())

    try {
      const { controller, start } = syncManager.initManualMode()

      // Wait for sync completion with explicit timeout
      const syncResult = await waitForEventWithTrigger<SyncOperationResult>(
        controller,
        SyncEvent.SYNC_COMPLETE,
        start
      )

      // Verify overall success
      expect(syncResult.status).toBe(SyncStatus.SUCCESS)
      expect(syncResult.summary.fullySuccessfulComputers).toBe(2)
      expect(syncResult.summary.failedComputers).toBe(0)
      expect(syncResult.summary.missingComputers).toBe(0)

      // Check Computer 1 detailed results
      const computer1 = syncResult.computerResults.find(
        (c) => c.computerId === "1"
      )
      expect(computer1).toBeDefined()
      expect(computer1?.successCount).toBeGreaterThan(0)
      expect(computer1?.failureCount).toBe(0)

      const computer1Dir = path.join(computersDir, "1")

      // Define expected paths and contents for verification
      const pathVerifications = [
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

      // Systematically verify each path and its content
      for (const verify of pathVerifications) {
        const exists = await fs.exists(verify.path)
        expect(exists).toBe(true)

        if (exists) {
          const content = await fs.readFile(verify.path, "utf8")
          expect(content).toBe(verify.content)
        }
      }

      // Verify Computer 2's backup folder
      const computer2Dir = path.join(computersDir, "2")
      const backupDir = path.join(computer2Dir, "backup", "all", "files")

      // Verify all files were copied Computer 2 backup/
      for (const file of testFiles) {
        const filename = path.basename(file.path)
        const exists = await fs.exists(path.join(backupDir, filename))
        expect(exists).toBe(true)

        if (exists) {
          const content = await fs.readFile(
            path.join(backupDir, filename),
            "utf8"
          )
          expect(content).toBe(file.content)
        }
      }
    } finally {
      // Ensure cleanup happens regardless of test outcome
      await syncManager.stop()
    }
  })

  test("missing computers results in a SyncStatus.WARNING status", async () => {
    const configPath = path.join(tempDir, ".ccsync.yaml")
    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        {
          source: "program.lua",
          target: "/program.lua",
          computers: ["1", "999"],
        }, /// 999 is missing
      ],
    })

    const configContent = stringify(configObject)

    await fs.writeFile(configPath, configContent)
    await fs.mkdir(path.join(computersDir, "1"), { recursive: true })

    const { config } = await loadConfig(configPath)

    if (!config) throw new Error("Failed to load config")

    const syncManager = new SyncManager(
      config,
      new UI({ renderDynamicElements: false })
    )

    try {
      // Start manual mode and wait for first sync
      const { controller, start } = syncManager.initManualMode()

      const syncResult = await waitForEventWithTrigger<SyncOperationResult>(
        controller,
        SyncEvent.SYNC_COMPLETE,
        start
      )

      expect(syncResult.status).toBe(SyncStatus.WARNING)
      expect(syncResult.summary.missingComputers).toBe(1)

      // Missing computer 999
      const computer999 = expectToBeDefined(
        syncResult.computerResults.find((cr) => cr.computerId === "999")
      )
      expect(computer999.exists).toBeFalse()
      expect(computer999.successCount).toBe(0)
      expect(computer999.failureCount).toBe(0)

      expect(await fs.exists(path.join(computersDir, "999"))).toBeFalse()

      // Existing comptuer 1
      // Should have still synced successfully with computer 1
      // Verify file level details
      const computer1 = expectToBeDefined(
        syncResult.computerResults.find((cr) => cr.computerId === "1")
      )
      const fileResult = computer1.files[0]
      expect(fileResult).toMatchObject({
        targetPath: "/program.lua",
        success: true,
      })
      expect(fileResult.sourcePath).toContain("program.lua")

      // Verify no errors
      expect(syncResult.errors).toHaveLength(0)
      expect(syncResult.summary.successfulFiles).toBe(1)
      expect(syncResult.summary.fullySuccessfulComputers).toBe(1)

      // Verify actual files
      const targetFile = path.join(computersDir, "1", "program.lua")
      expect(await fs.exists(targetFile)).toBe(true)
      const content = await fs.readFile(
        path.join(computersDir, "1", "program.lua"),
        "utf8"
      )
      expect(content).toBe("print('Hello')")
    } finally {
      await syncManager.stop()
    }
  })

  test("batches multiple file changes with debouncing in watch mode", async () => {
    // Create multiple test files
    await fs.mkdir(path.join(sourceDir, "batch-test"), {
      recursive: true,
    })
    await fs.writeFile(
      path.join(sourceDir, "batch-test/file1.lua"),
      "print('File 1 original')"
    )
    await fs.writeFile(
      path.join(sourceDir, "batch-test/file2.lua"),
      "print('File 2 original')"
    )
    await fs.writeFile(
      path.join(sourceDir, "batch-test/file3.lua"),
      "print('File 3 original')"
    )

    // Create a config with rules targeting these files
    const configPath = path.join(tempDir, ".ccsync.yaml")
    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        {
          source: "batch-test/*.lua",
          target: "/batch/",
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

    // Setup UI output capture to verify sync operations
    const outputCapture = captureUIOutput()

    const syncManager = new SyncManager(
      config,
      new UI({ renderDynamicElements: false })
    )

    const { controller, start } = syncManager.initWatchMode()

    try {
      // Wait for initial sync to complete
      const initialSyncResult =
        await waitForEventWithTrigger<SyncOperationResult>(
          controller,
          SyncEvent.INITIAL_SYNC_COMPLETE,
          start
        )

      // Verify initial sync results
      expect(initialSyncResult.status).toBe(SyncStatus.SUCCESS)
      expect(initialSyncResult.summary.totalFiles).toBe(3) // 3 files synced to 1 computer

      // Clear the UI output to start fresh for the batch sync test
      outputCapture.clear()

      const batchedSyncResult =
        await waitForEventWithTrigger<SyncOperationResult>(
          controller,
          SyncEvent.SYNC_COMPLETE,
          async () => {
            // This runs after event listeners are registered but before waiting for the event
            await Promise.all([
              fs.writeFile(
                path.join(sourceDir, "batch-test/file1.lua"),
                "print('File 1 updated')"
              ),
              fs.writeFile(
                path.join(sourceDir, "batch-test/file2.lua"),
                "print('File 2 updated')"
              ),
              fs.writeFile(
                path.join(sourceDir, "batch-test/file3.lua"),
                "print('File 3 updated')"
              ),
            ])

            // Add a short delay to ensure file system events are detected
            await setTimeout(100)
          },
          5000 // Timeout
        )

      // Check if all files were synced in a single operation
      expect(batchedSyncResult.status).toBe(SyncStatus.SUCCESS)

      const computer1 = expectToBeDefined(
        batchedSyncResult.computerResults.find((cr) => cr.computerId === "1"),
        "computer1"
      )

      // The computer should have 3 files in the result
      expect(computer1.files.length).toBe(3)
      expect(computer1.successCount).toBe(3)

      // Check if all files were updated correctly
      const updatedContentFile1 = await fs.readFile(
        path.join(computersDir, "1", "batch", "file1.lua"),
        "utf8"
      )
      const updatedContentFile2 = await fs.readFile(
        path.join(computersDir, "1", "batch", "file2.lua"),
        "utf8"
      )
      const updatedContentFile3 = await fs.readFile(
        path.join(computersDir, "1", "batch", "file3.lua"),
        "utf8"
      )

      expect(updatedContentFile1).toBe("print('File 1 updated')")
      expect(updatedContentFile2).toBe("print('File 2 updated')")
      expect(updatedContentFile3).toBe("print('File 3 updated')")

      // Check UI output to verify only one sync operation was performed
      const normalizedOutput = normalizeOutput(outputCapture.getOutput())

      // Count the number of sync completions - should be two for the initial + 1 batch
      const syncCompleteMatches = normalizedOutput.match(
        /Attempted to sync \d+ total/g
      )
      expect(syncCompleteMatches?.length).toBe(2)

      // Should indicate 3 files synced in a single operation
      expect(normalizedOutput).toContain("Attempted to sync 3 total files")
    } finally {
      outputCapture.restore()
      await syncManager.stop()
    }
  })

  test("handles file changes that occur during sync operations", async () => {
    const configPath = path.join(tempDir, ".ccsync.yaml")
    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        {
          source: "*.lua",
          target: "/",
          computers: ["1"],
        },
      ],
    })

    const configContent = stringify(configObject)
    await fs.writeFile(configPath, configContent)

    // Create target computers
    await createTestComputer(computersDir, "1")

    // Create initial test files
    await fs.writeFile(path.join(sourceDir, "program.lua"), "print('Original')")
    await fs.writeFile(path.join(sourceDir, "startup.lua"), "print('Original')")

    const { config } = await loadConfig(configPath)
    if (!config) throw new Error("Failed to load config")

    // Create a custom output capture to track sync events
    const outputCapture = captureUIOutput()
    const syncManager = new SyncManager(
      config,
      new UI({ renderDynamicElements: false })
    )

    const { controller, start } = syncManager.initWatchMode()

    try {
      // Wait for initial sync to complete
      const initialSyncResult =
        await waitForEventWithTrigger<SyncOperationResult>(
          controller,
          SyncEvent.INITIAL_SYNC_COMPLETE,
          start
        )

      expect(initialSyncResult.status).toBe(SyncStatus.SUCCESS)

      // Clear output to start fresh
      outputCapture.clear()

      // Create a promise that will resolve after we've seen two SYNC_COMPLETE events
      let syncCount = 0
      const twoSyncsCompleted = new Promise<void>((resolve) => {
        controller.on(SyncEvent.SYNC_COMPLETE, () => {
          syncCount++
          if (syncCount >= 2) {
            resolve()
          }
        })
      })

      // Use a deliberate sequence to test race condition handling:
      // 1. Modify program.lua to trigger first sync
      await fs.writeFile(
        path.join(sourceDir, "program.lua"),
        "print('First change')"
      )

      // 2. Wait the duration of the debounce delay to ensure that the next write file is not batched with the first
      await setTimeout(
        controller.getInternalState().debounceDelay +
          (process.env.CI ? 1000 : 10)
      )

      // 3. Modify startup.lua while first sync is in progress
      await fs.writeFile(
        path.join(sourceDir, "startup.lua"),
        "print('Changed during sync')"
      )

      // Wait for both syncs to complete (with timeout)
      await Promise.race([
        twoSyncsCompleted,
        setTimeout(5000).then(() => {
          throw new Error("Timeout waiting for two sync operations to complete")
        }),
      ])

      // Verify both files were properly synced to disk with correct content
      const program1Content = await fs.readFile(
        path.join(computersDir, "1", "program.lua"),
        "utf8"
      )
      expect(program1Content).toBe("print('First change')")

      const startup1Content = await fs.readFile(
        path.join(computersDir, "1", "startup.lua"),
        "utf8"
      )
      expect(startup1Content).toBe("print('Changed during sync')")

      // Check the output to ensure both files were actually processed
      const normalizedOutput = normalizeOutput(outputCapture.getOutput())
      expect(normalizedOutput).toContain("program.lua")
      expect(normalizedOutput).toContain("startup.lua")
    } finally {
      await syncManager.stop()
    }
  })

  test("handles fatal error during sync plan creation", async () => {
    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        {
          source: "*.lua",
          target: "/",
          computers: ["1"],
        },
      ],
    })

    // Create target computers
    await createTestComputer(computersDir, "1")

    const ui = new UI({ renderDynamicElements: false })
    const syncManager = new SyncManager(configObject, ui)

    // Mock createSyncPlan to throw a fatal error
    const spy = spyOn(syncManager, "createSyncPlan").mockImplementation(() => {
      throw new AppError("Test fatal error", ErrorSeverity.FATAL, "test")
    })

    const { controller, start } = syncManager.initManualMode()

    const appError = await waitForEventWithTrigger<AppError>(
      controller,
      SyncEvent.SYNC_ERROR,
      start
    )

    expect(spy).toHaveBeenCalledTimes(1)

    // Verify error handling
    expect(appError.severity).toBe(ErrorSeverity.FATAL)
    expect(appError.message).toContain("Test fatal error")

    // Give some time for cleanup
    await setTimeout(100)

    // Verify sync manager is stopped
    expect(syncManager.isRunning()).toBe(false)
    expect(syncManager.getState()).toBe(SyncManagerState.STOPPED)

    // Restore mock
    spy.mockRestore()
  })

  test("handles file copy errors in manual mode and recovers for next sync", async () => {
    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        {
          source: "*.lua",
          target: "/",
          computers: ["1"],
        },
      ],
    })

    // Create target computers
    await createTestComputer(computersDir, "1")

    const ui = new UI({ renderDynamicElements: false })
    const syncManager = new SyncManager(configObject, ui)

    // Mock copyFilesToComputer to throw an error on first call only
    const originalCopyFile = fs.copyFile
    let callCount = 0
    const copyFileSpy = spyOn(fs, "copyFile").mockImplementation(
      (src: PathLike, dest: PathLike) => {
        callCount++
        if (callCount === 1) {
          throw new Error("File system error during copy")
        }
        return originalCopyFile(src, dest)
      }
    )

    const { controller, start } = syncManager.initManualMode()

    // Wait for first error
    const error = await waitForEventWithTrigger<AppError>(
      controller,
      SyncEvent.SYNC_ERROR,
      start
    )

    expect(error.message).toContain("File system error during copy")
    expect(copyFileSpy).toHaveBeenCalledTimes(2) // 2 files x 1 attempt
    expect(syncManager.isRunning()).toBe(true)

    // Try a second sync which should now succeed
    const result = await waitForEventWithTrigger<SyncOperationResult>(
      controller,
      SyncEvent.SYNC_COMPLETE,
      () => controller.performSyncCycle()
    )

    expect(copyFileSpy).toHaveBeenCalledTimes(4) // 2 files x 2 attempts
    expect(result.status).toBe(SyncStatus.SUCCESS)

    // Manager should still be running
    expect(syncManager.isRunning()).toBe(true)

    // Cleanup
    await syncManager.stop()
    copyFileSpy.mockRestore()
  })

  test("handle file sync errors in watch mode but continue watching", async () => {
    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        {
          source: "*.lua",
          target: "/",
          computers: ["1"],
        },
      ],
    })

    await createTestComputer(computersDir, "1")

    const ui = new UI({ renderDynamicElements: false })
    const syncManager = new SyncManager(configObject, ui)

    // Mock copyFilesToComputer to throw an error on specific calls
    const originalCopyFile = fs.copyFile
    let callCount = 0
    const copyFileSpy = spyOn(fs, "copyFile").mockImplementation(
      (src: PathLike, dest: PathLike) => {
        callCount++
        // First sync (2 files = 2 calls) is success
        if (callCount <= 2) {
          return originalCopyFile(src, dest)
        }
        // Second sync (1 file = call 3) fails
        if (callCount === 3) {
          throw new Error("File system error during copy")
        }
        // Third sync (1 file = call 4) succeeds agains
        return originalCopyFile(src, dest)
      }
    )

    const { controller, start } = syncManager.initWatchMode()

    // Wait for initial sync to complete
    const syncResult1 = await waitForEventWithTrigger<SyncOperationResult>(
      controller,
      SyncEvent.INITIAL_SYNC_COMPLETE,
      start
    )

    // Verify initial sync was successful
    expect(syncResult1.status).toBe(SyncStatus.SUCCESS)
    expect(syncResult1.computerResults.length).toBe(1)
    expect(syncResult1.computerResults[0].successCount).toBeGreaterThan(0)
    expect(syncResult1.computerResults[0].failureCount).toBe(0)
    expect(callCount).toBe(2)

    // Verify the sync manager is still running
    expect(syncManager.isRunning()).toBe(true)

    const syncResult2 = await waitForEventWithTrigger<SyncOperationResult>(
      controller,
      SyncEvent.SYNC_COMPLETE,
      async () => {
        await fs.writeFile(
          path.join(sourceDir, "program.lua"),
          "print('Program updated')"
        )
      },
      undefined,
      true // ignore the expected SyncError
    )

    expect(syncResult2.status).toBe(SyncStatus.ERROR)
    expect(callCount).toBe(3)

    // Despite errors, the manager should still be running
    expect(syncManager.isRunning()).toBe(true)

    // Now trigger a third sync that should succeed again
    const syncResult3 = await waitForEventWithTrigger<SyncOperationResult>(
      controller,
      SyncEvent.SYNC_COMPLETE,
      async () => {
        await fs.writeFile(
          path.join(sourceDir, "startup.lua"),
          "print('Startup updated')"
        )
      }
    )

    expect(callCount).toBe(4)

    // Verify the third sync was successful
    expect(syncResult3.status).toBe(SyncStatus.SUCCESS)
    expect(syncResult3.computerResults.length).toBe(1)
    expect(syncResult3.computerResults[0].successCount).toBeGreaterThan(0)
    expect(syncResult3.computerResults[0].failureCount).toBe(0)

    await syncManager.stop()
    expect(syncManager.getState()).toBe(SyncManagerState.STOPPED)

    copyFileSpy.mockRestore()
  })
})

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
    outputCapture.clear()
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

    const syncManager = new SyncManager(
      config,
      new UI({ renderDynamicElements: false })
    )

    try {
      // Start manual mode and wait for sync
      const { controller, start } = syncManager.initManualMode()

      // Wait for the sync to complete
      const syncResult = await waitForEventWithTrigger<SyncOperationResult>(
        controller,
        SyncEvent.SYNC_COMPLETE,
        start
      )

      // Check results
      expect(syncResult.summary.fullySuccessfulComputers).toBe(1)
      expect(syncResult.summary.failedComputers).toBe(0)

      // Get the captured output
      const normalizedOutput = normalizeOutput(outputCapture.getOutput())

      // Verify expected output contents
      expect(normalizedOutput).toMatch(
        /\[TIMESTAMP\] Attempted to sync 1 total file to 1 computer/
      )

      expectComputerResult(normalizedOutput, 1, {
        computerIcon: figures.tick,
        successCount: 1,
        totalCount: 1,
        additionalString: /program.lua/,
      })

      expect(normalizedOutput).not.toMatch(/No files synced/)
      expect(normalizedOutput).not.toMatch(/Error/)
      expect(normalizedOutput).not.toMatch(/Warning/)
    } finally {
      await syncManager.stop()
    }
  })

  test("shows files changed message during watch mode", async () => {
    // Create a basic config
    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      // should match ./program.lua and ./startup.lua
      rules: [{ source: "*.lua", target: "/", computers: ["1"] }],
    })

    await createTestComputer(computersDir, "1")

    const syncManager = new SyncManager(
      configObject,
      new UI({ renderDynamicElements: false })
    )

    try {
      // Start watch mode and wait for sync
      const { controller, start } = syncManager.initWatchMode()

      // Wait for the sync to complete
      const syncResult = await waitForEventWithTrigger<SyncOperationResult>(
        controller,
        SyncEvent.INITIAL_SYNC_COMPLETE,
        start
      )

      // Check results
      expect(syncResult.summary.fullySuccessfulComputers).toBe(1)
      expect(syncResult.summary.failedComputers).toBe(0)

      // Get the captured output
      const normalizedOutput = normalizeOutput(outputCapture.getOutput())

      expectComputerResult(normalizedOutput, 1, {
        computerIcon: figures.tick,
        successCount: 2,
        totalCount: 2,
      })

      outputCapture.clear()

      const triggeredSyncResult =
        await waitForEventWithTrigger<SyncOperationResult>(
          controller,
          SyncEvent.SYNC_COMPLETE,
          async () => {
            await Promise.all([
              fs.writeFile(
                path.join(sourceDir, "/program.lua"),
                "print('Program updated')"
              ),
              fs.writeFile(
                path.join(sourceDir, "/startup.lua"),
                "print('Startup updated')"
              ),
            ])

            // Add a short delay to ensure file system events are detected
            await setTimeout(100)
          }
        )

      expect(triggeredSyncResult.summary.fullySuccessfulComputers).toBe(1)
      expect(triggeredSyncResult.summary.failedComputers).toBe(0)

      // Get the captured output
      const normalizedOutput2 = normalizeOutput(outputCapture.getOutput())

      // Ensure that "Files changed:" exists followed by filenames, in any order
      expect(normalizedOutput2).toMatch(
        /Files changed:([\s\S]*?- \/program\.lua)?([\s\S]*?- \/startup\.lua)?/
      )
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

    const syncManager = new SyncManager(
      config,
      new UI({ renderDynamicElements: false })
    )

    try {
      // Start manual mode and wait for sync
      const { controller, start } = syncManager.initManualMode()

      // Wait for the sync to complete
      await waitForEventWithTrigger<SyncOperationResult>(
        controller,
        SyncEvent.SYNC_COMPLETE,
        start
      )

      // Get the captured output
      const normalizedOutput = normalizeOutput(outputCapture.getOutput())

      // Verify expected output contents
      // Check header appears first
      expect(normalizedOutput).toMatch(/^#1 \[TIMESTAMP\]/m)

      // Verify summary contains correct values
      expect(normalizedOutput).toMatch(/Attempted to sync 0 total files/)

      expect(normalizedOutput).toMatch(/No files synced/)
      expect(normalizedOutput).toMatch(/No matching files found for/)
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
          source: "program.lua",
          target: "/program.lua",
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

    const syncManager = new SyncManager(
      config,
      new UI({ renderDynamicElements: false })
    )

    try {
      // Start manual mode and wait for sync
      const { controller, start } = syncManager.initManualMode()

      // Wait for the sync to complete
      const syncResult = await waitForEventWithTrigger<SyncOperationResult>(
        controller,
        SyncEvent.SYNC_COMPLETE,
        start
      )

      // Verify the actual sync result structure for missing computers
      expect(syncResult.summary.missingComputers).toBe(2) // 888 and 999

      // Verify all computers are represented in the results
      expect(syncResult.computerResults).toHaveLength(3)

      // Verify which computers exist and which don't
      const existingComputers = syncResult.computerResults.filter(
        (c) => c.exists
      )
      const missingComputers = syncResult.computerResults.filter(
        (c) => !c.exists
      )

      expect(existingComputers).toHaveLength(1)
      expect(existingComputers[0].computerId).toBe("555")
      expect(existingComputers[0].successCount).toBe(1) // Successfully copied the file

      expect(missingComputers).toHaveLength(2)
      expect(missingComputers.map((c) => c.computerId)).toContain("888")
      expect(missingComputers.map((c) => c.computerId)).toContain("999")

      // Get the captured output
      const normalizedOutput = normalizeOutput(outputCapture.getOutput())

      // Verify the output contains computer 555 with success indicator
      expectComputerResult(normalizedOutput, 555, {
        computerIcon: figures.tick, // ✔
        successCount: 1,
        totalCount: 1,
        additionalString: /program.lua/,
      })

      // Verify missing computers are shown with appropriate indicators
      // Verify the warning message contains just the missing computers
      expect(normalizedOutput).toContain("Missing computers: 888, 999")

      // Verify 555 is not listed as missing
      expect(normalizedOutput).not.toMatch(/555.*Missing computer/)
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

    const syncManager = new SyncManager(
      config,
      new UI({ renderDynamicElements: false })
    )

    try {
      // Start manual mode and wait for sync
      const { controller, start } = syncManager.initManualMode()

      // Wait for the sync to complete
      await waitForEventWithTrigger<SyncOperationResult>(
        controller,
        SyncEvent.SYNC_COMPLETE,
        start
      )

      // Get the captured output
      const normalizedOutput = normalizeOutput(outputCapture.getOutput())

      // Verify expected output contents
      expect(normalizedOutput).toContain(
        "Attempted to sync 3 total files across 2 computers"
      )

      expectComputerResult(normalizedOutput, 1, {
        computerIcon: figures.tick,
        successCount: 2,
        totalCount: 2,
        additionalString: /program.lua/,
      })

      expectComputerResult(normalizedOutput, 2, {
        computerIcon: figures.tick,
        successCount: 1,
        totalCount: 1,
        additionalString: /program.lua/,
      })
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

    const syncManager = new SyncManager(
      config,
      new UI({ renderDynamicElements: false })
    )

    try {
      // Start manual mode
      const { controller, start } = syncManager.initManualMode()

      // First sync
      await waitForEventWithTrigger<SyncOperationResult>(
        controller,
        SyncEvent.SYNC_COMPLETE,
        start
      )

      // Clear current output to analyze the next round
      outputCapture.clear()

      // Wait for the second sync to complete
      await waitForEventWithTrigger<SyncOperationResult>(
        controller,
        SyncEvent.SYNC_COMPLETE,
        async () => {
          // Trigger another sync by simulating a key press
          await controller.performSyncCycle()
        }
      )

      // Get the captured output
      const normalizedOutput = normalizeOutput(outputCapture.getOutput())

      // Check that it shows the second sync operation
      expect(normalizedOutput).toContain("#2")
      expect(normalizedOutput).toContain(
        "Attempted to sync 1 total file to 1 computer"
      )
    } finally {
      await syncManager.stop()
    }
  })

  test("shows warning UI message when files are removed during watch", async () => {
    // This test will specifically check the UI message when files are removed
    const configPath = path.join(tempDir, ".ccsync.yaml")
    const fileToDelete = path.join(sourceDir, "temp-watched-file.lua")

    // Create the test file
    await fs.writeFile(
      fileToDelete,
      "print('I will be deleted to trigger warning')"
    )

    // Create a config with a rule matching our file
    const configObject = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: savePath,
      rules: [
        {
          source: "*.lua",
          target: "/",
          computers: ["1"],
        },
      ],
    })

    await fs.writeFile(configPath, stringify(configObject))
    await createTestComputer(computersDir, "1")

    const { config } = await loadConfig(configPath)
    if (!config) throw new Error("Failed to load config")

    const syncManager = new SyncManager(
      config,
      new UI({ renderDynamicElements: false })
    )

    try {
      const { controller, start } = syncManager.initWatchMode()

      // Wait for initial sync to complete
      await waitForEventWithTrigger<SyncOperationResult>(
        controller,
        SyncEvent.INITIAL_SYNC_COMPLETE,
        start
      )

      // Clear existing output to only capture new messages
      outputCapture.clear()

      // Delete the file to trigger a warning
      await fs.unlink(fileToDelete)

      // Give the watcher time to process the event and update UI
      await setTimeout(1000)

      // Get the captured output
      const normalizedOutput = normalizeOutput(outputCapture.getOutput())

      // Verify the warning message appears
      expect(normalizedOutput).toContain("temp-watched-file.lua")
      expect(normalizedOutput).toContain("removed or renamed")
      expect(normalizedOutput).toContain("will no longer be watched")

      outputCapture.clear()

      const triggeredSyncResult =
        await waitForEventWithTrigger<SyncOperationResult>(
          controller,
          SyncEvent.SYNC_COMPLETE,
          async () => {
            // Modify source file to trigger watch
            await fs.writeFile(
              path.join(sourceDir, "program.lua"),
              "print('Updated')"
            )
          }
        )

      expect(triggeredSyncResult.status).toBe(SyncStatus.SUCCESS)

      const normalizedOutput2 = normalizeOutput(outputCapture.getOutput())

      expect(normalizedOutput2).toContain("temp-watched-file.lua")
      expect(normalizedOutput2).toContain("removed or renamed")
      expect(normalizedOutput2).toContain("no longer being watched")
    } finally {
      await syncManager.stop()
    }
  })
})
