# Structure

```text
packages/
  core/          byte buffers, patch engine, relocation, verification
  adapter-wad/   record layouts, WAD parsing and export, geometry, fixtures
  cli/           inspect, plan, apply, revert, export
  mcp-server/    MCP tools
  workbench/     Vue 3 web app
patches/         example patches
docs/            design and planning documents
```

Dependencies point one way: `workbench`, `cli`, and `mcp-server` depend on `adapter-wad`, which depends on `core`. `core` knows nothing about WAD.

`.kiro/specs/` holds Kiro feature specs only. Product code must not read from `.kiro`.

Keep `README.md` user-facing. Do not put progress, task lists, or internal decisions in it.

When a spec, hook, or property test changes the course of development, add the real event to `docs/kiro-usage.md`.
