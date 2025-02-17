# CC:Sync

CC:Sync is a command-line tool that helps you develop ComputerCraft programs by automatically syncing files from your development environment to computers in your Minecraft world.

## Features

- 🔄 Real-time file syncing with watch mode
- 🎮 Manual sync mode for controlled updates
- 👥 Computer groups for easy targeting
- 🌟 Glob pattern support for file selection
- ⚡ Fast and lightweight

## Installation
TODO

## Quick Start

### 1. Create a new directory for your ComputerCraft project:
```bash
mkdir my-cc-project
cd my-cc-project
```

### 2. Initialize CC:Sync configuration:

Run CC:Sync once to automatically generate a config file

### 3. Edit the generated `.ccsync.yaml` configuration file:
```yaml
sourcePath: "./src"
minecraftSavePath: "~/minecraft/saves/my_world"

computerGroups:
  monitors:
    name: "Monitor Network"
    computers: ["1", "2", "3"]

files:
  - source: "startup.lua"
    target: "startup.lua"
    computers: ["0"]
  
  - source: "lib/*.lua"
    target: "lib/"
    computers: "monitors"
```

### 4. Run CC:Sync:
```bash
ccsync
```

## Configuration
### Basic Options
- sourcePath: Directory containing your source files
- minecraftSavePath: Path to your Minecraft save directory
- computerGroups: Define groups of computers for easier targeting
- files: Array of file → computer(s) sync rules

Each sync rule requires:
- source: File or glob pattern to sync (relative to sourcePath)
- target: Destination path on the computer
- computers: Computer IDs or group names to sync to

### Advanced Options
- verbose: Enable detailed logging
- cache_ttl: Cache duration in milliseconds

### Common Minecraft Save Locations

- **Windows**: ~/AppData/Roaming/.minecraft/saves/world_name
- **Linux**: ~/.minecraft/saves/world_name
- **macOS**: ~/Library/Application Support/minecraft/saves/world_name

## Troubleshooting
### No Computers Found
If CC:Sync can't find your computers:
- Verify the save path in .ccsync.yaml
- Ensure computers exist in-game and are loaded
- Try creating a file on the computer in-game
- Check file permissions on the save directory

### Files Not Syncing
- Verify file paths in sync rules
- Check that source files exist
- Ensure target computers are specified correctly
- Run with verbose: true for detailed logs


## Contributing
Pull requests are welcome!

## License
MIT License