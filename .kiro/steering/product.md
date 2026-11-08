# Product

NecroHex is a semantic patch workbench for 1990s WAD map files, built for the Kiroween 2026 Resurrection category.

A patch describes which objects to change and how, not which bytes to overwrite. It can be checked before writing, reverted afterward, replayed on an updated map, and reused on other maps.

## Users

- Map and mod authors who want reviewable changes that survive upstream updates.
- Players who want to apply shared patches without a professional editor.
- Developers who let AI agents edit WAD files and need hard safety limits.

## Principles

- The patch layer is the product. AI is one client of it, and every feature must also work without AI.
- Refuse to guess. An ambiguous target is a conflict, not a best effort.
- Report what was checked. Never claim that a map is guaranteed to be playable.
- WAD is the only supported format. Do not add generic framework layers or a second format.

## Out of scope

Geometry changes, BSP rebuilding, texture and audio parsing, COLORMAP editing, LINEDEFS and SIDEDEFS writes, an embedded game engine, and LLM calls in the web workbench.

The full design is in `docs/design.md`.
