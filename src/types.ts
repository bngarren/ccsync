
export enum SyncMode {
    MANUAL = "manual",
    WATCH = "watch"
} 

// Base interface for file sync configuration in .ccsync.yaml
export interface FileSyncRule {
  source: string; // Glob pattern relative to sourcePath
  target: string; // Target path on computer
  computers?: string[]; // Array of computer IDs or group names
}

// Represents a resolved file that matches a sync rule
export interface ResolvedFile {
  sourcePath: string; // Absolute path to source file
  targetPath: string; // Relative path on computer
  computers: string[]; // Resolved list of computer IDs (not group names)
}

// Represents a computer in the Minecraft save
export interface Computer {
  id: string;
  path: string;
  shortPath: string;
}

// New validation result type
export interface SyncValidation {
  resolvedFiles: ResolvedFile[];
  targetComputers: Computer[];
  missingComputerIds: string[];
  errors: string[];
}
