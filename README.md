<a id="readme-top"></a>

[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![project_license][license-shield]][license-url]

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <a href="https://github.com/bngarren/ccsync">
    <img src="assets/icon.svg" alt="Logo" width="150" height="150">
  </a>

  <h1 align="center">CC: Sync</h1>

</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#features">Features</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#installation">Installation</a></li>
      </ul>
    </li>
    <li>
      <a href="#usage">Usage</a>
      <ul>
        <li><a href="#quick-start">Quick Start</a></li>
      </ul>
      <ul>
        <li><a href="#modes">Modes</a></li>
      </ul>
      <ul>
        <li><a href="#configuration">Configuration</a></li>
      </ul>
      <ul>
        <li><a href="#cli-usage">CLI Usage</a></li>
      </ul>
    </li>
    <li><a href="#troubleshooting">Troubleshooting</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
  </ol>
</details>
<br>

# About The Project

CC: Sync is a command-line tool that helps you develop ComputerCraft (i.e. [CC: Tweaked](https://tweaked.cc/)) software by automatically syncing files from your development environment to computers in your Minecraft world.

It's a ***simple*** as:
1. Choose your source file(s) (what you want copied)
2. Choose your computer(s) (where you want them copied)
3. Run CC: Sync to keep them synced!

<br>
<img src="assets/CCSyncWatchMode-1.0.0-beta.4.png" />

## Why?
- Are you tired of manually copying files to each Minecraft computer after every change?
- Do you want to avoid developing your code inside of a Minecraft save?
- Do you want your keep your code physically distinct from the in-game files?

If any of these describe you, CC: Sync may help!

# Features

- 📃 Simple YAML config file
- 🔄 Manual mode for controlled updates
- 👀 Watch mode for continuous syncing
- 👥 Computer groups for easy targeting
- 🌟 Glob pattern support for file selection
- ⚡ Fast and lightweight

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Getting Started

## Prerequisites
- Node.js 18.0.0+
- Minecraft with ComputerCraft/CC:Tweaked mod installed
- A Minecraft world with CC:Tweaked computers

## Installation

### Package runners
Try it out without permanent installation!

<sub>Bun</sub>
```bash
bunx @bngarren/ccsync
```

<sub>Npm</sub>
```bash
npx @bngarren/ccsync
```

### Global Install (recommended)
Install globally to use `ccsync` from anywhere:

<table>
<tr>
<td>bun</td>
<td>

```bash
bun add -g @bngarren/ccsync
```
</td>
</tr>
<tr>
<td>npm</td>
<td>

```bash
npm install -g @bngarren/ccsync
```
</td>
</tr>
<tr>
<td>pnpm</td>
<td>

```bashs
pnpm add -g @bngarren/ccsync
```
</td>
</tr>
</table>

<details closed>
<summary>Local Install</summary>
Install as a dev dependency in your project:

<table>
<tr>
<td>bun</td>
<td>

```bash
bun add -D @bngarren/ccsync
```
</td>
</tr>
<tr>
<td>npm</td>
<td>

```bash
npm install -D @bngarren/ccsync
```
</td>
</tr>
<tr>
<td>pnpm</td>
<td>

```bash 
pnpm add -D @bngarren/ccsync
```
</td>
</tr>

</table>
</details>
<br>

> **Note**: Node.js 18 or higher is required

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Usage

## Quick Start

### 1. Navigate to your ComputerCraft project:

```sh
cd my-cc-project
```

### 2. Run CC: Sync:

If no configuration file exists, CC: Sync will automatically generate one.

If installed globally, run with:
```bash
ccsync
```
or
```bash
bunx @bngarren/ccsync
```
```bash
npx @bngarren/ccsync
```

#### To generate the config file only:
```bash
ccsync init
```

### 3. Edit the generated `.ccsync.yaml` configuration file:

#### Basic Example
```yaml
sourceRoot: "./src"
minecraftSavePath: "~/minecraft/saves/my_world"

computerGroups:
  monitors:
    name: "Monitor Network"
    computers: ["1", "2", "3"]

rules:
  - source: "startup.lua"
    target: "startup.lua"
    computers: ["0"]

  - source: "lib/*.lua"
    target: "lib/"
    computers: "monitors" 
```

<details>

<summary>Nested Computer Groups Example</summary>

```yaml
# ...same as above

computerGroups:
  base:
    name: "Base"
    computers: ["monitors", "servers", "clients"]
  monitors:
    name: "Monitors"
    computers: ["1"]
  servers:
    name: "Servers"
    computers: ["2","4"]
  clients:
    name: "Clients"
    computers: ["3","5"]

rules:
# Ensure that all computers get updated lib
  - source: "lib/*.lua"
    target: "lib/"
    computers: ["base"] # expands to computers 1, 2, 3, 4, 5

# All "monitor" computers get startup.lua in their root dir
  - source: "monitor/startup.lua"
    target: "/" # or ""
    computers: "monitors"  # expands to computer 1

# Both "servers" and "clients" computers get networking code
  - source: "networking/*.lua"
    target: "networking/"
    computers: ["servers", "clients"] # expands to computers 2, 3, 4, 5
```
</details>

### 4. Run CC: Sync:
See Step 2

## Modes
The program can operate in two modes, depending on the level of control you desire:

- **Manual mode**: you trigger when the files are synced (i.e. copied from project to Minecraft computers)

- **Watch mode**: watches all files identified by the config's `rules` for changes and will automatically re-sync. Leave it running in a shell while you code 😎

<br>

> Warning: At this time, any files added to the source directory AFTER the program has started will not be recognized or synced, even if they would be matched by file name or glob pattern. Restart the program for these files to sync.<br><br>
> Similarly, any files renamed, moved, or deleted AFTER the program has started will no longer be recognized or synced. Restart the program for these files to sync.

## Configuration
The config for CC: Sync is a `.ccsync.yaml` file in your project root. If no file is present, running the CLI will generate a default config file.

### Basic Options

| Key               | Description                                                                                                     |
|-------------------|-----------------------------------------------------------------------------------------------------------------|
| `sourceRoot`      | Directory containing your source files (absolute path or relative to the location of the `.ccsync.yaml` file). |
| `minecraftSavePath` | Absolute path to your Minecraft save directory. See below: [Where is my Minecraft save?](#where-is-my-minecraft-save). This is the folder containing 'level.dat', 'session.lock', etc. |
| `computerGroups`  | Define groups of computers for easier targeting. A computer group can reference exact computer IDs or other groups. |
| `rules`           | The _sync rules_ define which file(s) go to which computer(s). Each sync rule ***requires***:                          |
|                   |  - `source`: File name or glob pattern (relative to `sourceRoot`).                                              |
|                   |  - `target`: Destination path on the computer (relative to the root directory of the computer).                |
|                   |  - `computers`: Computer IDs or group names to sync to. 
|                   | The following fields are ***optional***:
|                   |  - `flatten` (default true): Whether the matched source files should be flattened into the target directory. If a recursive glob pattern (e.g., **/*.lua) is used and `flatten` is false, the source directory structure will be preserved in the target directory.
<br>

> You should use forward slashes (/) in paths, even on Windows:<br> 
> `"C:/Users/name/path"`<br>
> Otherwise, backslashes need to be properly escaped:<br>
> `"C:\\Users\\name\\path"`

### Advanced Options
These shouldn't need to be modified—mostly for debugging and performance.
| Key               | Description |
|-------------------|-----------------------------------------------------------------------------------------------------------------|
| `logToFile`      | Default: false. Enable logging to file.   |
| `logLevel`      | Default: 'debug'. Options: 'silent', 'trace', 'debug', 'info', 'warn', 'error', 'fatal' |
| `cacheTTL`      | Default: 5000. Cache duration in milliseconds. This reduces how many times the source/target parameters must be validated on quick, repetitive re-syncs. |
| `usePolling`  | Default: false. If true, will use a polling-based strategy during watch mode rather than native operating system events (default). Consider using polling if watch mode is missing file changes. Polling _may_ result in higher CPU usage (but likely only significant with a large number of watched files)

> Note: Log files are written to a log directory depending on the operating system:<br>
> - Windows: `%USER%\AppData\Local\ccsync\logs`
> - macOS: `~/Library/Logs/ccsync`
> - Linux/Unix: `~/.local/share/ccsync/logs`

## CLI Usage

```
Usage: ccsync [COMMAND] [OPTIONS]

Commands:
  ccsync                         - run the program  [default]
  ccsync init                    - initialize a new config (or overwrite current)
  ccsync computers <SUBCOMMAND>  - computer related commands   
                    find           - identify Minecraft computers in the current save directory
                    clear [ids..]  - clear the contents of Minecraft computers

Options:
  -v, --verbose    run with verbose output (for debugging)  [boolean]
  -f, --logToFile  log to file (overrides config)  [boolean]
  -l, --logLevel   log level (overrides config)  [string] [choices: "silent", "trace", "debug", "info", "warn", "error", "fatal"]
  -V, --version    Show version number  [boolean]
  -h, --help       Show help  [boolean]
```


### Where is my Minecraft save?
Below are some common places to look based on your operating system. However, if you use a custom launcher, then you will need to check where it stores the saves.

- **Windows**: ~/AppData/Roaming/.minecraft/saves/world_name
- **Linux**: ~/.minecraft/saves/world_name
- **macOS**: ~/Library/Application Support/minecraft/saves/world_name

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Troubleshooting

### Problem: No Computers Found
- Verify the save path in .ccsync.yaml
- Ensure computers exist in-game and are loaded
- Try creating a file on the computer in-game
- Check file permissions on the save directory

### Problem: Files Not Syncing
- Verify file paths in sync rules
- Check that source files exist
- Ensure target computers are specified correctly. Remember that you must use the computer's **ID** not the _label_.
- Run with `logToFile` true and check the log for errors

### Problem: Watch mode is missing file changes
- Ensure that the sync rule's `source` specifies an correct file name and/or correct glob pattern
- Run with `logToFile` true and check the log for errors
- Try running with `usePolling` true

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Contributing

If you have a suggestion that would make this better, please create a pull request. You can also simply open an issue with the tag "enhancement". Don't forget to give the project a ⭐️! Thanks again!

1. Fork/clone the project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# License

MIT License. See `LICENSE.txt` for more information.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->
<!-- https://www.markdownguide.org/basic-syntax/#reference-style-links -->
[contributors-shield]: https://img.shields.io/github/contributors/bngarren/ccsync.svg?style=for-the-badge
[contributors-url]: https://github.com/bngarren/ccsync/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/bngarren/ccsync.svg?style=for-the-badge
[forks-url]: https://github.com/bngarren/ccsync/network/members
[stars-shield]: https://img.shields.io/github/stars/bngarren/ccsync.svg?style=for-the-badge
[stars-url]: https://github.com/bngarren/ccsync/stargazers
[issues-shield]: https://img.shields.io/github/issues/bngarren/ccsync.svg?style=for-the-badge
[issues-url]: https://github.com/bngarren/ccsync/issues
[license-shield]: https://img.shields.io/github/license/bngarren/ccsync.svg?style=for-the-badge
[license-url]: https://github.com/bngarren/ccsync/blob/master/LICENSE.txt
