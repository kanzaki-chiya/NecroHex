# Fixtures

`freedoom/freedoom2-map01-02.wad` is a PWAD cut from Freedoom 0.13.0 `freedoom2.wad`. It holds PLAYPAL, ENDOOM, and the full MAP01 and MAP02 scopes, copied byte for byte. Freedoom is distributed under a BSD license; see `freedoom/COPYING.txt`.

Rebuild it from a full release:

```text
node scripts/make-freedoom-fixture.ts fixtures/cache/freedoom2.wad fixtures/freedoom/freedoom2-map01-02.wad
```

`cache/` is git-ignored. Put full `freedoom1.wad` and `freedoom2.wad` there to run the extra whole-file round-trip tests; they are skipped when the files are absent. Never put commercial game data in this directory.
