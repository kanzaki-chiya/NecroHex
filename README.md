# NecroHex

Semantic patches for 1990s WAD map files.

A NecroHex patch describes which objects to change and how, not which bytes to overwrite. You can review it before it is written, revert it afterward, replay it on an updated map, and reuse it on other maps. AI agents use the same patch layer and never get raw byte access.

NecroHex is tested against [Freedoom](https://freedoom.github.io/) and is an independent project.

## Command line

Requires Node.js 24 and pnpm. Run `pnpm install`, then from the repository root:

```text
node packages/cli/src/main.ts inspect <wad>
node packages/cli/src/main.ts query  <wad> --select '{"record":"Thing","where":{"type":{"eq":1}}}'
node packages/cli/src/main.ts plan   <wad> <patch.json>
node packages/cli/src/main.ts apply  <wad> <patch.json> <out.wad> [--full <patched.wad>] [--plan-id <id>]
node packages/cli/src/main.ts revert <patched.wad> <receipt.json> <restored.wad>
node packages/cli/src/main.ts verify <wad> <out.wad> <receipt.json> [--iwad <iwad>]
```

Add `--json` for machine-readable output. Exit codes: 0 success, 1 patch rejected or verification failed or incomplete, 2 usage error. File paths must be inside the workspace (`NECROHEX_WORKSPACE`, default: the current directory), and outputs are never written over an existing file. `verify` runs the engine smoke test only when `NECROHEX_ENGINE` points to a DSDA-Doom executable; without it the result is "incomplete", not a pass.

## MCP server

`packages/mcp-server` is a stdio MCP server with five tools: `inspect_wad`, `query_entities`, `plan_patch`, `apply_patch` and `verify_output`. `apply_patch` needs the `planId` returned by `plan_patch` and refuses if the patch or the input changed. There is no tool that writes raw bytes. To use it in Kiro, copy `packages/mcp-server/mcp.example.json` to `.kiro/settings/mcp.json`.

Passing checks only tell you what was checked. They do not mean a map can be finished.

## Documentation

See the [documentation index](docs/README.md).

## License

[MIT](LICENSE)
