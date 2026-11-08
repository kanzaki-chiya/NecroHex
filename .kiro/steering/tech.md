# Tech

- TypeScript in strict mode, in a pnpm workspace.
- Vue 3, Vite, and Canvas 2D for the workbench. Parsing and patching run in a Web Worker.
- vitest and fast-check for tests.
- The official MCP TypeScript SDK for the MCP server, unless a concrete problem requires another choice.

## Constraints

- `packages/core` has no DOM or Node file system dependencies.
- Work on `Uint8Array` and `DataView`. All WAD integers are little-endian.
- Record layouts come from `packages/adapter-wad/spec/wad.records.yaml`. Do not edit generated code by hand.
- Add a dependency only when it clearly saves work, and check that its license allows MIT distribution.
- Do not add GPL engine code to this repository. Run game engines as separate programs.
- Use only Freedoom or self-made data in fixtures. Never commit commercial game data.

## Checks

Run static checks, the build, and tests for the changed packages. The full test suite runs in CI.
