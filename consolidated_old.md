## tests/utils.test.ts

```ts
import { expect, test, describe, beforeEach, afterEach, spyOn } from "bun:test"
import * as fs from "node:fs/promises"
import {
  validateMinecraftSave,
  findMinecraftComputers,
  copyFilesToComputer,
  resolveSyncRules,
  getComputerShortPath,
  normalizePath,
  toSystemPath,
  pathsAreEqual,
} from "../src/utils"
import path from "path"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { withDefaultConfig, type Config } from "../src/config"
import {
  createResolvedFile,
  createResolvedFiles,
  createTestComputer,
  createTestFiles,
  createTestSave,
  createUniqueTempDir,
  TempCleaner,
} from "./test-helpers"
import { testLog } from "./setup"

// ---- MC SAVE OPERATIONS ----
describe("Save Directory Validation", () => {
  let tempDir: string
  let testSaveDir: string

  const cleanup = TempCleaner.getInstance()

  beforeEach(async () => {
    // Create new unique temp directory for this test
    tempDir = createUniqueTempDir()
    cleanup.add(tempDir)

    testSaveDir = path.join(tempDir, "save")
    await createTestSave(testSaveDir)
  })

  afterEach(async () => {
    await cleanup.cleanDir(tempDir)
  })

  test("validates a correct save directory", async () => {
    const result = await validateMinecraftSave(testSaveDir)
    expect(result.isValid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  test("fails on missing save directory", async () => {
    // Remove the entire save directory
    await rm(testSaveDir, { recursive: true })

    const result = await validateMinecraftSave(testSaveDir)
    expect(result.isValid).toBe(false)
    expect(result.errors).toContain(`Save directory not found: ${testSaveDir}`)
  })

  test("fails on missing computercraft directory", async () => {
    // Remove just the computercraft directory
    await rm(path.join(testSaveDir, "computercraft"), { recursive: true })

    const result = await validateMinecraftSave(testSaveDir)
    expect(result.isValid).toBe(false)
    expect(result.missingFiles).toContain("computercraft/computer")
  })

  test("fails when required files are missing", async () => {
    // Remove the required files but keep directories
    await rm(path.join(testSaveDir, "level.dat"))
    await rm(path.join(testSaveDir, "session.lock"))

    const result = await validateMinecraftSave(testSaveDir)
    expect(result.isValid).toBe(false)
    expect(result.missingFiles).toContain("level.dat")
    expect(result.missingFiles).toContain("session.lock")
  })
})

// ---- COMPUTER OPERATIONS ----
describe("Computer Discovery", () => {
  let tempDir: string
  let testSaveDir: string
  let computersDir: string

  const cleanup = TempCleaner.getInstance()

  beforeEach(async () => {
    // Create new unique temp directory for this test
    tempDir = createUniqueTempDir()
    cleanup.add(tempDir)
    testSaveDir = path.join(tempDir, "save")
    computersDir = path.join(testSaveDir, "computercraft", "computer")
    await createTestSave(testSaveDir)
  })

  afterEach(async () => {
    await cleanup.cleanDir(tempDir)
  })

  test("discovers computers in save directory", async () => {
    await createTestComputer(computersDir, "0")
    await createTestComputer(computersDir, "1")
    await createTestComputer(computersDir, "2")

    const computers = await findMinecraftComputers(testSaveDir)
    expect(computers).toHaveLength(3)
    expect(computers.map((c) => c.id)).toEqual(["0", "1", "2"])
  })

  test("sorts computers numerically", async () => {
    await createTestComputer(computersDir, "2")
    await createTestComputer(computersDir, "10")
    await createTestComputer(computersDir, "1")

    const computers = await findMinecraftComputers(testSaveDir)
    expect(computers.map((c) => c.id)).toEqual(["1", "2", "10"])
  })

  test("includes non-numeric computer IDs", async () => {
    await createTestComputer(computersDir, "1")
    await createTestComputer(computersDir, "turtle")
    await createTestComputer(computersDir, "pocket")

    const computers = await findMinecraftComputers(testSaveDir)
    expect(computers.map((c) => c.id)).toEqual(["1", "pocket", "turtle"])
  })

  test("excludes system directories", async () => {
    await createTestComputer(computersDir, "0")
    await createTestComputer(computersDir, "1")
    // Create some system directories that should be excluded
    await mkdir(path.join(computersDir, ".git"), { recursive: true })
    await mkdir(path.join(computersDir, ".vscode"), { recursive: true })
    await mkdir(path.join(computersDir, ".DS_Store"), { recursive: true })

    const computers = await findMinecraftComputers(testSaveDir)
    expect(computers).toHaveLength(2)
    expect(computers.map((c) => c.id)).toEqual(["0", "1"])
  })

  test("sets correct paths for computers", async () => {
    await createTestComputer(computersDir, "1")

    const computers = await findMinecraftComputers(testSaveDir)
    expect(computers).toHaveLength(1)
    // Match types.ts -> Computer
    expect(computers[0]).toMatchObject({
      id: "1",
      path: path.join(computersDir, "1"),
      shortPath: expect.stringContaining("1"),
    })
  })

  test("returns empty array for empty computers directory", async () => {
    const computers = await findMinecraftComputers(testSaveDir)
    expect(computers).toHaveLength(0)
  })
})

// ---- PATH HANDLING ----

describe("Path Handling", () => {
  test("normalizes paths correctly", () => {
    const tests = [
      { input: "", expected: "" },
      { input: ".", expected: "." },
      { input: "..", expected: ".." },
      { input: "./folder", expected: "folder" },
      { input: "../folder", expected: "../folder" },
      { input: "folder//subfolder", expected: "folder/subfolder" },
      { input: "folder/./subfolder", expected: "folder/subfolder" },
      { input: "folder/../sibling", expected: "sibling" },
      {
        input: "C:\\Users\\test\\file.txt",
        expected: "C:/Users/test/file.txt",
      },
      {
        input: "folder\\subfolder\\file.txt",
        expected: "folder/subfolder/file.txt",
      },
      {
        input: "\\\\networkshare\\folder\\file.txt",
        expected: "//networkshare/folder/file.txt",
      },
      {
        input: "C:",
        expected: "C:",
      },
      { input: "C:\\", expected: "C:/" },
    ]

    for (const { input, expected } of tests) {
      expect(normalizePath(input)).toBe(expected)
    }
  })

  test("handles mixed path separators", () => {
    const tests = [
      {
        input: "folder/subfolder\\file.txt",
        expected: "folder/subfolder/file.txt",
      },
      {
        input: "C:\\Users/test\\documents/file.txt",
        expected: "C:/Users/test/documents/file.txt",
      },
    ]

    for (const { input, expected } of tests) {
      expect(normalizePath(input)).toBe(expected)
    }
  })

  test("handles trailing slashes correctly", () => {
    const tests = [
      // Directory targets
      {
        input: "lib/folder/",
        target: "lib/folder",
        description: "strips trailing slash from directory path",
        stripTrailing: true,
      },
      {
        input: "lib/folder//",
        target: "lib/folder",
        description: "normalizes multiple trailing slashes",
        stripTrailing: true,
      },
      {
        input: "lib/folder/",
        target: "lib/folder/",
        description: "keeps trailing slash when requested",
        stripTrailing: false,
      },
      // Root paths
      {
        input: "/",
        target: "/",
        description: "preserves root slash",
        stripTrailing: true,
      },
      // Windows paths
      {
        input: "lib\\folder\\",
        target: "lib/folder",
        description: "normalizes Windows trailing backslash",
        stripTrailing: true,
      },
      {
        input: "C:\\folder\\",
        target: "C:/folder",
        description: "handles Windows drive letter with trailing slash",
        stripTrailing: true,
      },
    ]

    for (const { input, target, description, stripTrailing } of tests) {
      try {
        expect(normalizePath(input, stripTrailing)).toBe(target)
      } catch (err) {
        throw new Error(`Failed: ${description}`)
      }
    }
  })

  test("handles root and special paths correctly", () => {
    const tests = [
      {
        input: "/",
        expected: "/",
        description: "root path remains unchanged",
      },
      {
        input: ".",
        expected: ".",
        description: "current directory remains as-is",
      },
      {
        input: "./folder",
        expected: "folder",
        description: "normalizes current directory reference",
      },
    ]

    for (const { input, expected } of tests) {
      expect(normalizePath(input)).toBe(expected)
    }
  })

  test("handles empty and invalid inputs", () => {
    expect(normalizePath("")).toBe("")
    expect(() => normalizePath(undefined as any)).toThrow(TypeError)
    expect(() => normalizePath(null as any)).toThrow(TypeError)
  })

  test("handles path comparison based on OS", async () => {
    // This test verifies path comparison works correctly on both Windows and Unix
    const tests = [
      {
        path1: "folder/FILE.lua",
        path2: "folder/file.lua",
        shouldMatch: process.platform === "win32", // true on Windows, false on Unix
      },
      {
        path1: "C:/Users/Test",
        path2: "c:/users/test",
        shouldMatch: process.platform === "win32",
      },
    ]

    for (const test of tests) {
      expect(pathsAreEqual(test.path1, test.path2)).toBe(test.shouldMatch)
    }
  })
})

// ---- FILE OPERATIONS ----
describe("File Operations", () => {
  let tempDir: string
  let testSaveDir: string
  let testSaveName: string
  let sourceDir: string
  let computersDir: string

  const cleanup = TempCleaner.getInstance()

  beforeEach(async () => {
    // Create new unique temp directory for this test
    tempDir = createUniqueTempDir()
    cleanup.add(tempDir)
    sourceDir = path.join(tempDir, "source")
    testSaveName = "world"
    testSaveDir = path.join(tempDir, testSaveName)
    computersDir = path.join(testSaveDir, "computercraft", "computer")

    await createTestSave(testSaveDir)
    await mkdir(sourceDir, { recursive: true })
    await createTestFiles(sourceDir)
  })

  afterEach(async () => {
    await cleanup.cleanDir(tempDir)
  })

  describe("validateFileSync", () => {
    test("validates files and returns correct structure", async () => {
      const config: Config = withDefaultConfig({
        sourceRoot: sourceDir,
        minecraftSavePath: testSaveDir,
        rules: [
          { source: "program.lua", target: "/program.lua", computers: ["1"] },
          { source: "startup.lua", target: "/startup.lua", computers: ["1"] },
        ],
      })

      const computers = [
        {
          id: "1",
          path: computersDir,
          shortPath: getComputerShortPath(testSaveName, "1"),
        },
      ]
      const validation = await resolveSyncRules(config, computers)

      expect(validation.resolvedFileRules).toHaveLength(2)
      expect(validation.availableComputers).toHaveLength(1)
      expect(validation.errors).toHaveLength(0)
    })

    test("handles missing files", async () => {
      const config: Config = withDefaultConfig({
        sourceRoot: sourceDir,
        minecraftSavePath: testSaveDir,
        rules: [
          { source: "missing.lua", target: "/missing.lua", computers: ["1"] },
        ],
      })

      const computers = [
        {
          id: "1",
          path: computersDir,
          shortPath: getComputerShortPath(testSaveName, "1"),
        },
      ]
      const validation = await resolveSyncRules(config, computers)

      expect(validation.resolvedFileRules).toHaveLength(0)
      expect(validation.errors).toHaveLength(1)
    })

    test("handles changedFiles filter in watch mode", async () => {
      const config: Config = withDefaultConfig({
        sourceRoot: sourceDir,
        minecraftSavePath: testSaveDir,
        rules: [
          { source: "program.lua", target: "/program.lua", computers: ["1"] },
          { source: "startup.lua", target: "/startup.lua", computers: ["1"] },
        ],
      })

      const computers = [
        {
          id: "1",
          path: computersDir,
          shortPath: getComputerShortPath(testSaveName, "1"),
        },
      ]
      const changedFiles = new Set(["program.lua"])

      const validation = await resolveSyncRules(config, computers, changedFiles)

      expect(validation.resolvedFileRules).toHaveLength(1)
      expect(validation.resolvedFileRules[0].sourceAbsolutePath).toContain(
        "program.lua"
      )
    })
  })

  describe("copyFilesToComputer", () => {
    let tempDir: string
    let sourceDir: string
    let computerDir: string

    const cleanup = TempCleaner.getInstance()

    beforeEach(async () => {
      // Create test directories
      tempDir = createUniqueTempDir()
      cleanup.add(tempDir)
      sourceDir = path.join(tempDir, "source")
      computerDir = path.join(tempDir, "computer")

      // Create base directories
      await fs.mkdir(sourceDir, { recursive: true })
      await fs.mkdir(computerDir, { recursive: true })
    })

    afterEach(async () => {
      await cleanup.cleanDir(tempDir)
    })

    // GIVEN a source file and Windows-style target paths
    test("explicitly handles Windows-style backslash paths", async () => {
      // Create source file
      await fs.writeFile(path.join(sourceDir, "program.lua"), "print('test')")

      const targetComputer = path.join(computerDir, "1")
      await fs.mkdir(targetComputer, { recursive: true })

      // Test multiple Windows path scenarios
      const pathTests = [
        {
          targetPath: "lib\\programs\\test.lua",
          expectedPath: "lib/programs/test.lua",
        },
        {
          targetPath: "\\programs\\main.lua",
          expectedPath: "programs/main.lua",
        },
        {
          targetPath: "apis\\lib\\util.lua",
          expectedPath: "apis/lib/util.lua",
        },
        {
          targetPath: "Program Files\\App\\test.lua", // Path with spaces
          expectedPath: "Program Files/App/test.lua",
        },
      ]

      // WHEN copying files with Windows paths
      for (const test of pathTests) {
        const resolvedFile = createResolvedFile({
          sourceRoot: sourceDir,
          sourcePath: "program.lua",
          targetPath: test.targetPath,
          computers: "1",
        })

        const result = await copyFilesToComputer([resolvedFile], targetComputer)
        // THEN files should be copied with normalized paths

        testLog(result.errors)

        expect(result.errors).toHaveLength(0)
        expect(result.copiedFiles).toHaveLength(1)

        // Verify file exists at expected normalized path
        const expectedFilePath = path.join(targetComputer, test.expectedPath)
        const exists = await fs.exists(toSystemPath(expectedFilePath))
        expect(exists).toBe(true)

        // Verify content
        const content = await fs.readFile(
          toSystemPath(expectedFilePath),
          "utf8"
        )
        expect(content).toBe("print('test')")
      }
    })

    test("handles mixed path separators in source and target", async () => {
      // Create source files with mixed separators
      await fs.mkdir(path.join(sourceDir, "lib/nested\\folder"), {
        recursive: true,
      })
      await fs.writeFile(
        path.join(sourceDir, "lib/nested\\folder\\program.lua"),
        "print('test')"
      )

      const resolvedFiles = createResolvedFiles(sourceDir, [
        {
          source: "lib/nested\\folder\\program.lua",
          target: "programs\\test/file.lua",
          computers: "1",
        },
      ])

      const targetComputer = path.join(computerDir, "1")
      await fs.mkdir(targetComputer, { recursive: true })

      const result = await copyFilesToComputer(resolvedFiles, targetComputer)
      expect(result.errors).toHaveLength(0)
      expect(result.copiedFiles).toHaveLength(1)

      // Verify file exists with normalized path
      const expectedPath = path.join(targetComputer, "programs/test/file.lua")
      const exists = await fs.exists(toSystemPath(expectedPath))
      expect(exists).toBe(true)
    })

    test("copies files with exact target paths", async () => {
      // Create source files with content
      const sourceProgramPath = path.join(sourceDir, "program.lua")
      const sourceStartupPath = path.join(sourceDir, "startup.lua")

      await fs.mkdir(path.dirname(sourceProgramPath), { recursive: true })
      await fs.writeFile(sourceProgramPath, "print('Hello')")
      await fs.writeFile(sourceStartupPath, "print('Startup')")

      const resolvedFiles = createResolvedFiles(sourceDir, [
        { source: "program.lua", target: "program.lua", computers: "1" },
        { source: "startup.lua", target: "main.lua", computers: "1" },
      ])

      await copyFilesToComputer(resolvedFiles, computerDir)

      // Verify target paths and content
      const targetProgramPath = path.join(computerDir, "program.lua")
      const targetMainPath = path.join(computerDir, "main.lua")

      // Verify program.lua
      {
        const stats = await fs.stat(targetProgramPath)
        expect(stats.isFile()).toBe(true)
        if (stats.isFile()) {
          const content = await fs.readFile(targetProgramPath, "utf8")
          expect(content).toBe("print('Hello')")
        }
      }

      // Verify main.lua
      {
        const stats = await fs.stat(targetMainPath)
        expect(stats.isFile()).toBe(true)
        if (stats.isFile()) {
          const content = await fs.readFile(targetMainPath, "utf8")
          expect(content).toBe("print('Startup')")
        }
      }
    })

    test("handles absolute paths relative to computer root", async () => {
      // Create source file
      await fs.writeFile(path.join(sourceDir, "program.lua"), "print('Root')")
      await fs.writeFile(path.join(sourceDir, "lib.lua"), "print('Lib')")

      // Create computer-specific directory
      const computer1Dir = path.join(computerDir, "1")
      await fs.mkdir(computer1Dir, { recursive: true })

      const resolvedFiles = createResolvedFiles(sourceDir, [
        // Absolute path to computer root
        { source: "program.lua", target: "/startup.lua", computers: "1" },
        // Absolute path to lib directory
        { source: "lib.lua", target: "/lib/", computers: "1" },
      ])

      await copyFilesToComputer(resolvedFiles, computer1Dir)

      // Verify files were copied to correct locations within computer directory
      expect(
        await fs.readFile(path.join(computer1Dir, "startup.lua"), "utf8")
      ).toBe("print('Root')")
      expect(
        await fs.readFile(path.join(computer1Dir, "lib", "lib.lua"), "utf8")
      ).toBe("print('Lib')")

      // Verify files weren't created in actual root
      expect(await fs.exists(path.join("/startup.lua"))).toBe(false)
      expect(await fs.exists(path.join("/lib/lib.lua"))).toBe(false)
    })

    test("copies files to directory targets", async () => {
      // Create source files
      await fs.mkdir(path.join(sourceDir, "lib"), { recursive: true })
      await fs.writeFile(path.join(sourceDir, "lib/utils.lua"), "-- Utils")

      const resolvedFiles = createResolvedFiles(sourceDir, [
        { source: "lib/utils.lua", target: "lib/", computers: ["1"] },
      ])

      await copyFilesToComputer(resolvedFiles, computerDir)

      // Verify file was copied to correct location
      const targetPath = path.join(computerDir, "lib", "utils.lua")
      expect(await fs.readFile(targetPath, "utf8")).toBe("-- Utils")
    })

    test("treats target without extension as directory", async () => {
      // Create source file
      await fs.writeFile(
        path.join(sourceDir, "program.lua"),
        "print('Program')"
      )

      const resolvedFiles = createResolvedFiles(sourceDir, [
        // Target has no extension = directory
        { source: "program.lua", target: "lib", computers: ["1"] },
      ])

      await copyFilesToComputer(resolvedFiles, computerDir)

      // Verify file was copied to lib directory with original name
      const targetPath = path.join(computerDir, "lib", "program.lua")
      expect(await fs.readFile(targetPath, "utf8")).toBe("print('Program')")
    })

    test("errors when target file exists but directory needed", async () => {
      // Create source file
      await fs.writeFile(
        path.join(sourceDir, "program.lua"),
        "print('Program')"
      )

      // Create a file named 'lib'
      await fs.writeFile(path.join(computerDir, "lib"), "I am a file")

      const resolvedFiles = createResolvedFiles(sourceDir, [
        // Try to use 'lib' as directory target
        { source: "program.lua", target: "lib", computers: ["1"] },
      ])

      const result = await copyFilesToComputer(resolvedFiles, computerDir)

      // Should fail with appropriate error
      expect(result.copiedFiles).toHaveLength(0)
      expect(result.skippedFiles).toHaveLength(1)
      expect(result.errors[0]).toContain("Cannot create directory") // Verify error message
    })

    test("renames file when target has extension", async () => {
      // Create source file
      await fs.writeFile(
        path.join(sourceDir, "program.lua"),
        "print('Program')"
      )

      const resolvedFiles = createResolvedFiles(sourceDir, [
        // Different name
        { source: "program.lua", target: "startup.lua", computers: ["1"] },
      ])

      const result = await copyFilesToComputer(resolvedFiles, computerDir)

      // Should succeed
      expect(result.copiedFiles).toHaveLength(1)
      expect(result.skippedFiles).toHaveLength(0)
      expect(result.errors).toHaveLength(0)

      // Verify file was renamed and copied correctly
      const targetPath = path.join(computerDir, "startup.lua")
      expect(await fs.exists(path.join(computerDir, "program.lua"))).toBe(false) // Original name shouldn't exist
      expect(await fs.readFile(targetPath, "utf8")).toBe("print('Program')")
    })

    test("handles nested directory structures", async () => {
      // Create a more complex source structure
      await fs.mkdir(path.join(sourceDir, "apis/net"), { recursive: true })
      await fs.writeFile(
        path.join(sourceDir, "apis/net/http.lua"),
        "-- HTTP API"
      )

      const resolvedFiles = createResolvedFiles(sourceDir, [
        { source: "apis/net/http.lua", target: "apis/", computers: ["1"] },
      ])

      await copyFilesToComputer(resolvedFiles, computerDir)

      // Verify file was copied correctly
      const targetPath = path.join(computerDir, "apis", "http.lua")
      expect(await fs.readFile(targetPath, "utf8")).toBe("-- HTTP API")
    })

    test("creates missing directories in target path", async () => {
      // Create source file
      await fs.writeFile(path.join(sourceDir, "program.lua"), "print('Init')")

      const resolvedFiles = createResolvedFiles(sourceDir, [
        {
          source: "program.lua",
          target: "programs/startup/init.lua",
          computers: ["1"],
        },
      ])

      await copyFilesToComputer(resolvedFiles, computerDir)

      // Verify file was copied correctly
      const targetPath = path.join(computerDir, "programs/startup/init.lua")
      expect(await fs.readFile(targetPath, "utf8")).toBe("print('Init')")
    })

    test("handles multiple files with mixed target types", async () => {
      // Create source files
      await fs.mkdir(path.join(sourceDir, "lib"), { recursive: true })
      await fs.writeFile(
        path.join(sourceDir, "program.lua"),
        "print('Program')"
      )
      await fs.writeFile(path.join(sourceDir, "lib/utils.lua"), "-- Utils")
      await fs.writeFile(path.join(sourceDir, "startup.lua"), "print('Boot')")

      const resolvedFiles = createResolvedFiles(sourceDir, [
        { source: "program.lua", target: "startup.lua", computers: "1" },
        { source: "lib/utils.lua", target: "apis/", computers: "1" },
        {
          source: "startup.lua",
          target: "system/boot/startup.lua",
          computers: "1",
        },
      ])

      await copyFilesToComputer(resolvedFiles, computerDir)

      // Verify all files were copied correctly
      expect(
        await fs.readFile(path.join(computerDir, "startup.lua"), "utf8")
      ).toBe("print('Program')")
      expect(
        await fs.readFile(path.join(computerDir, "apis/utils.lua"), "utf8")
      ).toBe("-- Utils")
      expect(
        await fs.readFile(
          path.join(computerDir, "system/boot/startup.lua"),
          "utf8"
        )
      ).toBe("print('Boot')")
    })

    test("maintains file contents correctly", async () => {
      // Create source files
      await fs.writeFile(path.join(sourceDir, "test1.lua"), "print('test1')")
      await fs.writeFile(path.join(sourceDir, "test2.lua"), "local x = 42")
      await fs.mkdir(path.join(sourceDir, "dir"), { recursive: true })
      await fs.writeFile(path.join(sourceDir, "dir/test3.lua"), "return true")

      // With this:
      const resolvedFiles = createResolvedFiles(sourceDir, [
        { source: "test1.lua", target: "a.lua", computers: "1" },
        { source: "test2.lua", target: "lib/", computers: "1" },
        { source: "dir/test3.lua", target: "modules/", computers: "1" },
      ])

      await copyFilesToComputer(resolvedFiles, computerDir)

      // Verify contents were preserved
      expect(await fs.readFile(path.join(computerDir, "a.lua"), "utf8")).toBe(
        "print('test1')"
      )
      expect(
        await fs.readFile(path.join(computerDir, "lib/test2.lua"), "utf8")
      ).toBe("local x = 42")
      expect(
        await fs.readFile(path.join(computerDir, "modules/test3.lua"), "utf8")
      ).toBe("return true")
    })

    test("attempts all files even when some fail", async () => {
      // Create source files
      await fs.writeFile(path.join(sourceDir, "a.lua"), "print('a')")
      await fs.writeFile(path.join(sourceDir, "b.lua"), "print('b')")
      await fs.writeFile(path.join(sourceDir, "c.lua"), "print('c')")

      // Create a file named 'lib' to cause directory creation to fail
      await fs.writeFile(path.join(computerDir, "lib"), "I am a file")

      const resolvedFiles = createResolvedFiles(sourceDir, [
        { source: "a.lua", target: "lib", computers: "1" }, // Will fail - lib exists as file
        { source: "b.lua", target: "other/", computers: "1" }, // Should succeed
        { source: "c.lua", target: "data/", computers: "1" }, // Should succeed
      ])

      const result = await copyFilesToComputer(resolvedFiles, computerDir)

      // First file should fail, other two should succeed
      expect(result.copiedFiles).toHaveLength(2)
      expect(result.skippedFiles).toHaveLength(1)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain("Cannot create directory")

      // Verify successful copies
      expect(
        await fs.readFile(path.join(computerDir, "other", "b.lua"), "utf8")
      ).toBe("print('b')")
      expect(
        await fs.readFile(path.join(computerDir, "data", "c.lua"), "utf8")
      ).toBe("print('c')")
    })

    test("prevents file copy outside of computer directory", async () => {
      // Create source file
      await fs.writeFile(path.join(sourceDir, "program.lua"), "print('Evil')")

      // Create computer-specific directory
      const computer1Dir = path.join(computerDir, "1")
      await fs.mkdir(computer1Dir, { recursive: true })

      // Array of malicious paths to test
      const maliciousPaths = [
        "../evil.lua", // Parent directory
        "../../evil.lua", // Multiple parent traversal
        "folder/../../../evil.lua", // Nested traversal
        "folder/./../../evil.lua", // Mixed traversal
        "folder/subdir/../../../evil.lua", // Complex traversal
        "../2/evil.lua", // Another computer's directory
        "../../computer/2/evil.lua", // Another computer via full path
      ]

      for (const maliciousPath of maliciousPaths) {
        testLog(`  - Testing malicious path: ${maliciousPath}`)

        const resolvedFiles = createResolvedFiles(sourceDir, [
          {
            source: "program.lua",
            target: maliciousPath,
            computers: ["1"],
          },
        ])

        // Expect the copy operation to fail
        const { copiedFiles, skippedFiles } = await copyFilesToComputer(
          resolvedFiles,
          computer1Dir
        )

        expect(copiedFiles).toHaveLength(0)
        expect(skippedFiles).toHaveLength(resolvedFiles.length)

        // Verify no files were created in parent directories
        for (const checkPath of [
          path.join(computer1Dir, "..", "evil.lua"),
          path.join(computer1Dir, "..", "2", "evil.lua"),
          path.join(computerDir, "evil.lua"),
          path.join(computerDir, "2", "evil.lua"),
        ]) {
          expect(await fs.exists(checkPath)).toBe(false)
        }
      }

      // Also test directory traversal with trailing slash
      const resolvedFiles = createResolvedFiles(sourceDir, [
        {
          source: "program.lua",
          target: "../dangerous/",
          computers: ["1"],
        },
      ])

      const { copiedFiles, skippedFiles } = await copyFilesToComputer(
        resolvedFiles,
        computer1Dir
      )
      expect(copiedFiles).toHaveLength(0)
      expect(skippedFiles).toHaveLength(resolvedFiles.length)
    })

    test("handles target file being in use by another process", async () => {
      await fs.writeFile(path.join(sourceDir, "program.lua"), "print('test')")
      await fs.mkdir(path.join(computersDir, "1"), { recursive: true })

      const spy = spyOn(fs, "copyFile").mockImplementation(async () => {
        const err = new Error(
          "EBUSY: resource busy or locked"
        ) as NodeJS.ErrnoException
        err.code = "EBUSY"
        throw err
      })

      const resolvedFiles = createResolvedFiles(sourceDir, [
        {
          source: "program.lua",
          target: "/program.lua",
          computers: ["1"],
        },
      ])

      const result = await copyFilesToComputer(
        resolvedFiles,
        path.join(computersDir, "1")
      )
      expect(result.skippedFiles).toContain(path.join(sourceDir, "program.lua"))
      expect(result.errors[0]).toContain("File is locked or in use")
      expect(spy).toHaveBeenCalled()
      spy.mockRestore()
    })
  })

  test("resolves computer groups and handles glob patterns", async () => {
    // GIVEN source files and computer groups configuration
    await mkdir(path.join(sourceDir, "apis"), { recursive: true })
    await writeFile(path.join(sourceDir, "apis/http.lua"), "-- HTTP API")
    await writeFile(path.join(sourceDir, "apis/json.lua"), "-- JSON API")

    const config: Config = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: testSaveDir,
      computerGroups: {
        network: {
          name: "Network Computers",
          computers: ["1", "2", "3"],
        },
        monitors: {
          name: "Monitor Network",
          computers: ["4", "5"],
        },
      },
      rules: [
        // Test glob pattern to group
        {
          source: "apis/*.lua", // This matches both http.lua and json.lua
          target: "/apis",
          computers: "network",
        },
        // Test glob pattern to multiple groups
        {
          source: "startup.lua",
          target: "/startup.lua",
          computers: ["network", "monitors"],
        },
      ],
    })

    const computers = [
      {
        id: "1",
        path: path.join(computersDir, "1"),
        shortPath: getComputerShortPath(testSaveName, "1"),
      },
      {
        id: "2",
        path: path.join(computersDir, "2"),
        shortPath: getComputerShortPath(testSaveName, "2"),
      },
      {
        id: "3",
        path: path.join(computersDir, "3"),
        shortPath: getComputerShortPath(testSaveName, "3"),
      },
      {
        id: "4",
        path: path.join(computersDir, "4"),
        shortPath: getComputerShortPath(testSaveName, "4"),
      },
      {
        id: "5",
        path: path.join(computersDir, "5"),
        shortPath: getComputerShortPath(testSaveName, "5"),
      },
    ]

    const validation = await resolveSyncRules(config, computers)

    // testLog({
    //   ruleCount: validation.resolvedFileRules.length,
    //   rules: validation.resolvedFileRules.map((r) => ({
    //     sourcePath: path.basename(r.sourcePath),
    //     targetPath: r.targetPath,
    //     computers: r.computers,
    //   })),
    // })

    // THEN verify the resolved rules

    // Should have 3 resolved files (http.lua, json.lua, startup.lua)
    expect(validation.resolvedFileRules).toHaveLength(3)

    // Verify glob pattern resolution
    const apiFiles = validation.resolvedFileRules.filter((f) =>
      normalizePath(f.target.path).startsWith("/apis")
    )
    expect(apiFiles).toHaveLength(2)
    expect(apiFiles[0].computers).toEqual(["1", "2", "3"]) // network group

    // Verify API files are the ones we expect
    const apiSourceFiles = apiFiles
      .map((f) => path.basename(f.sourceAbsolutePath))
      .sort()
    expect(apiSourceFiles).toEqual(["http.lua", "json.lua"])

    // Verify multiple group resolution
    const startupFile = validation.resolvedFileRules.find(
      (f) => normalizePath(f.target.path) === "/startup.lua"
    )
    expect(startupFile?.computers).toEqual(["1", "2", "3", "4", "5"]) // both groups
  })

  test("handles invalid computer groups", async () => {
    const config: Config = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: testSaveDir,
      rules: [
        {
          source: "program.lua",
          target: "/program.lua",
          computers: ["nonexistent_group", "1"],
        },
      ],
    })

    const computers = [
      {
        id: "1",
        path: computersDir,
        shortPath: getComputerShortPath(testSaveName, "1"),
      },
    ]
    const validation = await resolveSyncRules(config, computers)

    expect(validation.errors).toHaveLength(1)
    expect(validation.errors[0]).toContain("nonexistent_group")
  })

  test("handles mixed computer IDs and groups", async () => {
    const config: Config = withDefaultConfig({
      sourceRoot: sourceDir,
      minecraftSavePath: testSaveDir,
      computerGroups: {
        network: {
          name: "Network Computers",
          computers: ["1", "2"],
        },
      },
      rules: [
        {
          source: "program.lua",
          target: "/program.lua",
          computers: ["network", "3"], // Mix of group and direct ID
        },
      ],
    })

    const computers = [
      {
        id: "1",
        path: path.join(computersDir, "1"),
        shortPath: getComputerShortPath(testSaveName, "1"),
      },
      {
        id: "2",
        path: path.join(computersDir, "2"),
        shortPath: getComputerShortPath(testSaveName, "2"),
      },
      {
        id: "3",
        path: path.join(computersDir, "3"),
        shortPath: getComputerShortPath(testSaveName, "3"),
      },
    ]

    const validation = await resolveSyncRules(config, computers)

    const programFile = validation.resolvedFileRules[0]
    expect(programFile.computers).toEqual(["1", "2", "3"])
  })
})
```


