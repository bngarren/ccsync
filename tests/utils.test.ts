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
