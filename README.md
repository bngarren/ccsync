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

  <h1 align="center">CC: Sync</h3>

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
    </li>
    <li><a href="#troubleshooting">Troubleshooting</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
  </ol>
</details>
<br>

# About The Project

CC: Sync is a command-line tool that helps you develop ComputerCraft (i.e. [CC: Tweaked](https://tweaked.cc/)) software by automatically syncing files from your development environment to computers in your Minecraft world.

# Features

- 🔄 Real-time file syncing with watch mode
- 🎮 Manual sync mode for controlled updates
- 👥 Computer groups for easy targeting
- 🌟 Glob pattern support for file selection
- ⚡ Fast and lightweight

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Getting Started

## Prerequisites
- Node.js 16.0.0+
- Minecraft with ComputerCraft/CC:Tweaked mod installed
- A Minecraft world with CC:Tweaked computers

## Installation

<details open>
<summary><b>📦 Package Managers</b></summary>

### Local Install (Recommended)
Install as a dev dependency in your project:

<table>
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
<tr>
<td>bun</td>
<td>

```bash
bun add -D @bngarren/ccsync
```
</td>
</tr>
</table>

### Global Install
Install globally to use `ccsync` from anywhere:

<table>
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

```bash
pnpm add -g @bngarren/ccsync
```
</td>
</tr>
<tr>
<td>bun</td>
<td>

```bash
bun add -g @bngarren/ccsync
```
</td>
</tr>
</table>

</details>

> **Note**: Node.js 16.0.0 or higher is required

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Usage

## Quick Start

### 1. Navigate to your ComputerCraft project:

```sh
cd my-cc-project
```

### 2. Initialize CC: Sync:

Run CC: Sync once to automatically generate a config file

```sh
npx @bngarren/ccsync
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

### 4. Run CC: Sync:

```sh
npx @bngarren/ccsync
```

## Modes

- **Manual mode**: you trigger when the files are synced (i.e. copied from project to Minecraft computers)
- **Watch mode**: watches all files identified by the config's `rules` for changes and will automatically re-sync. Leave it running in a shell while you code 😎

## Configuration
The config for CC: Sync is a `.ccsync.yaml` file in your project root. If no file is present, running the CLI will generate a default config file.

### Basic Options

- **sourceRoot**: Directory containing your source files (relative to the location of the `.ccsync.yaml` file)
- **minecraftSavePath**: Path to your Minecraft save directory. See [Where is my Minecraft save?](#where-is-my-minecraft-save)
- **computerGroups**: Define groups of computers for easier targeting
- **rules**: Array of file → computer(s) sync rules. Each sync rule requires:
  - **source**: File or glob pattern to sync (relative to *sourceRoot*)
  - **target**: Destination path on the computer
  - **computers**: Computer IDs or group names to sync to

### Advanced Options
These shouldn't need to be modified--mostly for debugging and performance.

- **verbose**: Enable detailed logging
- **cache_ttl**: Cache duration in milliseconds

### Where is my Minecraft save?
Below are some common places to look based on your operating system. However, if you use a custom launcher, then you will need to check where it stores the saves.

- **Windows**: ~/AppData/Roaming/.minecraft/saves/world_name
- **Linux**: ~/.minecraft/saves/world_name
- **macOS**: ~/Library/Application Support/minecraft/saves/world_name

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Troubleshooting

### Problem: No Computers Found

If CC: Sync can't find your computers:

- Verify the save path in .ccsync.yaml
- Ensure computers exist in-game and are loaded
- Try creating a file on the computer in-game
- Check file permissions on the save directory

### Problem: Files Not Syncing

- Verify file paths in sync rules
- Check that source files exist
- Ensure target computers are specified correctly
- Run with verbose: true for detailed logs

<p align="right">(<a href="#readme-top">back to top</a>)</p>

# Contributing

If you have a suggestion that would make this better, please fork the repo and create a pull request. You can also simply open an issue with the tag "enhancement". Don't forget to give the project a ⭐️! Thanks again!

1. Fork the Project
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