## tests/test-helpers.ts

```ts
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "path"
import os from "os"
import crypto from "crypto"
import type { Computer, ResolvedFileRule } from "../src/types"
import {
  getComputerShortPath,
  isRecursiveGlob,
  pathIsLikelyFile,
} from "../src/utils"
import * as p from "@clack/prompts"
import { mock } from "bun:test"
import { DEFAULT_CONFIG, type SyncRule } from "../src/config"
import * as yaml from "yaml"

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
 *   - program.lua
 *   - startup.lua
 *   /lib
 *     - utils.lua
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

  return {
    sourceAbsolutePath: path.resolve(sourceRoot, opts.sourcePath),
    sourceRelativePath: opts.sourcePath,
    flatten: opts.flatten || true,
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
```


## tests/setup.ts

```ts
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
```


## tests/version.test.ts

```ts
// tests/version.test.ts
import { expect, test, describe, beforeEach, afterEach } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "path"
import {
  loadConfig,
  DEFAULT_CONFIG,
  CONFIG_VERSION,
  ConfigErrorCategory,
} from "../src/config"
import { createUniqueTempDir, TempCleaner, writeConfig } from "./test-helpers"
import yaml from "yaml"

describe("Version compatibility", () => {
  const tempCleaner = TempCleaner.getInstance()
  let tempDir: string
  let configPath: string

  beforeEach(async () => {
    tempDir = createUniqueTempDir()
    tempCleaner.add(tempDir)
    await mkdir(tempDir, { recursive: true })
    configPath = path.join(tempDir, ".ccsync.yaml")
  })

  afterEach(async () => {
    await tempCleaner.cleanDir(tempDir)
  })

  test("accepts valid config version", async () => {
    await writeConfig(configPath)
    const { config, errors } = await loadConfig(configPath, {
      skipPathValidation: true,
    })
    expect(errors).toHaveLength(0)
    expect(config?.version).toBe(CONFIG_VERSION)
  })

  test("rejects incompatible major version", async () => {
    await writeConfig(configPath, { version: "2.0" })
    const { config, errors } = await loadConfig(configPath)

    expect(errors).toHaveLength(1)
    expect(errors[0].category).toBe(ConfigErrorCategory.VERSION)
    expect(errors[0].message).toContain(
      `Config version ${CONFIG_VERSION} is required`
    )
    expect(config).toBeNull()
  })

  test("rejects missing version", async () => {
    const { version, ...configWithoutVersion } = DEFAULT_CONFIG
    await writeFile(configPath, yaml.stringify(configWithoutVersion))

    const { config, errors } = await loadConfig(configPath)

    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain("Config version is required")
    expect(config).toBeNull()
  })
})
```


