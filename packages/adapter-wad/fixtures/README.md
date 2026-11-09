# Fixtures

`freedoom/freedoom2-map01-02.wad` is a PWAD cut from Freedoom 0.13.0 `freedoom2.wad`. It holds PLAYPAL, ENDOOM, and the full MAP01 and MAP02 scopes, copied byte for byte. Freedoom is distributed under a BSD license; see `freedoom/COPYING.txt`.

Rebuild it from a full release:

```text
node scripts/make-freedoom-fixture.ts fixtures/cache/freedoom2.wad fixtures/freedoom/freedoom2-map01-02.wad
```

`cache/` is git-ignored. Put full `freedoom1.wad` and `freedoom2.wad` there to run the extra whole-file round-trip tests; they are skipped when the files are absent. Never put commercial game data in this directory.

## Cross-version relocation report

`docs/relocation-report.md` replays a patch on two Freedoom releases. Download `freedoom-0.12.1.zip` and `freedoom-0.13.0.zip` from the [Freedoom releases](https://github.com/freedoom/freedoom/releases), unpack `freedoom2.wad` from each into `cache/freedoom-<version>/`, then run from `packages/adapter-wad`:

```text
node scripts/relocation-report.ts fixtures/cache/freedoom-0.12.1/freedoom2.wad 0.12.1 fixtures/cache/freedoom-0.13.0/freedoom2.wad 0.13.0 ../../patches/haunted-house.nhpatch.json ../../docs/relocation-report.md
```

To get the fingerprint of a sector for a `pin`:

```text
node scripts/fingerprint.ts <file.wad> MAP01 0
```

## Engine smoke test

`test/engine-smoke.test.ts` loads an exported PWAD in [DSDA-Doom](https://github.com/dsda-org/dsda-doom) and plays a generated idle demo on the target map. DSDA-Doom is GPL software, so it is not part of this repository. Install it anywhere outside the repository, then point `NECROHEX_ENGINE` at the executable:

```text
$env:NECROHEX_ENGINE = "C:\path\to\dsda-doom.exe"
pnpm --filter @necrohex/adapter-wad test
```

The test also needs `cache/freedoom2.wad`. Without either, it is skipped. To check a single PWAD by hand:

```text
node scripts/engine-smoke.ts <dsda-doom.exe> fixtures/cache/freedoom2.wad <file.wad> MAP01
```

A pass means the engine loaded the PWAD, ran the requested number of tics on that map, and exited normally. It does not mean the map can be finished.
