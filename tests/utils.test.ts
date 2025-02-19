import { expect, test, describe, beforeEach, mock, afterEach, beforeAll } from "bun:test";
import * as fs from "node:fs/promises";
import {
  validateSaveDir,
  discoverComputers,
  copyFilesToComputer,
  validateFileSync,
  getComputerShortPath,
} from "../src/utils";
import path from "path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "os";
import crypto from "crypto";
import { tmpdir } from "node:os";
import { withDefaultConfig, type Config } from "../src/config";
import { cleanupTempDir, createTestComputer, createTestFiles, createTestSave, createUniqueTempDir, TempCleaner } from "./test-helpers";



// ---- MC SAVE OPERATIONS ----
describe("Save Directory Validation", () => {
  let tempDir: string;
  let testSaveDir: string;

  const cleanup = TempCleaner.getInstance();

  beforeEach(async () => {
    // Create new unique temp directory for this test
    tempDir = createUniqueTempDir();
    cleanup.add(tempDir)

    testSaveDir = path.join(tempDir, "save");
    await createTestSave(testSaveDir);
  });

  afterEach(async () => {
    await cleanup.cleanDir(tempDir)
  });


  test("validates a correct save directory", async () => {
    const result = await validateSaveDir(testSaveDir);
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("fails on missing save directory", async () => {
    // Remove the entire save directory
    await rm(testSaveDir, { recursive: true });

    const result = await validateSaveDir(testSaveDir);
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain(`Save directory not found: ${testSaveDir}`);
  });

  test("fails on missing computercraft directory", async () => {
    // Remove just the computercraft directory
    await rm(path.join(testSaveDir, "computercraft"), { recursive: true });

    const result = await validateSaveDir(testSaveDir);
    expect(result.isValid).toBe(false);
    expect(result.missingFiles).toContain("computercraft/computer");
  });

  test("fails when required files are missing", async () => {
    // Remove the required files but keep directories
    await rm(path.join(testSaveDir, "level.dat"));
    await rm(path.join(testSaveDir, "session.lock"));

    const result = await validateSaveDir(testSaveDir);
    expect(result.isValid).toBe(false);
    expect(result.missingFiles).toContain("level.dat");
    expect(result.missingFiles).toContain("session.lock");
  });
});

// ---- COMPUTER OPERATIONS ----
describe("Computer Discovery", () => {
  let tempDir: string;
  let testSaveDir: string;
  let computersDir: string;

  const cleanup = TempCleaner.getInstance();

  beforeEach(async () => {
    // Create new unique temp directory for this test
    tempDir = createUniqueTempDir();
    cleanup.add(tempDir)
    testSaveDir = path.join(tempDir, "save");
    computersDir = path.join(testSaveDir, "computercraft", "computer");
    await createTestSave(testSaveDir);
  });

  afterEach(async () => {
    await cleanup.cleanDir(tempDir)
  });

  test("discovers computers in save directory", async () => {
    await createTestComputer(computersDir, "0");
    await createTestComputer(computersDir, "1");
    await createTestComputer(computersDir, "2");

    const computers = await discoverComputers(testSaveDir);
    expect(computers).toHaveLength(3);
    expect(computers.map((c) => c.id)).toEqual(["0", "1", "2"]);
  });

  test("sorts computers numerically", async () => {
    await createTestComputer(computersDir, "2");
    await createTestComputer(computersDir, "10");
    await createTestComputer(computersDir, "1");

    const computers = await discoverComputers(testSaveDir);
    expect(computers.map((c) => c.id)).toEqual(["1", "2", "10"]);
  });

  test("includes non-numeric computer IDs", async () => {
    await createTestComputer(computersDir, "1");
    await createTestComputer(computersDir, "turtle");
    await createTestComputer(computersDir, "pocket");

    const computers = await discoverComputers(testSaveDir);
    expect(computers.map((c) => c.id)).toEqual(["1", "pocket", "turtle"]);
  });

  test("excludes system directories", async () => {
    await createTestComputer(computersDir, "0");
    await createTestComputer(computersDir, "1");
    // Create some system directories that should be excluded
    await mkdir(path.join(computersDir, ".git"), { recursive: true });
    await mkdir(path.join(computersDir, ".vscode"), { recursive: true });
    await mkdir(path.join(computersDir, ".DS_Store"), { recursive: true });

    const computers = await discoverComputers(testSaveDir);
    expect(computers).toHaveLength(2);
    expect(computers.map((c) => c.id)).toEqual(["0", "1"]);
  });

  test("sets correct paths for computers", async () => {
    await createTestComputer(computersDir, "1");

    const computers = await discoverComputers(testSaveDir);
    expect(computers).toHaveLength(1);
    // Match types.ts -> Computer
    expect(computers[0]).toMatchObject({
      id: "1",
      path: path.join(computersDir, "1"),
      shortPath: expect.stringContaining("1"),
    });
  });

  test("returns empty array for empty computers directory", async () => {
    const computers = await discoverComputers(testSaveDir);
    expect(computers).toHaveLength(0);
  });
});

// ---- FILE OPERATIONS ----
describe("File Operations", () => {
  let tempDir: string;
  let testSaveDir: string;
  let testSaveName: string;
  let sourceDir: string;
  let computersDir: string;

  const cleanup = TempCleaner.getInstance();

  beforeEach(async () => {
    // Create new unique temp directory for this test
    tempDir = createUniqueTempDir();
    cleanup.add(tempDir)
    sourceDir = path.join(tempDir, "source");
    testSaveName = "world";
    testSaveDir = path.join(tempDir, testSaveName);
    computersDir = path.join(testSaveDir, "computercraft", "computer");

    await createTestSave(testSaveDir);
    await mkdir(sourceDir, { recursive: true });
    await createTestFiles(sourceDir)
  });

  afterEach(async () => {
    await cleanup.cleanDir(tempDir)
  });

  describe("validateFileSync", () => {
    test("validates files and returns correct structure", async () => {
      const config: Config = withDefaultConfig({
        sourcePath: sourceDir,
        minecraftSavePath: testSaveDir,
        files: [
          { source: "program.lua", target: "/program.lua", computers: ["1"] },
          { source: "startup.lua", target: "/startup.lua", computers: ["1"] },
        ],
      });

      const computers = [
        {
          id: "1",
          path: computersDir,
          shortPath: getComputerShortPath(testSaveName, "1"),
        },
      ];
      const validation = await validateFileSync(config, computers);

      expect(validation.resolvedFiles).toHaveLength(2);
      expect(validation.targetComputers).toHaveLength(1);
      expect(validation.errors).toHaveLength(0);
    });

    test("handles missing files", async () => {
      const config: Config = withDefaultConfig({
        sourcePath: sourceDir,
        minecraftSavePath: testSaveDir,
        files: [
          { source: "missing.lua", target: "/missing.lua", computers: ["1"] },
        ],
      });

      const computers = [
        {
          id: "1",
          path: computersDir,
          shortPath: getComputerShortPath(testSaveName, "1"),
        },
      ];
      const validation = await validateFileSync(config, computers);

      expect(validation.resolvedFiles).toHaveLength(0);
      expect(validation.errors).toHaveLength(1);
    });

    test("handles changedFiles filter in watch mode", async () => {
      const config: Config = withDefaultConfig({
        sourcePath: sourceDir,
        minecraftSavePath: testSaveDir,
        files: [
          { source: "program.lua", target: "/program.lua", computers: ["1"] },
          { source: "startup.lua", target: "/startup.lua", computers: ["1"] },
        ],
      });

      const computers = [
        {
          id: "1",
          path: computersDir,
          shortPath: getComputerShortPath(testSaveName, "1"),
        },
      ];
      const changedFiles = new Set(["program.lua"]);

      const validation = await validateFileSync(
        config,
        computers,
        changedFiles
      );

      expect(validation.resolvedFiles).toHaveLength(1);
      expect(validation.resolvedFiles[0].sourcePath).toContain("program.lua");
    });
  });

  describe("copyFilesToComputer", () => {
    test("copies resolved files to computer", async () => {
      const computerPath = path.join(computersDir, "1");
      await mkdir(computerPath, { recursive: true });

      const resolvedFiles = [
        {
          sourcePath: path.join(sourceDir, "program.lua"),
          targetPath: "/program.lua",
          computers: ["1"],
        },
      ];

      await copyFilesToComputer(resolvedFiles, computerPath);

      expect(await fs.exists(path.join(computerPath, "program.lua"))).toBe(
        true
      );
    });
  });

  test("resolves computer groups and handles glob patterns", async () => {
    // Create test files matching glob pattern
    await mkdir(path.join(sourceDir, "apis"), { recursive: true });
    await writeFile(path.join(sourceDir, "apis/http.lua"), "-- HTTP API");
    await writeFile(path.join(sourceDir, "apis/json.lua"), "-- JSON API");

    const config: Config = withDefaultConfig({
      sourcePath: sourceDir,
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
      files: [
        // Test glob pattern to group
        {
          source: "apis/*.lua",
          target: "/apis/",
          computers: "network",
        },
        // Test glob pattern to multiple groups
        {
          source: "startup.lua",
          target: "/startup.lua",
          computers: ["network", "monitors"],
        },
      ],
    });

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
    ];

    const validation = await validateFileSync(config, computers);

    // Should have 3 resolved files (http.lua, json.lua, startup.lua)
    expect(validation.resolvedFiles).toHaveLength(3);

    // Verify glob pattern resolution
    const apiFiles = validation.resolvedFiles.filter((f) =>
      f.targetPath.startsWith("/apis/")
    );
    expect(apiFiles).toHaveLength(2);
    expect(apiFiles[0].computers).toEqual(["1", "2", "3"]); // network group

    // Verify multiple group resolution
    const startupFile = validation.resolvedFiles.find(
      (f) => f.targetPath === "/startup.lua"
    );
    expect(startupFile?.computers).toEqual(["1", "2", "3", "4", "5"]); // both groups
  });

  test("handles invalid computer groups", async () => {
    const config: Config = withDefaultConfig({
      sourcePath: sourceDir,
      minecraftSavePath: testSaveDir,
      files: [
        {
          source: "program.lua",
          target: "/program.lua",
          computers: "nonexistent_group",
        },
      ],
    });

    const computers = [
      {
        id: "1",
        path: computersDir,
        shortPath: getComputerShortPath(testSaveName, "1"),
      },
    ];
    const validation = await validateFileSync(config, computers);

    expect(validation.errors).toHaveLength(1);
    expect(validation.errors[0]).toContain("nonexistent_group");
  });

  test("handles mixed computer IDs and groups", async () => {
    const config: Config = withDefaultConfig({
      sourcePath: sourceDir,
      minecraftSavePath: testSaveDir,
      computerGroups: {
        network: {
          name: "Network Computers",
          computers: ["1", "2"],
        },
      },
      files: [
        {
          source: "program.lua",
          target: "/program.lua",
          computers: ["network", "3"], // Mix of group and direct ID
        },
      ],
    });

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
    ];

    const validation = await validateFileSync(config, computers);

    const programFile = validation.resolvedFiles[0];
    expect(programFile.computers).toEqual(["1", "2", "3"]);
  });
});