## tests/config.test.ts

```ts
import { expect, test, describe, beforeEach, afterEach } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "path"
import {
  loadConfig,
  DEFAULT_CONFIG,
  findCircularGroupReferences,
  ConfigErrorCategory,
} from "../src/config"
import { createUniqueTempDir, TempCleaner } from "./test-helpers"
import yaml from "yaml"

describe("Computer Group", () => {
  const tempCleaner = TempCleaner.getInstance()
  let tempDir: string
  let configPath: string

  beforeEach(async () => {
    tempDir = createUniqueTempDir()
    tempCleaner.add(tempDir)
    await mkdir(tempDir, { recursive: true })
    configPath = path.join(tempDir, ".ccsync.yaml")
  })

  afterEach(async () => {
    await tempCleaner.cleanDir(tempDir)
  })

  async function writeConfig(
    configChanges: Partial<typeof DEFAULT_CONFIG> = {}
  ) {
    const config = { ...DEFAULT_CONFIG, ...configChanges }
    await writeFile(configPath, yaml.stringify(config))
  }

  test("detects direct circular references", () => {
    const groups = {
      servers: {
        name: "Servers",
        computers: ["1", "2", "clients"],
      },
      clients: {
        name: "Clients",
        computers: ["3", "4", "servers"],
      },
    }

    const result = findCircularGroupReferences(groups)
    expect(result.length).toBeGreaterThan(0)
    expect(result).toContain("servers")
    expect(result).toContain("clients")
  })

  test("detects indirect circular references", () => {
    const groups = {
      webservers: {
        name: "Web Servers",
        computers: ["1", "2", "databases"],
      },
      databases: {
        name: "Database Servers",
        computers: ["3", "4", "monitors"],
      },
      monitors: {
        name: "Monitoring Servers",
        computers: ["5", "6", "webservers"],
      },
    }

    const result = findCircularGroupReferences(groups)
    expect(result.length).toBeGreaterThan(0)
    expect(result.length).toBe(3) // All three groups in the cycle
  })

  test("returns empty array for no circular references", () => {
    const groups = {
      webservers: {
        name: "Web Servers",
        computers: ["1", "2", "databases"],
      },
      databases: {
        name: "Database Servers",
        computers: ["3", "4"],
      },
      monitors: {
        name: "Monitoring Servers",
        computers: ["5", "6"],
      },
    }

    const result = findCircularGroupReferences(groups)
    expect(result.length).toBe(0)
  })

  test("handles groups with numeric IDs correctly", () => {
    // This test ensures that computer IDs that look like numbers
    // don't cause false positives
    const groups = {
      "1": {
        name: "Group 1",
        computers: ["1", "2", "3"],
      },
      "2": {
        name: "Group 2",
        computers: ["4", "5", "1"], // References computer ID "1", not group "1"
      },
    }

    const result = findCircularGroupReferences(groups)
    expect(result.length).toBe(0)
  })

  test("config validation detects circular references", async () => {
    // Create a config with circular references
    await writeConfig({
      computerGroups: {
        servers: {
          name: "Servers",
          computers: ["1", "2", "clients"],
        },
        clients: {
          name: "Clients",
          computers: ["3", "4", "servers"],
        },
      },
    })

    const { errors } = await loadConfig(configPath, {
      skipPathValidation: true,
    })

    expect(errors.length).toBeGreaterThan(0)
    // Find the specific error
    const circularRefError = errors.find(
      (e) =>
        e.category === ConfigErrorCategory.COMPUTER &&
        e.message.includes("Circular references")
    )

    expect(circularRefError).toBeDefined()
    expect(circularRefError?.suggestion).toContain("Remove circular references")
  })
})
```


## tests/integration.test.ts

```ts
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
} from "./test-helpers"
import { stringify } from "yaml"
import { SyncEvent, type SyncResult } from "../src/types"

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

    const watchController = await syncManager.startWatchMode()
    try {
      await new Promise<void>((resolve, reject) => {
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
          reject(error)
        })
      })
    } finally {
      await syncManager.stop()
    }
  })
})
```


## src/errors.ts

```ts
interface NodeError extends Error {
  code?: string
  stack?: string
}

export const getErrorMessage = (error: unknown) => {
  return error instanceof Error ? error.message : String(Error)
}

/**
 * Node.js errors includes properties such as 'code', but TypeScript's base Error type doesn't know about it. Can use this type guard t
 * @param error
 * @returns
 */
export const isNodeError = (error: unknown): error is NodeError => {
  return error instanceof Error && "code" in error
}
```


## src/utils.ts

```ts
import { homedir } from "os"
import * as fs from "node:fs/promises"
import path from "path"
import type { Config } from "./config"
import { glob } from "glob"
import type {
  Computer,
  ResolvedFileRule,
  ValidationResult as ResolveSyncRulesResult,
} from "./types"
import { isNodeError } from "./errors"

// ---- Language ----
export const pluralize = (text: string) => {
  return (count: number) => {
    const isPlural = Math.abs(count) !== 1
    return isPlural ? `${text}s` : text
  }
}

// ---- Date ----
export const getFormattedDate = (): string => {
  const now = new Date()
  const time = now.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  })
  const date = now.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "2-digit",
  })
  return `${time} on ${date}`
}

// ---- Paths ----
export function resolvePath(filePath: string): string {
  // Handle home directory expansion
  if (filePath.startsWith("~")) {
    return path.join(homedir(), filePath.slice(1))
  }
  return path.resolve(filePath)
}

export const toTildePath = (fullPath: string): string => {
  const home = homedir()
  return fullPath.startsWith(home) ? fullPath.replace(home, "~") : fullPath
}

export const pathIsLikelyFile = (pathStr: string): boolean => {
  // Normalize first
  const normalizedPath = normalizePath(pathStr)

  // If it has a trailing slash, it's definitely a directory
  if (normalizedPath.endsWith("/")) {
    return false
  }

  // Get the last segment of the path (after last slash or full path if no slash)
  const lastSegment = normalizedPath.split("/").pop() || normalizedPath

  // If it has a file extension, it's likely a file
  if (lastSegment.includes(".") && !lastSegment.startsWith(".")) {
    return true
  }

  // we assume it's a directory (safer default for copying)
  return false
}

/**
 * Normalizes a file path to use forward slashes and handles trailing slashes consistently.
 *
 * @param filepath The path to normalize
 * @param stripTrailing Whether to remove trailing slash (default: true)
 * @returns Normalized path
 */
export const normalizePath = (
  filepath: string,
  stripTrailing = true
): string => {
  if (typeof filepath !== "string") {
    throw new TypeError("Path must be a string")
  }

  // Handle empty path
  if (!filepath) return ""

  // Special cases
  if (filepath === "\\" || filepath === "/") return "/"
  if (filepath === ".") return "."
  if (filepath === "..") return ".."

  // Normalize using Node's path.normalize first (handles . and ..)
  let normalized = path.normalize(filepath)

  // Handle Windows drive letters consistently
  const hasWindowsDrive = /^[A-Z]:/i.test(normalized)

  // Convert all backslashes to forward slashes
  normalized = normalized.replace(/\\/g, "/")

  // Strip ./ from the beginning if present
  if (normalized.startsWith("./")) {
    normalized = normalized.substring(2)
  }

  // Handle trailing slash based on the path type
  if (stripTrailing) {
    const isDriveRoot = /^[A-Z]:\/$/i.test(normalized)
    const isShareRoot = /^\/\/[^/]+\/[^/]+\/$/.test(normalized)
    const isFileRoot = normalized === "/"
    if (!isDriveRoot && !isShareRoot && !isFileRoot && normalized.length > 1) {
      normalized = normalized.replace(/\/$/, "")
    }
  }

  // Restore Windows drive letter if present
  if (hasWindowsDrive && normalized.length >= 2 && normalized[1] !== ":") {
    normalized = normalized[0] + ":" + normalized.substring(1)
  }

  return normalized
}

/**
 * Compares two paths for equality, accounting for platform differences
 */
export const pathsAreEqual = (path1: string, path2: string): boolean => {
  const norm1 = normalizePath(path1)
  const norm2 = normalizePath(path2)

  // On Windows, paths are case-insensitive
  if (process.platform === "win32") {
    return norm1.toLowerCase() === norm2.toLowerCase()
  }

  return norm1 === norm2
}

/**
 * Ensures a path uses the correct separators for the current OS.
 * Use this when making actual filesystem calls.
 */
export const toSystemPath = (filepath: string): string => {
  return process.platform === "win32" ? filepath.replace(/\//g, "\\") : filepath
}

export const isRecursiveGlob = (pattern: string): boolean => {
  // Match any pattern containing ** which indicates recursion
  const result = pattern.includes("**")
  // console.log("isRecursiveGlob:", { pattern, result })
  return result
}

// - - - - - MINECRAFT - - - - -

interface SaveValidationResult {
  isValid: boolean
  savePath: string
  errors: string[]
  missingFiles: string[]
}

export const validateMinecraftSave = async (
  saveDir: string
): Promise<SaveValidationResult> => {
  const savePath = resolvePath(saveDir)
  const result: SaveValidationResult = {
    isValid: false,
    savePath,
    errors: [],
    missingFiles: [],
  }

  // Key files that should exist in a valid Minecraft save
  const keyFiles = [
    "level.dat",
    "session.lock",
    "region",
    "computercraft/computer", // Required for ComputerCraft
  ]

  try {
    // First check if the directory exists
    try {
      await fs.access(savePath)
    } catch (err) {
      result.errors.push(`Save directory not found: ${savePath}`)
      return result
    }

    // Check each key file/directory
    await Promise.all(
      keyFiles.map(async (kf) => {
        try {
          await fs.access(path.join(savePath, kf))
        } catch (err) {
          result.missingFiles.push(kf)
        }
      })
    )

    // If we have any missing files, add an error
    if (result.missingFiles.length > 0) {
      result.errors.push(
        `The folder at ${savePath} doesn't appear to be a Minecraft save.`
      )
    }

    // Specific check for computercraft directory
    if (!result.missingFiles.includes("computercraft/computer")) {
      try {
        const computercraftStats = await fs.stat(
          path.join(savePath, "computercraft/computer")
        )
        if (!computercraftStats.isDirectory()) {
          result.errors.push("computercraft/computer is not a directory")
        }
      } catch (err) {
        result.errors.push("Failed to check computercraft directory structure")
      }
    }

    // Set isValid if we have no errors
    result.isValid = result.errors.length === 0

    return result
  } catch (err) {
    result.errors.push(
      `Validation failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return result
  }
}

// - - - - - COMPUTERS - - - - -

const EXCLUDED_DIRS = new Set([".vscode", ".git", ".DS_Store"])

export const getComputerShortPath = (saveName: string, computerId: string) => {
  return normalizePath(
    path
      .join(saveName, "computercraft", "computer", computerId)
      .replace("computercraft", "..")
  )
}

export const findMinecraftComputers = async (savePath: string) => {
  try {
    // Build path to computercraft directory
    const computercraftPath = normalizePath(
      path.join(savePath, "computercraft", "computer")
    )

    // Check if directory exists
    try {
      await fs.access(computercraftPath)
    } catch (err) {
      throw new Error(
        `ComputerCraft directory not found at ${computercraftPath}`
      )
    }

    const computers: Computer[] = []

    // Get the save name from the path
    const savePathParts = computercraftPath.split(path.sep)
    const saveIndex = savePathParts.findIndex((part) => part === "saves")
    const saveName = saveIndex !== -1 ? savePathParts[saveIndex + 1] : ""

    // Read all subdirectories
    const entries = await fs.readdir(computercraftPath, {
      withFileTypes: true,
    })

    for (const entry of entries) {
      // Skip if it's not a directory or if it's in the excluded list
      if (!entry.isDirectory() || EXCLUDED_DIRS.has(entry.name)) {
        continue
      }

      const computerPath = path.join(computercraftPath, entry.name)
      const shortPath = getComputerShortPath(saveName, entry.name)

      computers.push({
        id: entry.name,
        path: computerPath,
        shortPath,
      })
    }

    return computers.sort((a, b) => {
      // Sort numerically if both IDs are numbers
      const numA = parseInt(a.id)
      const numB = parseInt(b.id)
      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB
      }
      // Otherwise sort alphabetically
      return a.id.localeCompare(b.id)
    })
  } catch (err) {
    throw new Error(`Failed to discover computers: ${err}`)
  }
}

// - - - - - Files - - - - -

/**
 * Resolves computer references into a flat array of computer IDs, recursively expanding group references.
 *
 * This function handles:
 * - Exact computer IDs (e.g., "1", "2")
 * - Group references that contain computer IDs
 * - Nested group references
 * - Circular references (safely avoided)
 *
 * @example
 * // Config with nested groups
 * const config = {
 *   computerGroups: {
 *     monitors: { name: "Monitors", computers: ["1", "2"] },
 *     servers: { name: "Servers", computers: ["3", "monitors"] }
 *   }
 * };
 *
 * // Returns { resolvedIds: ["3", "1", "2"], errors: [] }
 * resolveComputerReferences("servers", config);
 *
 * // Returns { resolvedIds: ["5", "3", "1", "2"], errors: [] }
 * resolveComputerReferences(["5", "servers"], config);
 *
 * // Returns { resolvedIds: [], errors: ["invalid computer groups → \"unknown\""] }
 * resolveComputerReferences("unknown", config);
 *
 * @param computers - Single computer ID, group name, or array of computer IDs and group names
 * @param config - The full config object containing computerGroups definitions
 * @returns Object containing resolved IDs and any errors encountered
 */
export function resolveComputerReferences(
  computers: string | string[] | undefined,
  config: Config
): { resolvedIds: string[]; errors: string[] } {
  if (!computers) return { resolvedIds: [], errors: [] }

  const computersList = Array.isArray(computers) ? computers : [computers]
  const resolvedIds = new Set<string>() // Use a set to avoid duplicates
  const processedGroups = new Set<string>() // track processed groups to avoid infinite recursion
  const invalidGroups: string[] = [] // Track invalid group references

  // Helper to recursively resolve group references
  function resolveGroup(groupName: string) {
    // Skip if already processed to prevent infinite loops
    if (processedGroups.has(groupName)) return

    const group = config.computerGroups?.[groupName]
    if (!group) return

    processedGroups.add(groupName)

    for (const computer of group.computers) {
      if (!isNaN(Number(computer))) {
        // It's a computer ID
        resolvedIds.add(computer)
      } else if (config.computerGroups?.[computer]) {
        // It's a group reference
        resolveGroup(computer)
      } else {
        // It's an invalid reference - track it
        invalidGroups.push(computer)
      }
    }
  }

  // Process each entry
  for (const entry of computersList) {
    if (config.computerGroups?.[entry]) {
      // It's a group name, resolve it
      resolveGroup(entry)
    } else if (!isNaN(Number(entry))) {
      // It's a valid computer ID
      resolvedIds.add(entry)
    } else {
      // It's neither a valid group nor a numeric ID
      invalidGroups.push(entry)
    }
  }

  const result = {
    resolvedIds: Array.from(resolvedIds),
    errors: [] as string[],
  }

  // Only add error if we found invalid groups
  if (invalidGroups.length > 0) {
    result.errors.push(
      `Invalid computer groups → "${[...new Set(invalidGroups)].join(", ")}"`
    )
  }

  return result
}

/**
 * Using the config file, will resolve sync rules into viable files ({@link ResolvedFileRule}) and their available or missing computers that are intended targets.
 *
 * For each sync rule, this function will first find all source files that match the `rule.source` pattern/glob. If `selectedFiles` parameter is passed, i.e. from files changed during watch mode, only these files--rather than all of the rule's matched files--will be resolved. Next, all computer ID's will be resolved for this rule--expanding computer groups into a distinct set of comptuer ID's. Finally a {@link ResolveSyncRulesResult} is returned.
 */
export async function resolveSyncRules(
  config: Config,
  computers: Computer[],
  selectedFiles?: Set<string>
): Promise<ResolveSyncRulesResult> {
  const resolvedResult: ResolveSyncRulesResult = {
    resolvedFileRules: [],
    availableComputers: [],
    missingComputerIds: [],
    errors: [],
  }

  const normalizedSourceRoot = normalizePath(config.sourceRoot)

  // Process each sync rule
  for (const rule of config.rules) {
    try {
      // Find all matching source files
      const sourceFiles = (
        await glob(rule.source, {
          cwd: normalizedSourceRoot,
          absolute: true,
        })
      ).map((sf) => normalizePath(sf))

      // Filter by changed files if in watch mode
      const filesToResolve = selectedFiles
        ? sourceFiles.filter((file) => {
            const relPath = normalizePath(
              path.relative(config.sourceRoot, file)
            )
            return Array.from(selectedFiles).some(
              (changed) => normalizePath(changed) === relPath
            )
          })
        : sourceFiles

      if (filesToResolve.length === 0) {
        resolvedResult.errors.push(
          `No matching files found for: '${toSystemPath(rule.source)}'`
        )
        continue
      }

      // Resolve computer IDs for this rule
      const { resolvedIds: computerIds, errors } = resolveComputerReferences(
        rule.computers,
        config
      )

      if (errors.length > 0) {
        errors.forEach((e) => {
          resolvedResult.errors.push(e)
        })
        // allow continued processing even if we didnt fully resolve all computer references
      }

      if (computerIds.length === 0) {
        resolvedResult.errors.push(
          `No target computers specified for: '${toSystemPath(rule.source)}'`
        )
        continue
      }

      const missingIds = computerIds.filter(
        (id) => !computers.some((c) => c.id === id)
      )
      resolvedResult.missingComputerIds.push(...missingIds)

      // Create resolved file entries
      for (const sourcePath of filesToResolve) {
        const normalizedTargetPath = normalizePath(rule.target)
        const isDirectory = !pathIsLikelyFile(normalizedTargetPath)

        resolvedResult.resolvedFileRules.push({
          sourceAbsolutePath: normalizePath(sourcePath),
          // Calculated relative to sourceRoot
          sourceRelativePath: normalizePath(
            path.relative(config.sourceRoot, sourcePath)
          ),
          flatten: !isRecursiveGlob(rule.source) || rule.flatten,
          target: {
            type: isDirectory ? "directory" : "file",
            path: normalizedTargetPath,
          },
          computers: computerIds,
        })
      }

      // Track target computers
      const matchingComputers = computers.filter((c) =>
        computerIds.includes(c.id)
      )
      resolvedResult.availableComputers.push(...matchingComputers)
    } catch (err) {
      // Handle the main errors glob can throw
      if (isNodeError(err)) {
        switch (err.code) {
          case "ENOENT":
            resolvedResult.errors.push(
              `Source directory not found: ${toSystemPath(config.sourceRoot)}`
            )
            break
          case "EACCES":
            resolvedResult.errors.push(
              `Permission denied reading source directory: ${toSystemPath(config.sourceRoot)}`
            )
            break
          case "EMFILE":
            resolvedResult.errors.push(
              "Too many open files. Try reducing the number of glob patterns."
            )
            break
          default:
            resolvedResult.errors.push(
              `Error processing '${toSystemPath(rule.source)}': ${err.message}`
            )
        }
      } else {
        // Handle glob pattern/config errors
        resolvedResult.errors.push(
          `Invalid pattern '${toSystemPath(rule.source)}': ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  }

  // Deduplicate target computers
  resolvedResult.availableComputers = [
    ...new Set(resolvedResult.availableComputers),
  ]

  return resolvedResult
}

