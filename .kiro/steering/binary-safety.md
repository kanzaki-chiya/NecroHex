---
inclusion: always
---

# Binary safety

These rules are the core of the product. Do not weaken them to make a feature or test pass.

- Without changes, serialization must be byte-identical to the input.
- Patches change only the byte spans listed in the receipt.
- Keep unknown lumps, gap bytes, and raw name bytes untouched.
- MCP tools and public APIs must never accept raw offsets and bytes for writing.
- Never overwrite the source file.
- Validate new values only. Parsing must not reject unusual historical data.
- Never guess between similar relocation candidates. Return `CONFLICT_AMBIGUOUS`.
- A PWAD that changes a map must include the map marker and all of that map's data lumps.

## Default protections

Reject these changes unless the patch explicitly opts in:

- Replacing player starts (1–4, 11), teleport destinations (14), or keys (5, 6, 13, 38, 39, 40).
- Replacing boss types that a map depends on.
- Overwriting a nonzero sector `special`.

Warn when a replacement monster is larger than the original, or when a change alters the height of a tagged or trigger-linked sector.

## Tests

Every change to parsing, patching, or export must keep the properties in section 10 of `docs/design.md` passing, on both generated data and a real Freedoom fixture. When a property test finds a bug, keep the failing case as a regression test.
