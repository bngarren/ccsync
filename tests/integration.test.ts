import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs/promises";
import path from "path";
import { loadConfig } from "../src/config";
import { SyncManager } from "../src/sync";
import {
  TempCleaner,
  createUniqueTempDir,
  createTestSave,
  createTestFiles,
} from "./test-helpers";

describe("Integration: SyncManager", () => {
  let tempDir: string;
  let sourceDir: string;
  let savePath: string;
  let computersDir: string;

  const cleanup = TempCleaner.getInstance();

  beforeEach(async () => {
    tempDir = createUniqueTempDir();
    cleanup.add(tempDir);

    sourceDir = path.join(tempDir, "src");
    savePath = path.join(tempDir, "mc/saves/test_world");
    computersDir = path.join(savePath, "computercraft/computer");

    // Setup test environment
    await createTestSave(savePath);
    await createTestFiles(sourceDir);
  });

  afterEach(async () => {
    await cleanup.cleanDir(tempDir);
  });

  test("performs manual sync", async () => {
    const configPath = path.join(tempDir, ".ccsync.yaml");
    const configContent = `
  sourcePath: "${sourceDir}"
  minecraftSavePath: "${savePath}"
  files:
    - source: "program.lua"
      target: "/program.lua"
      computers: ["1"]
  `;
    await fs.writeFile(configPath, configContent);
    await fs.mkdir(path.join(computersDir, "1"), { recursive: true });

    const config = await loadConfig(configPath);
    const syncManager = new SyncManager(config);

    // Mock process.stdin
    const originalStdin = process.stdin;
    const mockStdin = {
      isTTY: true,
      setRawMode: () => {},
      setEncoding: () => {},
      on: () => {},
      removeListener: () => {},
      removeAllListeners: () => {},
      pause: () => {},
      resume: () => {},
    };
    process.stdin = mockStdin as any;

    // Run sync and terminate after first cycle
    setTimeout(() => syncManager.cleanup(), 100);
    await syncManager.manualMode();

    // Restore stdin
    process.stdin = originalStdin;

    const targetFile = path.join(computersDir, "1", "program.lua");
    expect(await fs.exists(targetFile)).toBe(true);
  });

  test.skip("watch mode syncs on file changes", async () => {
    const configPath = path.join(tempDir, ".ccsync.yaml");
    const configContent = `
  sourcePath: "${sourceDir}"
  minecraftSavePath: "${savePath}"
  files:
    - source: "*.lua"
      target: "/"
      computers: ["1", "2"]
  `;
    await fs.writeFile(configPath, configContent);
    await fs.mkdir(path.join(computersDir, "1"), { recursive: true });
    await fs.mkdir(path.join(computersDir, "2"), { recursive: true });

    const config = await loadConfig(configPath);
    const syncManager = new SyncManager(config);

    // Start watch mode
    await syncManager.startWatching();

    // Create new file after watch starts
    const newFilePath = path.join(sourceDir, "newfile.lua");
    await fs.writeFile(newFilePath, "print('new')");

    // Give watcher time to process
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify file was copied to both computers
    expect(await fs.exists(path.join(computersDir, "1", "newfile.lua"))).toBe(
      true
    );
    expect(await fs.exists(path.join(computersDir, "2", "newfile.lua"))).toBe(
      true
    );
  });
});