/**
 * Copies files to a specific computer
 */
export async function copyFilesToComputer(
  resolvedFileRules: ResolvedFileRule[],
  computerPath: string
) {
  const copiedFiles = []
  const skippedFiles = []
  const errors = []

  // DEBUG
  // console.log("\n=== Starting copyFilesToComputer ===")
  // console.log("Computer path:", computerPath)
  // console.log("Number of files to process:", resolvedFiles.length)

  // Normalize the computer path
  const normalizedComputerPath = normalizePath(computerPath)

  for (const rule of resolvedFileRules) {
    // DEBUG
    // console.log("\n--- Processing file ---")
    // console.log("Source absolute path:", file.sourceAbsolutePath)
    // console.log("Source relative path:", file.sourceRelativePath)
    // console.log("Flatten?", file.flatten)
    // console.log("Target path:", file.targetPath)

    const isTargetDirectory = rule.target.type === "directory"
    const normalizedTargetPath = normalizePath(rule.target.path)

    // console.log({ normalizedTargetPath, isTargetDirectory })

    // For directory targets, maintain source directory structure
    let targetDirPath: string
    let targetFileName: string

    if (isTargetDirectory) {
      if (rule.flatten) {
        targetDirPath = path.join(computerPath, normalizedTargetPath)
      } else {
        const sourceDir = path.dirname(rule.sourceRelativePath)
        targetDirPath =
          sourceDir === "."
            ? path.join(computerPath, normalizedTargetPath)
            : path.join(computerPath, normalizedTargetPath, sourceDir)
        // console.log("Keeping source dir structure on copy:", {
        //   sourceDir,
        //   targetDirPath,
        // })
      }
      targetFileName = path.basename(rule.sourceRelativePath)
    } else {
      // For file targets, use specified path
      targetDirPath = path.join(
        computerPath,
        path.dirname(normalizedTargetPath)
      )
      targetFileName = path.basename(normalizedTargetPath)
    }

    // Construct and normalize the full target path
    const targetFilePath = normalizePath(
      path.join(targetDirPath, targetFileName)
    )

    // console.log("Target file path: ", targetFilePath)

    // Security check: Ensure the target path stays within the computer directory
    const relativeToComputer = path.relative(
      normalizedComputerPath,
      targetFilePath
    )

    if (
      normalizePath(relativeToComputer).startsWith("..") ||
      path.isAbsolute(relativeToComputer)
    ) {
      skippedFiles.push(rule.sourceAbsolutePath)
      errors.push(
        `Security violation: Target path '${toSystemPath(rule.target.path)}' attempts to write outside the computer directory`
      )
      continue
    }

    // First ensure source file exists and is a file
    const sourceStats = await fs.stat(toSystemPath(rule.sourceAbsolutePath)) // use systemm-specific path here
    if (!sourceStats.isFile()) {
      skippedFiles.push(rule.sourceAbsolutePath)
      errors.push(
        `Source is not a file: ${toSystemPath(rule.sourceAbsolutePath)}`
      )
      continue
    }

    // Check if target directory exists and is actually a directory
    try {
      const targetDirStats = await fs.stat(toSystemPath(targetDirPath))
      if (!targetDirStats.isDirectory()) {
        skippedFiles.push(rule.sourceAbsolutePath)
        errors.push(
          `Cannot create directory '${toSystemPath(path.basename(targetDirPath))}' because a file with that name already exists`
        )
        continue
      }
    } catch (err) {
      // Directory doesn't exist, create it
      try {
        await fs.mkdir(toSystemPath(targetDirPath), { recursive: true })
      } catch (mkdirErr) {
        skippedFiles.push(rule.sourceAbsolutePath)
        errors.push(`Failed to create directory: ${mkdirErr}`)
        continue
      }
    }

    try {
      // Copy the file using system-specific paths for fs operations
      await fs.copyFile(
        toSystemPath(rule.sourceAbsolutePath),
        toSystemPath(targetFilePath)
      )

      // Verify the copy
      const targetStats = await fs.stat(toSystemPath(targetFilePath))
      if (!targetStats.isFile()) {
        throw new Error(
          `Failed to create target file: ${toSystemPath(targetFilePath)}`
        )
      } else {
        copiedFiles.push(rule.sourceAbsolutePath)
      }
    } catch (err) {
      skippedFiles.push(rule.sourceAbsolutePath)

      if (isNodeError(err)) {
        if (err.code === "ENOENT") {
          errors.push(
            `Source file not found: ${toSystemPath(rule.sourceAbsolutePath)}`
          )
        } else if (err.code === "EACCES") {
          errors.push(`Permission denied: ${err.message}`)
        } else if (err.code === "EISDIR") {
          errors.push(
            `Cannot copy to '${toSystemPath(targetFilePath)}': Is a directory`
          )
        } else if (err.code === "EBUSY") {
          errors.push(
            `File is locked or in use: ${toSystemPath(targetFilePath)}`
          )
        } else {
          errors.push(err instanceof Error ? err.message : String(err))
        }
      } else {
        errors.push(err instanceof Error ? err.message : String(err))
      }

      continue
    }
  }
  return {
    copiedFiles,
    skippedFiles,
    errors,
  }
}
```


## src/types.ts

```ts
import { EventEmitter } from "node:events"

export enum SyncMode {
  MANUAL = "manual",
  WATCH = "watch",
}

// // Base interface for file sync configuration in .ccsync.yaml
// export interface SyncRule {
//   source: string // Glob pattern relative to sourceRoot
//   target: string // Target path on computer
//   computers?: string[] // Array of computer IDs or group names
// }

/**
 * Represents a viable file resolved from a config sync rule.
 *
 * A resolved file rule has been validated such that a file exists at the source path.
 */
export interface ResolvedFileRule {
  /**
   * Absolute path to source file
   */
  sourceAbsolutePath: string
  /**
   * Relative path to source file from source root
   */
  sourceRelativePath: string
  /**
   * This flag will dictate _how_ the source files are copied to the target. If _false_ **and** a _recursive glob pattern_ is used for `source`, then the files will be copied to the target directory maintaining their source directory structure. The default is _true_, in which source files are copied to a single target directory.
   */
  flatten?: boolean
  /**
   * Explicit target structure defining where files should be copied
   */
  target: {
    /**
     * Type of target destination - either a directory or specific file
     */
    type: TargetType
    /**
     * Normalized path (without trailing slash for directories)
     */
    path: string
  }
  /**
   * Resolved list of computer IDs (not group names)
   */
  computers: string[]
}

// Represents a computer in the Minecraft save
export interface Computer {
  id: string
  path: string
  shortPath: string
}

/**
 * A SyncValidation is the result returned when the rules in the config files are validated against what's actually present in the file system.
 */
export interface ValidationResult {
  /**
   * An array of {@link ResolvedFileRule}'s
   */
  resolvedFileRules: ResolvedFileRule[]
  availableComputers: Computer[]
  missingComputerIds: string[]
  errors: string[]
}

export interface SyncResult {
  successCount: number
  errorCount: number
  missingCount: number
}

export interface SyncErrorEventData {
  error: Error // The actual error
  fatal: boolean // Whether this error should stop operations
  source?: string // Optional: where the error occurred (e.g. 'validation', 'sync', 'watcher')
}

export enum SyncEvent {
  STARTED,
  STOPPED,
  SYNC_VALIDATION,
  SYNC_COMPLETE,
  SYNC_ERROR,
  INITIAL_SYNC_COMPLETE,
  INITIAL_SYNC_ERROR,
  FILE_SYNC,
  FILE_SYNC_ERROR,
  WATCHER_ERROR,
}

type CommonSyncEvents = {
  [SyncEvent.STARTED]: void
  [SyncEvent.SYNC_VALIDATION]: ValidationResult
  [SyncEvent.SYNC_COMPLETE]: SyncResult
  [SyncEvent.SYNC_ERROR]: SyncErrorEventData
  [SyncEvent.STOPPED]: void
}

// Event maps for each mode type
export type ManualSyncEvents = CommonSyncEvents

export type WatchSyncEvents = {
  [SyncEvent.INITIAL_SYNC_COMPLETE]: SyncResult
} & CommonSyncEvents

// Type-safe event emitter factory
export function createTypedEmitter<T extends Record<string, any>>() {
  const emitter = new EventEmitter()
  return {
    emit<K extends keyof T>(
      event: K,
      data?: T[K] extends void ? void : T[K]
    ): boolean {
      return emitter.emit(event as string, data)
    },
    on<K extends keyof T>(
      event: K,
      listener: T[K] extends void ? () => void : (data: T[K]) => void
    ): void {
      emitter.on(event as string, listener)
    },
    once<K extends keyof T>(
      event: K,
      listener: T[K] extends void ? () => void : (data: T[K]) => void
    ): void {
      emitter.once(event as string, listener)
    },
    off<K extends keyof T>(
      event: K,
      listener: T[K] extends void ? () => void : (data: T[K]) => void
    ): void {
      emitter.off(event as string, listener)
    },
  }
}

export type TargetType = "directory" | "file"

