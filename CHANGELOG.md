# Changelog

## [1.0.0-beta.4](https://github.com/bngarren/ccsync/compare/v1.0.0-beta.3...v1.0.0-beta.4) (2025-03-12)


### Features

* **performance:** added node-cache and incorporated caching in processPath. Should lessen the amount of string operations, especially with lots of matched files ([#30](https://github.com/bngarren/ccsync/issues/30)) ([c6c3f49](https://github.com/bngarren/ccsync/commit/c6c3f49962635ef84892f919b0223d4f99eb7a02))


### Bug Fixes

* **build:** added bun-plugin-pino to help bundle pino's dependencies ([#42](https://github.com/bngarren/ccsync/issues/42)). ([ac392cd](https://github.com/bngarren/ccsync/commit/ac392cdaf01eab3b0431e1cc3e9184fa636ea129))
* **log:** add error handling to initializeLogger so that errors aren't fatal exceptions ([1b74da0](https://github.com/bngarren/ccsync/commit/1b74da01ecb3a51fc7b8aed84be31d9b2f4ce411))
* **log:** added detailed log output after uncaught fatal exception ([#34](https://github.com/bngarren/ccsync/issues/34)) ([511b939](https://github.com/bngarren/ccsync/commit/511b939d24d29542874ea1855591317184cbe9fa))
* **log:** added error handling to logger initialization so that errors aren't fatal exceptions, if possible ([bac77d1](https://github.com/bngarren/ccsync/commit/bac77d166dc5d72cc064bf4eceb0ca65cce45a01))
* **log:** fixes [#36](https://github.com/bngarren/ccsync/issues/36), error with symlink creation in environments that it's not allowed ([bac77d1](https://github.com/bngarren/ccsync/commit/bac77d166dc5d72cc064bf4eceb0ca65cce45a01))
* **paths:** more improvements to path handling and consistency, added various edge cases to tests ([#29](https://github.com/bngarren/ccsync/issues/29)) ([e50e9ef](https://github.com/bngarren/ccsync/commit/e50e9ef2b52b623fb1413fcbd42e9c39b0c17e8c))
* **sync:** fixed errors not being emitted correctly when errors accumulated in performSync ([ec95303](https://github.com/bngarren/ccsync/commit/ec953038044db732ba28327bc2a55544be6bcbf0))
* **ui:** fixed bug causing current sync mode not to show in the header ([3c6bfe0](https://github.com/bngarren/ccsync/commit/3c6bfe0fbfcb88f91ae30586860dc6f6371a0b13))
* **ui:** improved how config validation errors are formatted/presented. Improve UI ([#35](https://github.com/bngarren/ccsync/issues/35)) ([3c6bfe0](https://github.com/bngarren/ccsync/commit/3c6bfe0fbfcb88f91ae30586860dc6f6371a0b13))


### Performance Improvements

* **utils:** performance improvements in utils ([c6c3f49](https://github.com/bngarren/ccsync/commit/c6c3f49962635ef84892f919b0223d4f99eb7a02))


### Miscellaneous Chores

* release as 1.0.0-beta.4 ([7944f6d](https://github.com/bngarren/ccsync/commit/7944f6de149ecaad6af8204b2b5d190821098d0f))

## [1.0.0-beta.3](https://github.com/bngarren/ccsync/compare/v1.0.0-beta.2...v1.0.0-beta.3) (2025-03-06)


### ⚠ BREAKING CHANGES

* **config:** updated config to version 2.0 given the removal of the "verbose" option and addition of log options. Updated  the default config to include these new options.

### Features

* **log:** Added pino logging support with pino-roll for rotation. Log to file and log level options added to config. ([7a8d749](https://github.com/bngarren/ccsync/commit/7a8d749f0973adb244f4a1f4c8729f2ff1b1e463))
* **sync:** added a 'usePolling' option to the config (advanced). This bumps config VERSION to 2.1 ([322de00](https://github.com/bngarren/ccsync/commit/322de007e135ae8ca196cf99e7c54dc2b8ea3046))
* **sync:** adds batch processing with debouncing to watch mode so that multiple files changed at once or in quick succession are processed more efficiently ([#23](https://github.com/bngarren/ccsync/issues/23)) ([322de00](https://github.com/bngarren/ccsync/commit/322de007e135ae8ca196cf99e7c54dc2b8ea3046))
* **workflow:** add a version.ts file that can be bundled with code ([89e891c](https://github.com/bngarren/ccsync/commit/89e891cb39d132926e71efa34a3d1779c93cc2bf))
* **workflow:** add version-check ([#17](https://github.com/bngarren/ccsync/issues/17)) that verifies that package.json, version.ts, and latest git tag (if applicable) match prior to pull request. ([89e891c](https://github.com/bngarren/ccsync/commit/89e891cb39d132926e71efa34a3d1779c93cc2bf))


### Bug Fixes

* **config:** updated config to version 2.0 given the removal of the "verbose" option and addition of log options. Updated  the default config to include these new options. ([7a8d749](https://github.com/bngarren/ccsync/commit/7a8d749f0973adb244f4a1f4c8729f2ff1b1e463))
* **log:** logs added throughout main code, using child loggers to categorize by component ([7a8d749](https://github.com/bngarren/ccsync/commit/7a8d749f0973adb244f4a1f4c8729f2ff1b1e463))
* **script:** updated watch-log.sh to allow a file name to be passed so that this file is tailed rather than current.log ([322de00](https://github.com/bngarren/ccsync/commit/322de007e135ae8ca196cf99e7c54dc2b8ea3046))
* **sync:** add UI warnings when a watched file is renamed or deleted (will no longer be watched until mode is restarted) ([322de00](https://github.com/bngarren/ccsync/commit/322de007e135ae8ca196cf99e7c54dc2b8ea3046))
* **sync:** chokidar watcher will use polling strategy if process.env.CI is 'true' so that tests can pass in CI ([322de00](https://github.com/bngarren/ccsync/commit/322de007e135ae8ca196cf99e7c54dc2b8ea3046))
* **sync:** fixed bug where missing computers were not resulting in correct sync status ([322de00](https://github.com/bngarren/ccsync/commit/322de007e135ae8ca196cf99e7c54dc2b8ea3046))
* **sync:** missing computers appropriately treated as warnings, added integration test for missing computer scenario ([322de00](https://github.com/bngarren/ccsync/commit/322de007e135ae8ca196cf99e7c54dc2b8ea3046))
* **ui:** UI now uses process.stdout.write instead of console.log for terminal output ([7a8d749](https://github.com/bngarren/ccsync/commit/7a8d749f0973adb244f4a1f4c8729f2ff1b1e463))
* **utils:** improved check for 'computercraft/computer' dir within the minecraft save dir, and fixed associated test ([#20](https://github.com/bngarren/ccsync/issues/20)) ([bf3ca51](https://github.com/bngarren/ccsync/commit/bf3ca51208167847e1465acdf2390591b2707893))
* **workflow:** get release-please to automatically update version.ts ([#18](https://github.com/bngarren/ccsync/issues/18)) ([85aad90](https://github.com/bngarren/ccsync/commit/85aad9011812ed6d0117db8b43690dc15ac1c482))
* **workflow:** updated release-please workflow to correctly checkout code and use config file ([89e891c](https://github.com/bngarren/ccsync/commit/89e891cb39d132926e71efa34a3d1779c93cc2bf))


### Miscellaneous Chores

* release as 1.0.0-beta.3 ([b750add](https://github.com/bngarren/ccsync/commit/b750add4df5c781fb5ac219c172f222e39201413))

## [1.0.0-beta.2](https://github.com/bngarren/ccsync/compare/v1.0.0-beta.1...v1.0.0-beta.2) (2025-03-01)


### Features

* **ui:** Major UI update, using chalk, boxen, and log-update ([1358f3e](https://github.com/bngarren/ccsync/commit/1358f3ed32ccc5bb15e96fe90ec4070c5b6431f8))


### Bug Fixes

* **config:** downgrade config version to 1.1 (from 2.0) as it was incorrectly given a major increase ([#14](https://github.com/bngarren/ccsync/issues/14)) ([c64cd4d](https://github.com/bngarren/ccsync/commit/c64cd4d5c418a8866b95ca32cb60c0ceb0bb8e8c))
* **errors:** Improved error handling and integration with new UI ([1358f3e](https://github.com/bngarren/ccsync/commit/1358f3ed32ccc5bb15e96fe90ec4070c5b6431f8))
* **paths:** Add a resolveTargetPath utility function with extensive testing. This important function helps to resolve a rule's full target path, taking into consideration whether it represents a filename, directory, and whether flatten is false, in which case source directory structure will be preserved in the actual target path. ([1358f3e](https://github.com/bngarren/ccsync/commit/1358f3ed32ccc5bb15e96fe90ec4070c5b6431f8))
* **paths:** fixes glob * causing inclusion of directories into resolved file rule and added test ([1358f3e](https://github.com/bngarren/ccsync/commit/1358f3ed32ccc5bb15e96fe90ec4070c5b6431f8))
* **ui:** use strip-ansi in UI to clear color codes ([1358f3e](https://github.com/bngarren/ccsync/commit/1358f3ed32ccc5bb15e96fe90ec4070c5b6431f8))


### Miscellaneous Chores

* release as 1.0.0-beta.2 ([cfa6fbe](https://github.com/bngarren/ccsync/commit/cfa6fbe72c3164630f4ad2cc912fdbe3efb43193))

## [1.0.0-beta.1](https://github.com/bngarren/ccsync/compare/v1.0.0-beta...v1.0.0-beta.1) (2025-02-25)


### ⚠ BREAKING CHANGES

* **config:** The 'computers' field in a SyncRule is no longer optional.
* A recursive */ glob pattern can now be used in config.rules.source in order to glob files and preserve the relative source directory structure when copied to a target directory. Adds a 'flatten' option to Sync Rules. Default is true. If set to false, will keep source directory structure when a recursive glob pattern is used

### Features

* A recursive */ glob pattern can now be used in config.rules.source in order to glob files and preserve the relative source directory structure when copied to a target directory. Adds a 'flatten' option to Sync Rules. Default is true. If set to false, will keep source directory structure when a recursive glob pattern is used ([6631487](https://github.com/bngarren/ccsync/commit/6631487853a2091f3d613d3c9b7f8ca8ec866d8a))
* **config:** add robust config error handling with suggestions ([aa466f2](https://github.com/bngarren/ccsync/commit/aa466f2dd4dd1ba32bc3d98e4abcbd06650590d9))


### Bug Fixes

* **config:** improve withDefaultConfig helper and ensure that result from loadConfig is wrapped with this. Notably this ensures that flatten field is applied (default true) to all sync rules ([6631487](https://github.com/bngarren/ccsync/commit/6631487853a2091f3d613d3c9b7f8ca8ec866d8a))
* **config:** The 'computers' field in a SyncRule is no longer optional. ([6631487](https://github.com/bngarren/ccsync/commit/6631487853a2091f3d613d3c9b7f8ca8ec866d8a))
* **config:** various improvements to config file validation. Improved validation of computer references. Referenced groups must exist, cannot be circular, etc. Ensure paths in config actually exist/can be accessed. ([aa466f2](https://github.com/bngarren/ccsync/commit/aa466f2dd4dd1ba32bc3d98e4abcbd06650590d9))
* ensure consistent use of toSystemPath when logging/error messaging ([6631487](https://github.com/bngarren/ccsync/commit/6631487853a2091f3d613d3c9b7f8ca8ec866d8a))
* **general:** improvements to path normalization, including better handling of unix vs windows paths. Internally, paths should consistently use a normalized path (forward slashes) and then convert to an appropriate system path when interacting with the filesystem or user-facing messages ([6631487](https://github.com/bngarren/ccsync/commit/6631487853a2091f3d613d3c9b7f8ca8ec866d8a))
* **utils:** resolveComputerReferences recursively expands group names to generate a flattened list of computer IDs ([aa466f2](https://github.com/bngarren/ccsync/commit/aa466f2dd4dd1ba32bc3d98e4abcbd06650590d9))


### Miscellaneous Chores

* release as 1.0.0-beta.1 ([d223104](https://github.com/bngarren/ccsync/commit/d223104a52d198d1a31e3727362a19b295f3bcd6))

## [1.0.0-beta](https://github.com/bngarren/ccsync/compare/v1.0.0-alpha.4...v1.0.0-beta) (2025-02-22)


### Bug Fixes

* **sync:** add file permissions error handling and tests ([9b4b7ce](https://github.com/bngarren/ccsync/commit/9b4b7ce919244738c506684b0a80c83ce342872a))


### Miscellaneous Chores

* release as 1.0.0-beta ([767a26c](https://github.com/bngarren/ccsync/commit/767a26c6f92b1731cada0dd194587b063f81b931))

## [1.0.0-alpha.4](https://github.com/bngarren/ccsync/compare/v1.0.0-alpha.3...v1.0.0-alpha.4) (2025-02-21)


### ⚠ BREAKING CHANGES

* **config:** add config "version" and compatibility checking, with tests ([#3](https://github.com/bngarren/ccsync/issues/3))

### Features

* **config:** add config "version" and compatibility checking, with tests ([#3](https://github.com/bngarren/ccsync/issues/3)) ([e3024f4](https://github.com/bngarren/ccsync/commit/e3024f4728ab6344688e3003a8fedf25b12b9ffe))


### Miscellaneous Chores

* release as 1.0.0-alpha.4 ([bd74fea](https://github.com/bngarren/ccsync/commit/bd74fea05c8bc60a1f78c95a660080e18e427672))

## [1.0.0-alpha.3](https://github.com/bngarren/ccsync/compare/v1.0.0-alpha.2...v1.0.0-alpha.3) (2025-02-21)


### Miscellaneous Chores

* release 1.0.0-alpha.3 ([e5a2410](https://github.com/bngarren/ccsync/commit/e5a2410a2e5345a1f321adf27353595f9836c281))
