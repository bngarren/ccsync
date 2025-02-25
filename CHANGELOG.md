# Changelog

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