/**
 * Represents a sync result for a specific computer
 * Used for UI display
 */
export interface ComputerSyncResult {
  computerId: string
  exists: boolean
  files: Array<{
    // Store full target path for UI display
    targetPath: string
    targetType: TargetType
    // Include source path for potential filename resolution
    sourcePath: string
    success: boolean
  }>
}
```


## src/keys.ts

```ts
type KeyCallback = () => void | Promise<void>

interface KeyHandlerOptions {
  onEsc?: KeyCallback
  onSpace?: KeyCallback
  onCtrlC?: KeyCallback
}

export class KeyHandler {
  private isActive = false
  private keyCallbacks: KeyHandlerOptions
  private currentHandler: ((data: Buffer) => void) | null = null
  private keepAliveInterval: Timer | null = null

  constructor(options: KeyHandlerOptions = {}) {
    this.keyCallbacks = options

    // Default Ctrl+C handler if none provided
    if (!this.keyCallbacks.onCtrlC) {
      this.keyCallbacks.onCtrlC = () => {
        console.log("Terminated")
        process.exit(0)
      }
    }
  }

  start() {
    if (this.isActive) return

    try {
      this.isActive = true

      // Ensure clean state
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false)
      }
      process.stdin.pause()

      // Setup stdin
      process.stdin.setEncoding("utf8")
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true)
      }
      process.stdin.resume()

      // Bind the handler
      this.currentHandler = this.handleKeypress.bind(this)
      process.stdin.removeAllListeners("data") // Remove any existing listeners
      process.stdin.on("data", this.currentHandler)

      // Keep-alive interval
      if (this.keepAliveInterval) {
        clearInterval(this.keepAliveInterval)
      }
      this.keepAliveInterval = setInterval(() => {
        if (this.isActive && process.stdin.isTTY) {
          process.stdin.resume()
          process.stdin.setRawMode(true)
        } else {
          this.stop()
        }
      }, 100)
    } catch (err) {
      console.error("Error starting key handler:", err)
      this.stop()
    }
  }

  stop() {
    if (!this.isActive) return

    try {
      this.isActive = false

      if (this.keepAliveInterval) {
        clearInterval(this.keepAliveInterval)
        this.keepAliveInterval = null
      }

      if (this.currentHandler) {
        process.stdin.removeListener("data", this.currentHandler)
        this.currentHandler = null
      }

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false)
      }
      process.stdin.pause()
    } catch (err) {
      console.error("Error stopping key handler:", err)
    }
  }

  private async handleKeypress(data: Buffer) {
    if (!this.isActive) return

    const key = data.toString()

    // Handle Ctrl+C (End of Text character)
    if (key === "\u0003" && this.keyCallbacks.onCtrlC) {
      await this.keyCallbacks.onCtrlC()
      return
    }

    // Handle ESC
    if (key === "\u001b" && this.keyCallbacks.onEsc) {
      await this.keyCallbacks.onEsc()
      return
    }

    // Handle Space
    if (key === " " && this.keyCallbacks.onSpace) {
      await this.keyCallbacks.onSpace()
    }
  }

  isListening() {
    return this.isActive
  }
}
```


## src/ui.ts

```ts
import { setInterval, clearInterval, setTimeout } from "node:timers"

import logUpdate from "log-update"
import figures from "figures"
import chalk from "chalk"
import type { ComputerSyncResult } from "./types"
import boxen from "boxen"
import { pluralize } from "./utils"

const theme = {
  primary: chalk.hex("#61AFEF"), // Bright blue
  secondary: chalk.hex("#98C379"), // Green
  highlight: chalk.hex("#C678DD"), // Purple
  warning: chalk.hex("#E5C07B"), // Yellow
  error: chalk.hex("#E06C75"), // Red
  dim: chalk.hex("#5C6370"), // Gray
  info: chalk.hex("#56B6C2"), // Cyan
  success: chalk.hex("#98C379"), // Green
  border: chalk.hex("#61AFEF"), // Blue borders
  normal: chalk.hex("#ABB2BF"), // Light gray for regular text
  subtle: chalk.hex("#4B5363"), // Darker gray for backgrounds
  bold: chalk.bold,
  heading: (str: string) => chalk.hex("#61AFEF").bold(str),
  keyHint: (str: string) => chalk.bgHex("#5C6370").hex("#FFFFFF")(` ${str} `),
}

// Symbols
const symbols = {
  check: figures.tick,
  cross: figures.cross,
  warning: figures.warning,
  info: figures.info,
  bullet: figures.bullet,
  pointer: figures.pointer,
  line: figures.line,
  ellipsis: figures.ellipsis,
}

interface CounterStats {
  success: number
  error: number
  missing: number
  total: number
}

interface UIState {
  mode: "watch" | "manual"
  status: "idle" | "running" | "success" | "error" | "partial"
  stats: CounterStats
  computerResults: ComputerSyncResult[]
  lastUpdated: Date
  message?: string
}

// Minimal interval between renders (ms)
const MIN_RENDER_INTERVAL = 50

export class UI {
  private state: UIState
  private timer: ReturnType<typeof setInterval> | null = null
  private isActive = false
  private sourceRoot: string
  private isRendering = false // lock to prevent concurrent renders
  private lastRenderTime = 0 // Timestamp of last render
  private renderTimer: ReturnType<typeof setTimeout> | null = null // Timer for debounced rendering
  private pendingStateUpdates: Partial<UIState> = {}
  private hasPendingUpdates = false
  private syncsComplete = 0

  // Add a class property to track the spinner animation
  private spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  private spinnerIndex = 0

  constructor(sourceRoot: string, mode: "watch" | "manual") {
    // super();
    this.sourceRoot = sourceRoot
    this.state = {
      mode,
      status: "idle",
      stats: { success: 0, error: 0, missing: 0, total: 0 },
      computerResults: [],
      lastUpdated: new Date(),
    }

    this.setupTerminationHandlers()
  }

  private setupTerminationHandlers(): void {
    const cleanup = () => {
      this.stop()
    }
    // These will be automatically removed when the process exits
    process.on("SIGINT", cleanup)
    process.on("SIGTERM", cleanup)
    process.on("exit", cleanup)
  }

  // Clear the entire screen
  private clearScreen() {
    console.clear()
  }

  start(): void {
    // Clear any existing UI state
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    this.isActive = true
    this.isRendering = false
    this.hasPendingUpdates = false
    this.pendingStateUpdates = {}
    this.syncsComplete = 0
    this.spinnerIndex = 0

    this.clearScreen()

    // Start a refresh timer to update elapsed time and spinner
    this.timer = setInterval(() => {
      if (this.isActive) {
        // Update spinner index
        this.spinnerIndex = (this.spinnerIndex + 1) % this.spinnerFrames.length
        this.renderDynamicElements()
      }
    }, 100)

    console.log(
      theme.primary(
        `\nCC: Sync - ${this.state.mode.toUpperCase()} mode started at ${this.state.lastUpdated.toLocaleString()}`
      )
    )
    console.log(theme.primary("─".repeat(process.stdout.columns || 80)) + "\n")

    // Initial render of dynamic elements
    this.renderDynamicElements()
  }

  stop(): void {
    this.isActive = false
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    if (this.renderTimer) {
      clearTimeout(this.renderTimer)
      this.renderTimer = null
    }

    // Final clear of dynamic elements
    logUpdate.clear()
    logUpdate.done()
  }

  // Replace the existing updateStatus method
  updateStatus(status: UIState["status"], message?: string): void {
    const prevStatus = this.state.status

    // When status changes from "running" to a completion state
    if (
      prevStatus === "running" &&
      (status === "success" || status === "error" || status === "partial")
    ) {
      // First clear any dynamic content
      logUpdate.clear()

      // Then update the state
      this.state = {
        ...this.state,
        status,
        message: message !== undefined ? message : this.state.message,
        lastUpdated: new Date(),
      }

      // Log the static output
      this.logSyncSummary()

      // After logging static content, re-render dynamic elements
      this.renderDynamicElements()
      this.syncsComplete++
    } else {
      // For other status changes (including to "running"), use normal state updates
      this.queueStateUpdate({
        status,
        message: message !== undefined ? message : this.state.message,
        lastUpdated: new Date(),
      })
    }
  }

  updateStats(stats: Partial<CounterStats>): void {
    const updatedStats = {
      ...this.state.stats,
      ...stats,
    }

    updatedStats.total =
      (stats.success || this.state.stats.success) +
      (stats.error || this.state.stats.error) +
      (stats.missing || this.state.stats.missing)

    this.queueStateUpdate({ stats: updatedStats })
  }

  updateComputerResults(computerResults: ComputerSyncResult[]): void {
    this.queueStateUpdate({
      computerResults,
      lastUpdated: new Date(),
    })
  }

  clear(): void {
    logUpdate.clear()
  }

  private getStatusColor() {
    switch (this.state.status) {
      case "success":
        return theme.success
      case "error":
        return theme.error
      case "partial":
        return theme.warning
      case "running":
        return theme.info
      default:
        return theme.normal
    }
  }

  private getStatusSymbol(): string {
    switch (this.state.status) {
      case "success":
        return symbols.check
      case "error":
        return symbols.cross
      case "partial":
        return symbols.warning
      case "running":
        return symbols.line
      default:
        return symbols.info
    }
  }

  private formatElapsedTime(): string {
    const elapsed =
      (new Date().getTime() - this.state.lastUpdated.getTime()) / 1000
    if (elapsed < 60) return `${Math.floor(elapsed)}s ago`
    if (elapsed < 3600)
      return `${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s ago`
    return `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m ago`
  }

  private renderHeaderLine(): string {
    const { success, error, missing, total } = this.state.stats

    const date = this.state.lastUpdated.toLocaleString()

    let resultStats = ""

    if (success > 0 && error === 0 && missing === 0) {
      resultStats = `${theme.success(`Success.`)}`
    } else {
      resultStats =
        `${theme.success(`Success: ${success}`)} ` +
        `${error > 0 ? theme.error(`Error: ${error}`) : ""} ` +
        (missing > 0 ? `${theme.warning(`Missing: ${missing}`)}` : "")
    }

    return theme.bold(
      `#${this.syncsComplete + 1} [${this.state.mode.toUpperCase()}] [${date}] [Attempted to sync to ${total} ${pluralize("computer")(total)}] ` +
        resultStats
    )
  }

  private renderComputerResults(): string {
    if (this.state.computerResults.length === 0) {
      return theme.dim("  No files synced yet.")
    }

    // Sort computers numerically if possible
    const sortedComputers = [...this.state.computerResults].sort((a, b) => {
      const numA = parseInt(a.computerId, 10)
      const numB = parseInt(b.computerId, 10)

      if (!isNaN(numA) && !isNaN(numB)) {
        return numA - numB
      }
      return a.computerId.localeCompare(b.computerId)
    })

    let output = ""

    // Generate output for each computer
    for (const computer of sortedComputers) {
      // Determine computer status icon
      let statusIcon
      let statusColor

      if (!computer.exists) {
        statusIcon = symbols.cross
        statusColor = theme.error
      } else if (computer.files.length === 0) {
        statusIcon = symbols.warning
        statusColor = theme.warning
      } else {
        const allSuccess = computer.files.every((f) => f.success)
        const anySuccess = computer.files.some((f) => f.success)

        if (allSuccess) {
          statusIcon = symbols.check
          statusColor = theme.success
        } else if (anySuccess) {
          statusIcon = symbols.warning
          statusColor = theme.warning
        } else {
          statusIcon = symbols.cross
          statusColor = theme.error
        }
      }

      // Start line with status icon and computer ID
      output += `  ${statusColor(statusIcon)} Computer ${computer.computerId}: `

      // Summarize success/fail counts
      const successCount = computer.files.filter((f) => f.success).length
      const totalCount = computer.files.length
      output += theme.dim(`(${successCount}/${totalCount}) `)

      if (!computer.exists) {
        output += theme.warning("Missing computer")
        continue
      }

      if (computer.files.length === 0) {
        output += theme.dim("No files synced")
        continue
      }

      // Format file targets on same line
      const fileTargets = computer.files.map((file) => {
        const fileIcon = file.success ? symbols.check : symbols.cross
        const iconColor = file.success ? theme.success : theme.error

        // Just use the targetPath directly since it's already been properly
        // formatted in performSync to include the filename for directory targets
        const displayPath =
          file.targetPath === "/" ? "/<error>" : file.targetPath

        return `${iconColor(fileIcon)} ${file.success ? displayPath : theme.dim(displayPath)}`
      })

      output += fileTargets.join(" | ") + "\n"
    }

    return output
  }
  private getStatusMessage(): string {
    // Use custom message if available, otherwise default based on status
    const message = this.state.message || this.getDefaultStatusMessage()

    const messageColor =
      this.state.status === "error"
        ? theme.error
        : this.state.status === "partial"
          ? theme.warning
          : this.state.status === "success"
            ? theme.success
            : theme.info

    return this.state.status !== "success"
      ? messageColor("\n" + "  " + message)
      : ""
  }

  private getDefaultStatusMessage(): string {
    switch (this.state.status) {
      case "success":
        return "Sync completed successfully."
      case "error":
        return "Sync failed. No computers were updated."
      case "partial":
        return "Not all files were synced. See above output."
      case "running":
        return "Sync in progress..."
      default:
        return "Waiting to sync..."
    }
  }

  private renderControls(title = "Controls"): string {
    const controls = [
      { key: "SPACE", desc: "Re-sync", mode: "manual" },
      { key: "ESC", desc: "Exit" },
    ].filter((c) => !c.mode || c.mode === this.state.mode)

    // Add spinner to title
    const spinner = this.spinnerFrames[this.spinnerIndex]
    const titleWithSpinner = `${spinner} ${title}`

    if (this.state.status === "running") {
      return ""
    }

    return boxen(
      controls
        .map((c) => `${theme.keyHint(c.key)} ${theme.normal(c.desc)}`)
        .join("   "),
      {
        padding: 1,
        margin: { top: 1, left: 1 },
        borderStyle: "round",
        borderColor: "cyan",
        title: titleWithSpinner,
        titleAlignment: "center",
        textAlignment: "center",
      }
    )
  }

  private queueStateUpdate(update: Partial<UIState>): void {
    if (!this.isActive) return

    // Merge the update with any pending updates
    this.pendingStateUpdates = { ...this.pendingStateUpdates, ...update }
    this.hasPendingUpdates = true

    // Queue a render to apply these updates
    this.queueRender()
  }

  private applyPendingUpdates(): void {
    if (!this.hasPendingUpdates) return

    // Apply all pending updates to the state
    this.state = { ...this.state, ...this.pendingStateUpdates }

    // Reset pending updates
    this.pendingStateUpdates = {}
    this.hasPendingUpdates = false
  }

  private queueRender(): void {
    if (!this.isActive) return

    // If already rendering, mark that another render is needed
    if (this.isRendering) {
      return
    }

    // If a render is already queued, don't queue another one
    if (this.renderTimer) return

    // Determine delay before next render
    const now = Date.now()
    const timeSinceLastRender = now - this.lastRenderTime
    const delay = Math.max(0, MIN_RENDER_INTERVAL - timeSinceLastRender)

    // Queue the render with appropriate delay
    this.renderTimer = setTimeout(() => {
      this.renderTimer = null
      this.renderDynamicElements()
    }, delay)
  }

  // This logs the sync results to the console and doesn't use logUpdate
  private logSyncSummary(): void {
    // Force apply any pending updates first
    this.applyPendingUpdates()

    const header = this.renderHeaderLine()
    const computerResults = this.renderComputerResults()
    const statusMessage = this.getStatusMessage()

    // Log the static output
    console.log("\n" + header)
    console.log(computerResults)
    console.log(statusMessage)
    console.log(theme.dim("─".repeat(process.stdout.columns || 80))) // Separator line
  }

