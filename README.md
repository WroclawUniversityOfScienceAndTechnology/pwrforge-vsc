# Pwrforge VS Code Extension

VS Code integration for `pwrforge` workflows (setup, build/test/check/fix, project generation, docker/flash/monitor helpers) with a shared Python virtual environment.

## What This Extension Does

- Adds a dedicated **Pwrforge** activity-bar view with:
  - `Environment` section
  - `Actions` section
- Adds Pwrforge commands to the Command Palette.
- Runs all commands using a shared `.venv` one level above the selected project folder.
- Keeps one reusable terminal (`Pwrforge`) for command execution.

## Project Model

This extension is designed for a workspace where the workspace root contains multiple project subfolders.

Example:

```text
workspace-root/
  .venv/                <- shared environment created here
  project-a/            <- selected active project
  project-b/
```

Behavior:

- Active project is selected via `Pwrforge: Select Active Project`.
- Command execution directory is the selected project folder.
- Shared Python environment is created/used at `dirname(projectRoot)/.venv`.

## Requirements

- VS Code `>= 1.109.0`
- `python3.12` available in PATH
- Docker installed for docker-related workflows
- Workspace opened at a folder that contains project subfolders

## Quick Start

1. Open your workspace root.
2. Run `Pwrforge: Select Active Project`.
3. Run `Pwrforge: Setup Environment`.
4. Use `Pwrforge: Build` / `Test` / `Check` / `Fix` or the tree view actions.

## Command Reference

### Core commands

- `Pwrforge: Select Active Project`
  - Choose which project subfolder is active.
- `Pwrforge: Setup Environment`
  - Ensures shared `.venv` exists.
  - Installs `pwrforge` into shared `.venv` if missing.
  - Checks Docker and can trigger install command guidance.
- `Pwrforge: Refresh View`
  - Refreshes the tree view and status bar.
- `Pwrforge: Docker doctor`
  - Runs Docker availability diagnostics.

### Build and quality commands

- `Pwrforge: Build`
- `Pwrforge: Test`
- `Pwrforge: Check`
- `Pwrforge: Fix`
- `Pwrforge: Clean`
- `Pwrforge: Run`
- `Pwrforge: Debug`
- `Pwrforge: Doc`
- `Pwrforge: Update`
- `Pwrforge: Publish`
- `Pwrforge: License Check`
- `Pwrforge: Version`

Note: Commands that require initialized project state verify `pwrforge.lock`. If missing, extension offers `pwrforge update`.

### Interactive commands

- `Pwrforge: New…`
  - Prompts for `PROJECT_NAME`
  - Prompts Docker mode and optional target
  - Passes `--base-dir` for the active project parent
- `Pwrforge: Monitor`
  - Prompts required serial `--port`
  - Optional `--baudrate`
  - Passes `--base-dir`
- `Pwrforge: Gen`
  - Guided mode selection for options like:
    - `--profile`
    - `--unit-test`
    - `--mock`
    - cert generation (`--certs`, optional `--type`, `--in`, `--passwd`)
    - `--fs`
    - `--bin`
  - Passes `--base-dir`
- `Pwrforge: Docker…`
  - Prompts subcommand:
    - `build`
    - `exec`
    - `run`
- `Pwrforge: Flash`
  - Prompts for profile/target/port and optional flags:
    - `--app` / `--fs`
    - `--no-erase`
    - `--bank`
  - Passes `--base-dir`
- `Pwrforge: More…`
  - Quick picker for common commands.

## UI Integration

- Activity bar container: `Pwrforge`
- View: `Actions`
- View title shortcuts: Build, Test, Check, Fix, More
- Explorer context menu: Build, Test, Check, Fix

## Notes

- The extension runs commands via the shared `.venv` executable path directly, not global `pwrforge` from shell.
- The extension terminal on Linux uses `bash --noprofile --norc` to avoid noise from user shell startup files.

## Development

Useful scripts:

- `npm run compile`
- `npm run watch`
- `npm run lint`
- `npm run check-types`
- `npm test`
