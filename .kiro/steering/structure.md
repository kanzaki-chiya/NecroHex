# Structure

```text
packages/
  core/          byte buffers, patch engine, relocation, verification
  adapter-wad/   record layouts, WAD parsing and PWAD export, geometry and fingerprints, fixtures
  cli/           inspect, query, plan, apply, revert, verify (engine smoke test)
  mcp-server/    MCP tools over stdio
  web/           workbench: Vite + Vue 3 web app
patches/         example patches
docs/            design and planning documents, workbench mockup
out/             local output, git-ignored
```

Dependencies point one way: `web` and `cli` depend on `adapter-wad`, which depends on `core`. `mcp-server` depends on `cli` and `adapter-wad`. `core` knows nothing about WAD.

`.kiro/specs/` holds Kiro feature specs only. Product code must not read from `.kiro`.

Keep `README.md` user-facing. Do not put progress, task lists, or internal decisions in it.

When a spec, hook, or property test changes the course of development, add the real event to `docs/kiro-usage.md`.