  // This renders the dynamic elements that change frequently with logUpdate
  private renderDynamicElements(): void {
    if (!this.isActive) return

    this.isRendering = true

    try {
      // Apply any pending state updates
      this.applyPendingUpdates()

      // Only show status indicator if we're in running state
      const statusIndicator =
        this.state.status === "running" ? `\n${this.getStatusMessage()}` : ""

      const controlsTitle =
        this.state.mode === "manual"
          ? "Awaiting user input..."
          : "Watching for file changes..."

      // Render controls and status
      logUpdate(statusIndicator + this.renderControls(controlsTitle))

      this.lastRenderTime = Date.now()
    } catch (error) {
      console.error("UI rendering error:", error)
    } finally {
      this.isRendering = false
    }
  }
}
```


## src/log.ts

```ts
import * as p from "@clack/prompts"
import { theme } from "./theme"

interface LogConfig {
  verbose?: boolean
}

export interface Logger {
  verbose: (msg: string) => void
  info: (msg: string) => void
  step: (msg: string) => void
  success: (msg: string) => void
  warn: (msg: string) => void
  error: (msg: string) => void
  status: (msg: string) => void
}

export const createLogger = (config?: LogConfig): Logger => ({
  verbose: (msg: string) => {
    if (config?.verbose) {
      p.log.info(theme.dim(msg))
    }
  },
  info: (msg: string) => p.log.info(theme.info(msg)),
  step: (msg: string) => p.log.step(theme.info(msg)),
  success: (msg: string) => p.log.success(theme.success(`${msg}`)),
  warn: (msg: string) => p.log.warn(theme.warn(`${msg}`)),
  error: (msg: string) => p.log.error(theme.error(`${msg}`)),
  status: (msg: string) => p.log.info(theme.accent(msg)),
})
```


## src/index.ts

```ts
#!/usr/bin/env node
// index.ts

import * as p from "@clack/prompts"
import {
  ConfigErrorCategory,
  createDefaultConfig,
  findConfig,
  loadConfig,
  type ConfigError,
} from "./config"
import color from "picocolors"
import path from "path"
import { SyncManager } from "./sync"
import { createLogger } from "./log"
import { theme } from "./theme"
import { toTildePath } from "./utils"
import { type SyncMode } from "./types"

const initConfig = async () => {
  // Find all config files
  const configs = await findConfig()

  let configPath: string

  if (configs.length === 0) {
    const createDefault = await p.confirm({
      message: "No configuration file found. Create a default configuration?",
      initialValue: true,
    })

    if (!createDefault) {
      p.cancel("Cannot proceed without configuration.")
      process.exit(0)
    }

    await createDefaultConfig(process.cwd())
    p.log.success(`Created default config at ${process.cwd()}/.ccsync.yaml`)
    p.log.info("Please edit the configuration file and run the program again.")
    process.exit(0)
  } else if (configs.length === 1) {
    configPath = configs[0].path
    // p.log.info(`Using config: ${color.gray(configs[0].relativePath)}`);
  } else {
    // Multiple configs found - let user choose
    const selection = (await p.select({
      message: "Multiple config files found. Select one to use:",
      options: configs.map((config, index) => ({
        value: config.path,
        label: config.relativePath,
        hint: index === 0 ? "closest to current directory" : undefined,
      })),
    })) as string

    if (!selection) {
      p.cancel("No config selected.")
      process.exit(0)
    }

    configPath = selection
  }

  return await loadConfig(configPath)
}

function getErrorCategoryTitle(category: ConfigErrorCategory) {
  switch (category) {
    case ConfigErrorCategory.PATH:
      return "Path Issues"
    case ConfigErrorCategory.RULE:
      return "Sync Rule Issues"
    case ConfigErrorCategory.COMPUTER:
      return "Computer Configuration Issues"
    case ConfigErrorCategory.VERSION:
      return "Version Compatibility Issues"
    default:
      return "Other Issues"
  }
}

const presentConfigErrors = (errors: ConfigError[], isVerbose: boolean) => {
  p.log.error("Configuration errors found:")

  // Group errors by category
  const errorsByCategory: Record<ConfigErrorCategory, ConfigError[]> =
    Object.values(ConfigErrorCategory).reduce(
      (acc, category) => {
        acc[category] = []
        return acc
      },
      {} as Record<ConfigErrorCategory, ConfigError[]>
    )

  // Populate error categories
  errors.forEach((error) => {
    errorsByCategory[error.category].push(error)
  })

  // Display errors with category headers
  Object.entries(errorsByCategory).forEach(([category, categoryErrors]) => {
    if (categoryErrors.length === 0) return

    const title = getErrorCategoryTitle(category as ConfigErrorCategory)
    p.log.error(theme.bold(`${title}:`))

    categoryErrors.forEach((error) => {
      p.log.error(
        `  • ${error.message}${error.suggestion ? "\n    " + theme.dim(error.suggestion) : ""}`
      )

      if (isVerbose && error.verboseDetail) {
        p.log.info(`    ${theme.dim(error.verboseDetail)}`)
      }
    })
  })

  // helpful general guidance at the end
  p.log.info(
    theme.bold("\nGeneral guidance:") +
      "\n  • Edit your .ccsync.yaml file to fix the issues above" +
      "\n  • Run with verbose=true for more detailed error information" +
      "\n  • Refer to documentation at https://github.com/bngarren/ccsync#readme"
  )
  // p.log.info("  • Use 'ccsync --init' to create a fresh config if needed")
}

async function main() {
  console.clear()

  p.intro(`${color.magentaBright(`CC: Sync`)}`)

  try {
    // Get the config file
    const { config, errors } = await initConfig()

    if (errors.length > 0) {
      presentConfigErrors(errors, config?.advanced?.verbose || false)
      p.outro("Please fix these issues and try again.")
      process.exit(0)
    }

    if (!config) {
      p.log.error("No valid configuration found.")
      process.exit(0)
    }

    // Init log
    const log = createLogger({ verbose: config.advanced.verbose })
    const savePath = path.parse(config.minecraftSavePath)

    const gracefulExit = () => {
      p.outro(theme.accent("Goodbye!"))
      process.exit(0)
    }

    // ---- Confirm MC save location ----

    const res = await p.confirm({
      message: `Sync with ${theme.bold(
        theme.warn(savePath.name)
      )}?  ${theme.dim(toTildePath(config.minecraftSavePath))}'`,
      initialValue: true,
    })

    if (p.isCancel(res) || !res) {
      log.info(
        "If this save instance is incorrect, change the 'minecraftSavePath' in the .ccsync.yaml to point to the one you want."
      )
      gracefulExit()
    }

    // Choose mode
    const mode: SyncMode = (await p.select({
      message: "Select sync mode:",
      options: [
        { value: "manual", label: "Manual mode", hint: "Sync on command" },
        {
          value: "watch",
          label: "Watch mode",
          hint: "Auto-sync on file changes",
        },
      ],
    })) as SyncMode

    if (p.isCancel(mode)) {
      gracefulExit()
    }

    const syncManager = new SyncManager(config)

    // Handle process termination signals
    const cleanup = async () => {
      await syncManager.stop()
      gracefulExit()
    }

    process.on("SIGINT", cleanup) // Ctrl+C
    process.on("SIGTERM", cleanup) // Termination request

    if (mode === "manual") {
      await syncManager.startManualMode()
    } else {
      await syncManager.startWatchMode()
    }

    // Keep the process alive until explicitly terminated
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        if (!syncManager.isRunning()) {
          clearInterval(checkInterval)
          resolve()
        }
      }, 500)
    })

    gracefulExit()
  } catch (err) {
    p.log.error(
      `Fatal error: ${err instanceof Error ? err.message : String(err)}`
    )
    process.exit(1)
  }
}

main().catch(console.error)
```


## src/theme.ts

```ts
import color from "picocolors"

export const theme = {
  success: (s: string) => color.green(s),
  warn: (s: string) => color.yellow(s),
  error: (s: string) => color.red(s),
  info: (s: string) => color.cyan(s),
  accent: (s: string) => color.magentaBright(s),
  dim: (s: string) => color.dim(s),
  bold: (s: string) => color.bold(s),
  gray: (s: string) => color.gray(s),
}
```


## src/config.ts

```ts
// config.ts

import { z } from "zod"
import { parse } from "yaml"
import { normalizePath, pathIsLikelyFile, resolvePath } from "./utils"
import path from "path"
import * as fs from "node:fs/promises"

import { merge } from "ts-deepmerge"

export const CONFIG_VERSION = "1.0"
export const DEFAULT_CONFIG_FILENAME = ".ccsync.yaml"
export const DEFAULT_CONFIG: Config = {
  version: CONFIG_VERSION,
  sourceRoot: "./src",
  minecraftSavePath: "~/minecraft/saves/world",
  computerGroups: {},
  rules: [],
  advanced: {
    verbose: false,
    cache_ttl: 5000,
  },
}

export interface LoadConfigResult {
  config: Config | null
  errors: ConfigError[]
}

const hasGlobPattern = (path: string): boolean => {
  return path.includes("*") || path.includes("{") || path.includes("[")
}

/**
 * Checks if a config version is compatible with the CLI version
 * @param configVersion Version from the config file
 * @returns true if compatible, false if not
 */
export function isConfigVersionCompatible(configVersion: string): boolean {
  // For now, just check major version number
  const [configMajor] = configVersion.split(".")
  const [cliMajor] = CONFIG_VERSION.split(".")
  return configMajor === cliMajor
}

// ---- ERROR HANDLING ----

export enum ConfigErrorCategory {
  PATH = "path",
  RULE = "rule",
  COMPUTER = "computer",
  VERSION = "version",
  UNKNOWN = "unknown",
}

// Structured error object with helpful context
export interface ConfigError {
  category: ConfigErrorCategory
  message: string
  verboseDetail?: string // Additional technical details for verbose mode
  path?: string[] // Path to the error in the config object
  suggestion?: string // Actionable guidance
}

const categorizeZodError = (issue: z.ZodIssue): ConfigError => {
  let category = ConfigErrorCategory.UNKNOWN
  let suggestion = ""

  // Path contains the location of the error in the config object
  const path = issue.path

  // Use the path and error code to infer the category
  if (path[0] === "sourceRoot" || path[0] === "minecraftSavePath") {
    category = ConfigErrorCategory.PATH
    suggestion =
      "Ensure the path exists and is accessible. Use absolute paths or ~ for home directory."
  } else if (path[0] === "rules") {
    category = ConfigErrorCategory.RULE

    // Check for specific rule issues
    if (issue.message.includes("glob") || issue.message.includes("target")) {
      suggestion =
        "Check that your target is a directory path when using glob patterns. Directories should end with a slash."
    } else if (issue.message.includes("computer")) {
      suggestion =
        "Make sure all computer IDs or group names referenced in rules actually exist."
    }
  } else if (path[0] === "computerGroups") {
    category = ConfigErrorCategory.COMPUTER
    suggestion =
      "Check that all computer groups have valid names and contain at least one computer ID."
  } else if (path[0] === "version") {
    category = ConfigErrorCategory.VERSION
    suggestion = `Update your config version to ${CONFIG_VERSION} or recreate your config file.`
  }

  // Create structured error object
  return {
    category,
    message: issue.message,
    path: [...String(issue.path)],
    suggestion,
    verboseDetail: `Error code: ${issue.code}, Path: ${path.join(".")}`,
  }
}

// ---- SCHEMA & TYPES ----

// Computer ID validation
const ComputerIdSchema = z.union([
  z
    .string()
    .regex(
      /^(?:0|[1-9]\d*)$/,
      "Computer ID must be a non-negative whole number (e.g. 0, 1, 42)"
    ),
  z
    .number()
    .int("Computer ID must be a whole number (no decimals)")
    .nonnegative("Computer ID must be zero or positive")
    .transform((n) => n.toString()),
])

// Schema that allows computer IDs or group references
const ComputerReferenceSchema = z.union([
  ComputerIdSchema,
  z.string().min(1, "Group reference cannot be empty"),
])

// Computer group schema
const ComputerGroupSchema = z.object({
  name: z.string({
    required_error: "Group name is required",
    invalid_type_error: "Group name must be text",
  }),
  computers: z.array(ComputerReferenceSchema, {
    required_error: "Group must contain computer IDs or group references",
    invalid_type_error: "Computers must be an array of IDs or group names",
  }),
})

// Sync rule schema
const SyncRuleSchema = z.object({
  source: z
    .string({
      required_error: "Source file path is required",
      invalid_type_error: "Source must be a file path",
    })
    .transform((path) => normalizePath(path, false)), // keep trailing slashes for globs
  target: z
    .string({
      required_error: "Target file path is required",
      invalid_type_error: "Target must be a file path",
    })
    .transform((path) => normalizePath(path)),
  computers: z
    .union([
      z.array(
        z.union([
          ComputerIdSchema,
          z.string().min(1, "Group name cannot be empty"),
        ])
      ),
      ComputerIdSchema,
      z.string().min(1, "Group name cannot be empty"),
    ])
    .describe("Computer IDs or group names to sync files to"),
  flatten: z.boolean().optional(),
})

const AdvancedOptionsSchema = z.object({
  verbose: z
    .boolean({
      invalid_type_error: "Verbose must be true or false",
    })
    .default(false),
  cache_ttl: z
    .number({
      invalid_type_error: "Cache TTL must be a number",
    })
    .min(0, "Cache TTL cannot be negative")
    .default(5000),
})

const ComputerGroupsSchema = z
  .record(z.string(), ComputerGroupSchema)
  .refine((groups) => {
    // Ensure no empty groups
    return Object.values(groups).every((group) => group.computers.length > 0)
  }, "Computer groups cannot be empty")
  .optional()

export const ConfigSchema = z
  .object({
    version: z.string({
      required_error: "Config version is required",
      invalid_type_error: "Version must be a string",
    }),
    sourceRoot: z
      .string({
        required_error: "Source path is required",
        invalid_type_error: "Source path must be text",
      })
      .transform((path) => normalizePath(path)),
    minecraftSavePath: z
      .string({
        required_error: "Minecraft save path is required",
        invalid_type_error: "Save path must be text",
      })
      .transform((path) => normalizePath(path)),
    computerGroups: ComputerGroupsSchema,
    rules: z.array(SyncRuleSchema),
    advanced: AdvancedOptionsSchema.default({
      verbose: false,
      cache_ttl: 5000,
    }),
  })
  .superRefine((config, ctx) => {
    // Version compatibility check
    if (!isConfigVersionCompatible(config.version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Config version ${CONFIG_VERSION} is required. You are using ${config.version}.`,
        path: ["version"],
      })
    }

    // Validate each rule's source/target compatibility
    config.rules.forEach((rule, idx) => {
      if (hasGlobPattern(rule.source) && pathIsLikelyFile(rule.target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `When using glob patterns in this rule's [source], [target] should be a directory path. A file path is assumed because it contains a file extension.\n [source] = ${rule.source}\n [target] = ${rule.target} <-- ERROR\n [computers] = ${rule.computers}`,
          path: ["rules", idx],
          fatal: true,
        })
      }
    })

    // Verify any computer groups that are referenced

    // Collect all defined group names
    const definedGroups = config.computerGroups
      ? new Set(Object.keys(config.computerGroups))
      : new Set<string>()

    // Helper to check if a string is likely a group reference (not a numeric ID)
    const isLikelyGroupReference = (ref: string) => isNaN(Number(ref))

    // 1. Check group references within group definitions
    if (config.computerGroups) {
      for (const [groupName, group] of Object.entries(config.computerGroups)) {
        for (const computer of group.computers) {
          // Skip validation for computer IDs
          if (!isLikelyGroupReference(computer)) {
            continue
          }

          // Check if referenced group exists
          if (!definedGroups.has(computer)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Computer group '${groupName}' references unknown group '${computer}'`,
              path: ["computerGroups", groupName, "computers"],
            })
          }
        }
      }
    }

    // 2. Check group references in sync rules
    for (const [ruleIndex, rule] of config.rules.entries()) {
      const computerRefs = Array.isArray(rule.computers)
        ? rule.computers
        : [rule.computers]

      for (const ref of computerRefs) {
        // Skip validation for computer IDs
        if (!isLikelyGroupReference(ref)) {
          continue
        }

        // Check if referenced group exists
        if (!definedGroups.has(ref)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Sync rule references unknown computer group '${ref}'`,
            path: ["rules", ruleIndex, "computers"],
          })
        }
      }
    }
  })

export type Config = z.infer<typeof ConfigSchema>
export type ComputerGroup = z.infer<typeof ComputerGroupSchema>
export type SyncRule = z.infer<typeof SyncRuleSchema>

// ---- CONFIG METHODS ----

export const withDefaultConfig = (config: Partial<Config>): Config => {
  return merge.withOptions({ mergeArrays: false }, DEFAULT_CONFIG, config, {
    rules:
      config.rules?.map((rule) => ({
        ...rule,
        flatten: rule.flatten ?? true, // Default to true if undefined
      })) || [],
  }) as Config
}

export const findConfig = async (
  startDir: string = process.cwd()
): Promise<Array<{ path: string; relativePath: string }>> => {
  const configs: Array<{ path: string; relativePath: string }> = []
  let currentDir = startDir

  while (currentDir !== path.parse(currentDir).root) {
    const configPath = path.join(currentDir, DEFAULT_CONFIG_FILENAME)
    try {
      await fs.access(configPath)
      configs.push({
        path: configPath,
        relativePath: path.relative(startDir, configPath),
      })
    } catch {
      // Continue searching even if this path doesn't exist
    }
    currentDir = path.dirname(currentDir)
  }

  return configs
}

type LoadConfigOptions = {
  skipPathValidation?: boolean
}

export async function loadConfig(
  configFilePath: string,
  options: LoadConfigOptions = {
    skipPathValidation: false,
  }
): Promise<LoadConfigResult> {
  const result: LoadConfigResult = {
    config: null,
    errors: [],
  }

  try {
    const resolvedPath = resolvePath(configFilePath)
    const file = await fs.readFile(resolvedPath, "utf-8")
    const rawConfig = parse(file)

    const parseResult = ConfigSchema.safeParse(rawConfig)

    if (!parseResult.success) {
      // Transform Zod errors into structured errors
      result.errors = parseResult.error.errors.map(categorizeZodError)
      return result
    }

    const validatedConfig = parseResult.data
    // Resolve paths
    const resolvedSourceRoot = resolvePath(validatedConfig.sourceRoot)
    const resolvedSavePath = resolvePath(validatedConfig.minecraftSavePath)

    // We can skip path validation during testing
    if (!options.skipPathValidation) {
      // Validate source root
      try {
        const sourceRootStats = await fs.stat(resolvedSourceRoot)
        if (!sourceRootStats.isDirectory()) {
          result.errors.push({
            category: ConfigErrorCategory.PATH,
            message: `Source root '${validatedConfig.sourceRoot}' is not a directory`,
            suggestion:
              "Make sure the source path points to a directory containing your source files.",
            verboseDetail: `Path resolved to: ${resolvedSourceRoot}`,
          })
        }
      } catch (err) {
        result.errors.push({
          category: ConfigErrorCategory.PATH,
          message: `Source root '${validatedConfig.sourceRoot}' cannot be accessed`,
          suggestion: "Create the directory or check permissions.",
          verboseDetail: `Error: ${err instanceof Error ? err.message : String(err)}, Path: ${resolvedSourceRoot}`,
        })
      }

      // Validate save path
      try {
        await fs.access(resolvedSavePath)
        // We don't validate if it's a Minecraft save here - that happens elsewhere
      } catch (err) {
        result.errors.push({
          category: ConfigErrorCategory.PATH,
          message: `Minecraft save path '${validatedConfig.minecraftSavePath}' cannot be accessed`,
          suggestion:
            "Check if the save exists and you have permissions to access it.",
          verboseDetail: `Error: ${err instanceof Error ? err.message : String(err)}, Path: ${resolvedSavePath}`,
        })
      }
    }

    // Check for circular references in computer groups
    if (validatedConfig.computerGroups) {
      const circularRefs = findCircularGroupReferences(
        validatedConfig.computerGroups
      )
      if (circularRefs.length > 0) {
        result.errors.push({
          category: ConfigErrorCategory.COMPUTER,
          message: `Circular references detected in computer groups: ${circularRefs.join(", ")}`,
          suggestion: "Remove circular references between computer groups.",
          verboseDetail: `Circular reference chain: ${circularRefs.join(" -> ")}`,
        })
      }
    }

    // Only set the config if we have no errors
    if (result.errors.length === 0) {
      result.config = {
        ...validatedConfig,
        sourceRoot: normalizePath(resolvedSourceRoot),
        minecraftSavePath: normalizePath(resolvedSavePath),
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)

    // Determine if this is a file access issue
    const isFileAccessError =
      errorMessage.includes("ENOENT") ||
      errorMessage.includes("no such file") ||
      errorMessage.includes("cannot open")

    result.errors.push({
      category: isFileAccessError
        ? ConfigErrorCategory.PATH
        : ConfigErrorCategory.UNKNOWN,
      message: `Failed to read/parse config file: ${errorMessage}`,
      suggestion: isFileAccessError
        ? "Check that the config file exists and is readable."
        : "Verify the config file contains valid YAML syntax.",
      verboseDetail: `Full error: ${error instanceof Error ? error.stack : String(error)}`,
    })
  }
  return result
}

export const createDefaultConfig = async (projectDir: string) => {
  const configPath = path.join(projectDir, DEFAULT_CONFIG_FILENAME)
  const configContent = `# CC:Sync Configuration File
# This file configures how CC:Sync copies files to your ComputerCraft computers

# Config version (do not modify)
version: "${CONFIG_VERSION}"

# Where your source files are located (relative to this config file)
sourceRoot: "${DEFAULT_CONFIG.sourceRoot}"

# Absolute path to your Minecraft world save
# Can use ~ for your home directory
# Example Windows: "~/AppData/Roaming/.minecraft/saves/my_world"
# Example Unix: "~/.minecraft/saves/my_world"
minecraftSavePath: "${DEFAULT_CONFIG.minecraftSavePath}"

# Define groups of computers for easier file targeting
computerGroups: {}
  # Example group:
  # monitors:
  #   name: "Monitor Network"
  #   computers: ["1", "2", "3"]

# Rules that specify which files should sync to which computers
rules: []
  # Examples:
  # Sync to a specific computer:
  # - source: "startup.lua"    # File in your sourceRoot
  #   target: "startup.lua"    # Where to put it on the computer
  #   computers: ["1"]         # Computer IDs to sync to
  #
  # Sync to a group of computers:
  # - source: "lib/*.lua"      # Glob patterns supported
  #   target: "lib/"          # Folders will be created
  #   computers: "monitors"    # Reference a computer group

# Advanced configuration options
advanced:
  # Enable verbose logging
  verbose: false
  
  # How long to cache validation results (milliseconds)
  # Lower = more accurate but more CPU intensive, Higher = faster but may miss changes
  cache_ttl: 5000
`

  await fs.writeFile(configPath, configContent, "utf-8")
}

/**
 * Detects circular references between computer groups in the configuration.
 *
 * A circular reference occurs when computer groups reference each other in a loop,
 * which would cause infinite recursion when trying to resolve all computers in a group.
 *
 * Example of a circular reference:
 * ```
 * computerGroups: {
 *   servers: {
 *     name: "Servers",
 *     computers: ["1", "2", "clients"]  // References the 'clients' group
 *   },
 *   clients: {
 *     name: "Clients",
 *     computers: ["3", "4", "servers"]  // References the 'servers' group, creating a loop
 *   }
 * }
 * ```
 *
 * @param groups - Record of computer group definitions from the config
 * @returns An array of group names that form a circular reference chain, or an empty array if none found.
 * For the example above, it would return: ["servers", "clients", "servers"]
 */
export function findCircularGroupReferences(
  groups: Record<string, ComputerGroup>
): string[] {
  // Helper to check if a string is a number (computer ID) or a group name
  const isGroupName = (name: string) =>
    isNaN(Number(name)) && groups[name] !== undefined

  // Depth-first search to find cycles
  function dfs(
    current: string,
    visited: Set<string>,
    path: string[]
  ): string[] {
    if (visited.has(current)) {
      // Found a cycle
      const cycleStart = path.indexOf(current)
      return path.slice(cycleStart)
    }

    // Not a group, no need to process
    if (!isGroupName(current)) {
      return []
    }

    visited.add(current)
    path.push(current)

    // Check all computers in this group
    for (const computer of groups[current].computers) {
      // Only recurse if it's a group name
      if (isGroupName(computer)) {
        const cycle = dfs(computer, visited, [...path])
        if (cycle.length > 0) {
          return cycle
        }
      }
    }

    visited.delete(current)
    return []
  }

  // Check each group
  for (const groupName of Object.keys(groups)) {
    const cycle = dfs(groupName, new Set<string>(), [])
    if (cycle.length > 0) {
      return cycle
    }
  }

  return []
}
```


## src/sync.ts

```ts
import { watch } from "chokidar"
import path from "node:path"
import type { Config } from "./config"
import { createLogger, type Logger } from "./log"
import {
  type Computer,
  type ValidationResult,
  type SyncResult,
  createTypedEmitter,
  type ManualSyncEvents,
  type WatchSyncEvents,
  SyncEvent,
  type ResolvedFileRule,
  type ComputerSyncResult,
} from "./types"
import {
  validateMinecraftSave,
  findMinecraftComputers,
  resolveSyncRules,
  copyFilesToComputer,
  normalizePath,
} from "./utils"
import { KeyHandler } from "./keys"
import { setTimeout } from "node:timers/promises"
import { glob } from "glob"
import { getErrorMessage } from "./errors"
import { UI } from "./ui"

enum SyncManagerState {
  IDLE,
  STARTING,
  RUNNING,
  STOPPING,
  STOPPED,
  ERROR,
}

export class SyncManager {
  private log: Logger
  private ui: UI | null = null
  private activeModeController:
    | ManualModeController
    | WatchModeController
    | null = null
  private lastValidation: Readonly<{
    validation: Readonly<ValidationResult>
    computers: ReadonlyArray<Computer>
    timestamp: number
  }> | null = null

  // STATE
  private state: SyncManagerState = SyncManagerState.IDLE
  private setState(newState: SyncManagerState) {
    // const oldState = this.state
    this.state = newState
    // this.log.verbose(
    //   `State transition: ${SyncManagerState[oldState]} → ${SyncManagerState[newState]}`
    // );
  }

  constructor(private config: Config) {
    this.log = createLogger({ verbose: config.advanced.verbose })
  }

  // Public state query methods
  public isRunning(): boolean {
    return this.state === SyncManagerState.RUNNING
  }

  public getState(): SyncManagerState {
    return this.state
  }

  // Cache management
  private isCacheValid(): boolean {
    if (!this.lastValidation?.timestamp) return false
    if (this.activeModeController instanceof WatchModeController) return false

    const timeSinceLastValidation = Date.now() - this.lastValidation.timestamp
    this.log.verbose(`Time since last validation: ${timeSinceLastValidation}ms`)
    const isValid = timeSinceLastValidation < this.config.advanced.cache_ttl
    this.log.verbose(`Cache valid? ${isValid}`)

    return isValid
  }

  public invalidateCache(): void {
    this.lastValidation = null
  }

  // Core validation and sync methods
  public async runValidation(forceRefresh = false): Promise<ValidationResult> {
    if (!forceRefresh && this.isCacheValid()) {
      if (this.lastValidation?.validation) {
        this.log.verbose("Using cached validation results")
        return this.lastValidation.validation
      }
    }

    const result: ValidationResult = {
      resolvedFileRules: [],
      availableComputers: [],
      missingComputerIds: [],
      errors: [],
    }

    try {
      // Validate save directory
      const saveDirValidation = await validateMinecraftSave(
        this.config.minecraftSavePath
      )
      if (!saveDirValidation.isValid) {
        result.errors.push(...saveDirValidation.errors)
        return result
      }

      // Discover computers
      let computers: Computer[] = []
      try {
        computers = await findMinecraftComputers(this.config.minecraftSavePath)
      } catch (err) {
        result.errors.push(
          `Failed to find computers: ${err instanceof Error ? err.message : String(err)}`
        )
        return result
      }

      if (computers.length === 0) {
        result.errors.push(
          "No computers found in the save directory. Try adding a dummy file to a computer and then re-run CC:Sync."
        )
        return result
      }

      // Get changed files from watch mode if applicable
      const changedFiles =
        this.activeModeController instanceof WatchModeController
          ? this.activeModeController.getChangedFiles()
          : undefined

      // Validate the file sync rules
      const validation = await resolveSyncRules(
        this.config,
        computers,
        changedFiles
      )

      // If validation has errors, return them
      if (validation.errors.length > 0) {
        return validation
      }

      // Cache successful validation results
      this.lastValidation = {
        validation,
        computers,
        timestamp: Date.now(),
      }
      return validation
    } catch (err) {
      // For unexpected errors (not validation errors), add to result
      result.errors.push(
        `Unexpected validation error: ${err instanceof Error ? err.message : String(err)}`
      )
      this.lastValidation = null
      return result
    }
  }

  private async syncToComputer(
    computer: Computer,
    fileRules: ResolvedFileRule[]
  ): Promise<{
    computerId: string
    copiedFiles: string[]
    skippedFiles: string[]
    errors: string[]
  }> {
    const filesToCopy = fileRules.filter((file) =>
      file.computers.includes(computer.id)
    )

    if (filesToCopy.length === 0) {
      return {
        computerId: computer.id,
        copiedFiles: [],
        skippedFiles: [],
        errors: [],
      }
    }

    const copyResult = await copyFilesToComputer(filesToCopy, computer.path)
    await setTimeout(250) // Small delay between computers

    return {
      computerId: computer.id,
      ...copyResult,
    }
  }

  public async performSync(validation: ValidationResult): Promise<SyncResult> {
    if (this.state !== SyncManagerState.RUNNING) {
      throw new Error("Cannot perform sync when not in RUNNING state")
    }

    const computerResults: ComputerSyncResult[] = []

    const allComputerIds = new Set<string>()

    // First create entries for all computers
    for (const rule of validation.resolvedFileRules) {
      for (const computerId of rule.computers) {
        // Create computer if it doesn't exist yet
        if (!allComputerIds.has(computerId)) {
          allComputerIds.add(computerId)

          // Check if this is a missing computer
          const isExisting = validation.availableComputers.some(
            (c) => c.id === computerId
          )

          computerResults.push({
            computerId,
            exists: isExisting,
            files: [],
          })
        }

        // Get the computer result
        const computerResult = computerResults.find(
          (cr) => cr.computerId === computerId
        )!

        // Prepare target path based on target type
        let targetPath = rule.target.path

        // If target is a directory, append the source filename
        if (rule.target.type === "directory") {
          const sourceFilename = path.basename(rule.sourceAbsolutePath)
          targetPath = path.join(targetPath, sourceFilename)
          targetPath = normalizePath(targetPath)
        }

        // Add file entry with explicit type information
        computerResult.files.push({
          targetPath,
          targetType: rule.target.type,
          sourcePath: rule.sourceAbsolutePath,
          success: false, // Mark all as unsuccessful initially
        })
      }
    }

    // Update UI status
    if (this.ui) {
      this.ui.updateStatus("running", "Syncing files to computers...")
    }

    const result: SyncResult = {
      successCount: 0,
      errorCount: 0,
      missingCount: validation.missingComputerIds.length,
    }

    // Process each computer
    for (const computer of validation.availableComputers) {
      const syncResult = await this.syncToComputer(
        computer,
        validation.resolvedFileRules
      )

      // Find this computer in our results array
      const computerResult = computerResults.find(
        (cr) => cr.computerId === computer.id
      )
      if (!computerResult) continue // Should never happen but TypeScript needs this check

      // Process all copied files (successes)
      for (const filePath of syncResult.copiedFiles) {
        // Find the rule for this file to get target path
        const rule = validation.resolvedFileRules.find(
          (rule) =>
            rule.sourceAbsolutePath === filePath &&
            rule.computers.includes(computer.id)
        )

        if (rule) {
          // Build the complete target path including filename
          let targetPath = rule.target.path

          if (rule.target.type === "directory") {
            const filename = path.basename(filePath)
            targetPath = path.join(targetPath, filename)
            targetPath = normalizePath(targetPath)
          }

          // Find and update the file entry
          const fileEntry = computerResult.files.find(
            (f) => f.targetPath === targetPath
          )
          if (fileEntry) {
            fileEntry.success = true
          }
        }
      }

      // Log any errors
      if (syncResult.errors.length > 0) {
        if (this.ui) {
          this.ui.updateStatus(
            "error",
            `Error copying files to computer ${computer.id}: ${syncResult.errors[0]}`
          )
        }
        syncResult.errors.forEach((error) => this.log.warn(`  ${error}`))
        result.errorCount++
      } else if (syncResult.copiedFiles.length > 0) {
        result.successCount++
      }
    }

    // Determine overall status
    const statusMessage = ""
    let status: "success" | "error" | "partial" = "success"

    if (result.errorCount === 0 && result.missingCount === 0) {
      status = "success"
      // statusMessage = "Sync completed successfully!"
    } else if (result.successCount === 0) {
      status = "error"
      // statusMessage = "Sync failed. No computers were updated."
    } else {
      status = "partial"
      // statusMessage = "Partial sync completed with some errors."
    }

    // Update UI with final status
    if (this.ui) {
      this.ui.updateStats({
        success: result.successCount,
        error: result.errorCount,
        missing: result.missingCount,
      })
      this.ui.updateComputerResults(computerResults)
      this.ui.updateStatus(status, statusMessage)
    }

    // Cache invalidation for watch mode
    if (this.activeModeController instanceof WatchModeController) {
      this.invalidateCache()
    }

    return result
  }

  async startManualMode(): Promise<ManualModeController> {
    if (this.state !== SyncManagerState.IDLE) {
      throw new Error(
        `Cannot start manual mode in state: ${SyncManagerState[this.state]}`
      )
    }

    try {
      this.setState(SyncManagerState.STARTING)

      // Initialize UI for manual mode
      this.ui = new UI(this.config.sourceRoot, "manual")

      const manualController = new ManualModeController(this, this.log, this.ui)
      this.activeModeController = manualController

      // Listen for controller state changes
      manualController.on(SyncEvent.STARTED, () => {
        this.setState(SyncManagerState.RUNNING)
        if (this.ui) this.ui.start()
      })

      // Listen for controller state changes
      manualController.on(SyncEvent.STOPPED, () => {
        this.setState(SyncManagerState.STOPPED)
        if (this.ui) this.ui.stop()
      })

      manualController.on(SyncEvent.SYNC_ERROR, ({ error, fatal }) => {
        if (this.ui) {
          this.ui.updateStatus("error", `Error: ${getErrorMessage(error)}`)
        }
        if (fatal) {
          this.setState(SyncManagerState.ERROR)
          this.stop()
        }
      })

      // Start the controller
      manualController.start().catch((error) => {
        this.setState(SyncManagerState.ERROR)
        if (this.ui)
          this.ui.updateStatus(
            "error",
            `Failed to start: ${getErrorMessage(error)}`
          )
        this.stop()
      })

      return manualController
    } catch (error) {
      this.setState(SyncManagerState.ERROR)
      throw error
    }
  }
  async startWatchMode(): Promise<WatchModeController> {
    if (this.state !== SyncManagerState.IDLE) {
      throw new Error(
        `Cannot start watch mode in state: ${SyncManagerState[this.state]}`
      )
    }

    try {
      this.setState(SyncManagerState.STARTING)

      // Initialize UI for watch mode
      this.ui = new UI(this.config.sourceRoot, "watch")

      const watchController = new WatchModeController(
        this,
        this.config,
        this.log,
        this.ui
      )
      this.activeModeController = watchController

      // Listen for controller state changes
      watchController.on(SyncEvent.STARTED, () => {
        this.setState(SyncManagerState.RUNNING)
        if (this.ui) this.ui.start()
      })

      watchController.on(SyncEvent.STOPPED, () => {
        this.setState(SyncManagerState.STOPPED)
        if (this.ui) this.ui.stop()
      })

      watchController.on(SyncEvent.SYNC_ERROR, ({ error, fatal }) => {
        if (this.ui) {
          this.ui.updateStatus("error", `Error: ${getErrorMessage(error)}`)
        }
        if (fatal) {
          this.setState(SyncManagerState.ERROR)
          this.stop()
        }
      })

      // Start the controller
      watchController.start().catch((error) => {
        this.setState(SyncManagerState.ERROR)
        if (this.ui)
          this.ui.updateStatus(
            "error",
            `Failed to start: ${getErrorMessage(error)}`
          )
        this.stop()
      })

      return watchController
    } catch (error) {
      this.setState(SyncManagerState.ERROR)
      throw error
    }
  }

  async stop(): Promise<void> {
    if (
      this.state === SyncManagerState.STOPPED ||
      this.state === SyncManagerState.STOPPING
    )
      return

    this.setState(SyncManagerState.STOPPING)

    try {
      if (this.ui) {
        this.ui.stop()
        this.ui = null
      }

      if (this.activeModeController) {
        await this.activeModeController.stop()
        this.activeModeController = null
      }
      this.setState(SyncManagerState.STOPPED)
    } catch (error) {
      this.setState(SyncManagerState.ERROR)
      throw error
    }
  }
}

class ManualModeController {
  private keyHandler: KeyHandler | null = null
  protected events = createTypedEmitter<ManualSyncEvents>()

  constructor(
    private syncManager: SyncManager,
    private log: Logger,
    private ui: UI | null = null
  ) {}

  emit<K extends keyof ManualSyncEvents>(
    event: K,
    data?: ManualSyncEvents[K] extends void ? void : ManualSyncEvents[K]
  ) {
    return this.events.emit(event, data)
  }

  on<K extends keyof ManualSyncEvents>(
    event: K,
    listener: ManualSyncEvents[K] extends void
      ? () => void
      : (data: ManualSyncEvents[K]) => void
  ) {
    this.events.on(event, listener)
  }

  once<K extends keyof ManualSyncEvents>(
    event: K,
    listener: ManualSyncEvents[K] extends void
      ? () => void
      : (data: ManualSyncEvents[K]) => void
  ) {
    this.events.once(event, listener)
  }

  off<K extends keyof ManualSyncEvents>(
    event: K,
    listener: ManualSyncEvents[K] extends void
      ? () => void
      : (data: ManualSyncEvents[K]) => void
  ) {
    this.events.off(event, listener)
  }

  async start(): Promise<void> {
    this.emit(SyncEvent.STARTED) // Signal ready to run

    try {
      if (this.ui) {
        this.ui.clear()
      }

      while (this.syncManager.getState() === SyncManagerState.RUNNING) {
        await this.performSyncCycle()

        await this.waitForUserInput()
      }
    } catch (error) {
      await this.cleanup()
      throw error
    }
  }

  async stop(): Promise<void> {
    await this.cleanup()
    this.emit(SyncEvent.STOPPED)
  }

  private async performSyncCycle(): Promise<void> {
    if (this.syncManager.getState() !== SyncManagerState.RUNNING) {
      throw new Error("Cannot perform sync when not in RUNNING state")
    }

    try {
      const validation = await this.syncManager.runValidation()
      this.emit(SyncEvent.SYNC_VALIDATION, validation)

      // Check if validation has errors
      if (validation.errors.length > 0) {
        // Log the validation errors
        if (this.ui) {
          this.ui.stop()
        }
        this.log.error(`Could not continue due to the following errors:`)
        validation.errors.forEach((error) =>
          this.log.error(`${validation.errors.length > 1 ? "• " : ""}${error}`)
        )

        // Emit sync error event
        this.emit(SyncEvent.SYNC_ERROR, {
          error: new Error(
            "Validation failed: " + validation.errors.join(", ")
          ),
          fatal: false, // Non-fatal error
          source: "validation",
        })

        return // Stop here, don't proceed with sync
      }

      const { successCount, errorCount, missingCount } =
        await this.syncManager.performSync(validation)

      this.emit(SyncEvent.SYNC_COMPLETE, {
        successCount,
        errorCount,
        missingCount,
      })
    } catch (err) {
      // Only for unexpected runtime errors, not validation errors
      this.emit(SyncEvent.SYNC_ERROR, {
        error: err instanceof Error ? err : new Error(String(err)),
        fatal: true, // Runtime errors are considered fatal
      })
      throw err
    }
  }

  private waitForUserInput(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.setupKeyHandler(resolve)
    })
  }

  private setupKeyHandler(continueCallback: () => void): void {
    if (this.keyHandler) {
      this.keyHandler.stop()
    }

    this.keyHandler = new KeyHandler({
      onSpace: async () => {
        continueCallback()
      },
      onEsc: async () => {
        await this.syncManager.stop()
        // this.log.info("CC: Sync manual mode stopped.")
      },
      onCtrlC: async () => {
        await this.syncManager.stop()
        continueCallback()
        // this.log.info("CC:Sync program terminated.")
      },
    })

    this.keyHandler.start()
  }

  private async cleanup(): Promise<void> {
    if (this.keyHandler) {
      this.keyHandler.stop()
      this.keyHandler = null
    }
  }
}

class WatchModeController {
  private watcher: ReturnType<typeof watch> | null = null
  private keyHandler: KeyHandler | null = null
  /**
   * Files being watched or tracked for file changes
   */
  private watchedFiles: Set<string> = new Set()
  /**
   * Temp set of files that have just changed that will be synced. Clear when synced.
   */
  private changedFiles: Set<string> = new Set()

  private isInitialSync = true
  protected events = createTypedEmitter<WatchSyncEvents>()

  constructor(
    private syncManager: SyncManager,
    private config: Config,
    private log: Logger,
    private ui: UI | null = null
  ) {}

  emit<K extends keyof WatchSyncEvents>(
    event: K,
    data?: WatchSyncEvents[K] extends void ? void : WatchSyncEvents[K]
  ) {
    return this.events.emit(event, data)
  }

  on<K extends keyof WatchSyncEvents>(
    event: K,
    listener: WatchSyncEvents[K] extends void
      ? () => void
      : (data: WatchSyncEvents[K]) => void
  ) {
    this.events.on(event, listener)
  }

  once<K extends keyof WatchSyncEvents>(
    event: K,
    listener: WatchSyncEvents[K] extends void
      ? () => void
      : (data: WatchSyncEvents[K]) => void
  ) {
    this.events.once(event, listener)
  }

  off<K extends keyof WatchSyncEvents>(
    event: K,
    listener: WatchSyncEvents[K] extends void
      ? () => void
      : (data: WatchSyncEvents[K]) => void
  ) {
    this.events.off(event, listener)
  }

  async start(): Promise<void> {
    try {
      this.setupKeyHandler()
      await this.setupWatcher()

      this.emit(SyncEvent.STARTED) // Signal ready to run

      if (this.ui) {
        this.ui.clear()
      }

      // Peform initial sync
      await this.performSyncCycle()

      if (this.syncManager.getState() !== SyncManagerState.RUNNING) return

      // Keep running until state changes
      while (this.syncManager.getState() === SyncManagerState.RUNNING) {
        await new Promise((resolve) => setTimeout(100, resolve))
      }
    } catch (error) {
      this.log.error(
        `Watch mode error: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      throw error
    } finally {
      await this.stop()
    }
  }

  async stop(): Promise<void> {
    await this.cleanup()
    this.emit(SyncEvent.STOPPED)
  }

  getChangedFiles(): Set<string> | undefined {
    return this.isInitialSync ? undefined : this.changedFiles
  }

  private async performSyncCycle(changedPath?: string): Promise<void> {
    if (this.syncManager.getState() !== SyncManagerState.RUNNING) {
      throw new Error("Cannot perform sync when not in RUNNING state")
    }

    try {
      // If this is triggered by a file change, update the changedFiles set
      if (changedPath) {
        const relativePath = normalizePath(
          path.relative(this.config.sourceRoot, changedPath)
        )
        this.changedFiles.add(relativePath)
        this.syncManager.invalidateCache()
        // this.log.status(`File changed: ${changedPath}`)

        // Update UI without triggering a full re-render
        if (this.ui) {
          this.ui.updateStatus(
            "running",
            `Syncing changed file: ${path.basename(changedPath)}`
          )
        }
      }

      // Perform validation
      const validation = await this.syncManager.runValidation(true)
      this.emit(SyncEvent.SYNC_VALIDATION, validation)

      // Check if validation has errors
      if (validation.errors.length > 0) {
        // Log the validation errors
        // this.log.error(`Validation failed:`)
        // validation.errors.forEach((error) =>
        //   this.log.error(`${validation.errors.length > 1 ? "• " : ""}${error}`)
        // )

        this.emit(SyncEvent.SYNC_ERROR, {
          error: new Error(
            "Validation failed: " + validation.errors.join(", ")
          ),
          fatal: this.isInitialSync, // Fatal only on initial sync
          source: "validation",
        })

        // For initial sync, throw to abort startup
        if (this.isInitialSync) {
          throw new Error("Initial validation failed")
        }

        return // Don't proceed with sync
      }

      // Perform sync
      const { successCount, errorCount, missingCount } =
        await this.syncManager.performSync(validation)

      // Emit appropriate event based on sync type
      if (this.isInitialSync) {
        this.isInitialSync = false
        this.emit(SyncEvent.INITIAL_SYNC_COMPLETE, {
          successCount,
          errorCount,
          missingCount,
        })
      } else {
        this.emit(SyncEvent.SYNC_COMPLETE, {
          successCount,
          errorCount,
          missingCount,
        })
        // Clear changed files after successful non-initial sync
        this.changedFiles.clear()
      }
    } catch (err) {
      // For unexpected runtime errors

      this.emit(SyncEvent.SYNC_ERROR, {
        error: err instanceof Error ? err : new Error(String(err)),
        fatal: true, // Runtime errors are considered fatal
      })
      throw err
    }
  }

  private setupKeyHandler(): void {
    if (this.keyHandler) {
      this.keyHandler.stop()
    }

    this.keyHandler = new KeyHandler({
      onEsc: async () => {
        await this.syncManager.stop()
        // this.log.info("CC: Sync watch mode stopped.")
      },
      onCtrlC: async () => {
        await this.syncManager.stop()
        // this.log.info("CC: Sync program terminated.")
      },
    })

    this.keyHandler.start()
  }

  private async resolveWatchPatterns(): Promise<string[]> {
    try {
      // Get all unique file paths from glob patterns
      const uniqueSourcePaths = new Set<string>()

      for (const rule of this.config.rules) {
        const sourcePath = normalizePath(
          path.join(this.config.sourceRoot, rule.source),
          false // Don't strip trailing slash for globs
        )
        const matches = await glob(sourcePath, { absolute: true })
        matches.forEach((match) => uniqueSourcePaths.add(normalizePath(match)))
      }

      // Convert to array and store in watchedFiles
      const patterns = Array.from(uniqueSourcePaths)
      this.watchedFiles = new Set(patterns)

      return patterns
    } catch (err) {
      // this.log.error(`Failed to resolve watch patterns: ${err}`)
      if (this.ui) {
        this.ui.updateStatus(
          "error",
          `Failed to resolve watch patterns: ${err}`
        )
      }
      throw err
    }
  }

  private async setupWatcher(): Promise<void> {
    // Get actual file paths to watch
    const patterns = await this.resolveWatchPatterns()

    this.watcher = watch(patterns, {
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    })

    this.watcher.on("change", async (changedPath) => {
      if (this.syncManager.getState() !== SyncManagerState.RUNNING) {
        return
      }

      try {
        await this.performSyncCycle(changedPath)
      } catch (err) {
        // Error handling is done within performSyncCycle
        // If err is FATAL emit a SyncEvent.SYNC_ERROR with fatal
        // If err is not fatal, inform user and keep watcher going...
        // this.log.warn("Problem occurred during sync")
        if (this.ui) {
          this.ui.updateStatus("error", "Problem occurred during sync")
        }
      }
    })

    this.watcher.on("error", (err) => {
      this.emit(SyncEvent.SYNC_ERROR, {
        error: err instanceof Error ? err : new Error(String(err)),
        fatal: true,
      })
    })
  }

  private async cleanup(): Promise<void> {
    if (this.keyHandler) {
      this.keyHandler.stop()
      this.keyHandler = null
    }

    if (this.watcher) {
      try {
        await this.watcher.close()
      } catch (err) {
        console.error(`Error closing watcher: ${err}`)
      }
      this.watcher = null
    }
    this.changedFiles.clear()
    this.watchedFiles.clear()
  }
}
```


