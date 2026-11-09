/**
 * 用两个真实的 Freedoom 发行版重放补丁，生成重定位报告（Markdown）。
 * 用法：node scripts/relocation-report.ts <old.wad> <old-version> <new.wad> <new-version> <patch.json> <report.md>
 *
 * 报告内容：
 * 1. 两个输入文件的 SHA-256，补丁目标地图在两个版本之间是否有差异。
 * 2. 补丁在两个版本上各干跑一次（planPatch，不写文件），列出每个 pin 的结果。
 * 3. 在一张有差异的地图上，把每个扇区都当作一个带指纹的 pin，跨版本重放（两个方向），统计 EXACT、RELOCATED 和冲突，
 *    并用“边界线段坐标完全相同”作为独立的对照，核对重定位是否选对。
 * 4. 全部同名地图上的同一统计。
 * 所有 pin 都经补丁引擎的 planPatch 解析，不另写一套判断。报告只写检查过什么，不声称地图可以通关。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { planPatch, RELOCATION_THRESHOLDS, type PinResolution } from "@necrohex/core";
import { CENTROID_RADIUS, createWadAdapter, FINGERPRINT_WEIGHTS, NO_INDEX, WadFile, type MapScope } from "../src/index.ts";

const args = process.argv.slice(2);
if (args.length !== 6) {
  console.error("usage: node scripts/relocation-report.ts <old.wad> <old-version> <new.wad> <new-version> <patch.json> <report.md>");
  process.exit(2);
}
const [oldPath, oldVersion, newPath, newVersion, patchPath, outPath] = args as [string, string, string, string, string, string];

interface Input {
  readonly version: string;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly wad: WadFile;
  readonly sha256: string;
}

function load(path: string, version: string): Input {
  const bytes = new Uint8Array(readFileSync(path));
  return { version, path, bytes, wad: WadFile.parse(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
}

const OLD = load(oldPath, oldVersion);
const NEW = load(newPath, newVersion);
const patch = JSON.parse(readFileSync(patchPath, "utf8")) as { name: string; target: { maps: "*" | string[] }; operations: Array<{ id: string; select: Record<string, unknown> }> };
const adapter = createWadAdapter();

const lines: string[] = [];
const out = (...l: string[]) => lines.push(...l);
const DATA = ["THINGS", "LINEDEFS", "SIDEDEFS", "VERTEXES", "SECTORS"] as const;

function lumpHash(w: WadFile, index: number | undefined): string | undefined {
  return index === undefined ? undefined : createHash("sha256").update(w.lumpBytes(index)).digest("hex");
}

function differs(name: string): { same: boolean; changed: string[] } {
  const a = OLD.wad.findMap(name);
  const b = NEW.wad.findMap(name);
  if (!a || !b) return { same: false, changed: ["(map missing)"] };
  const changed = DATA.filter((l) => lumpHash(OLD.wad, a.lumps[l]) !== lumpHash(NEW.wad, b.lumps[l]));
  return { same: changed.length === 0, changed };
}

function count(w: WadFile, m: MapScope, lump: (typeof DATA)[number]): number {
  const i = m.lumps[lump];
  if (i === undefined) return 0;
  const record = ({ THINGS: "Thing", LINEDEFS: "Linedef", SIDEDEFS: "Sidedef", VERTEXES: "Vertex", SECTORS: "Sector" } as const)[lump];
  return w.recordCount(i, record);
}

/**
 * 独立对照：扇区边界线段按坐标（无向）排序后的列表。两个版本里各自唯一且相同，就认为是同一个扇区。
 * 它比指纹严格（要求每条边界线段都不变），只能核对没有改过几何的扇区。
 */
function geometryKeys(w: WadFile, m: MapScope): string[] {
  const n = count(w, m, "SECTORS");
  const ls = m.lumps["LINEDEFS"] === undefined ? [] : w.readRecords(m.lumps["LINEDEFS"], "Linedef");
  const ss = m.lumps["SIDEDEFS"] === undefined ? [] : w.readRecords(m.lumps["SIDEDEFS"], "Sidedef");
  const vs = m.lumps["VERTEXES"] === undefined ? [] : w.readRecords(m.lumps["VERTEXES"], "Vertex");
  const segs: string[][] = Array.from({ length: n }, () => []);
  for (const l of ls) {
    const owners = new Set<number>();
    for (const s of l.sidenum) if (s !== NO_INDEX && s < ss.length && ss[s]!.sector < n) owners.add(ss[s]!.sector);
    const a = vs[l.v1];
    const b = vs[l.v2];
    if (!a || !b) continue;
    const p = `${a.x},${a.y}`;
    const q = `${b.x},${b.y}`;
    const seg = p < q ? `${p}-${q}` : `${q}-${p}`;
    for (const s of owners) segs[s]!.push(seg);
  }
  return segs.map((s) => s.sort().join("|"));
}

function uniqueIndex(keys: readonly string[]): Map<string, number> {
  const seen = new Map<string, number>();
  keys.forEach((k) => seen.set(k, (seen.get(k) ?? 0) + 1));
  const outMap = new Map<string, number>();
  keys.forEach((k, i) => {
    if (k !== "" && seen.get(k) === 1) outMap.set(k, i);
  });
  return outMap;
}

interface Sweep {
  pins: number;
  exact: number;
  relocated: number;
  ambiguous: number;
  missing: number;
  /** 有独立对照的 pin */
  checkable: number;
  correct: number;
  wrong: number;
  checkableRefused: number;
  /** 没有对照、但被应用的 pin（多半是几何被改过的扇区，无法自动判断对错） */
  uncheckedApplied: number;
  relocations: Array<{ from: number; to: number; score: number; truth: number | undefined }>;
  wrongs: string[];
}

/** from 版本的 map 上每个扇区一个带指纹的 pin，在 to 版本上解析。 */
function sweep(from: Input, to: Input, name: string): Sweep {
  const src = adapter.open(from.bytes);
  const scope = src.scopes().find((s) => s.name.toUpperCase() === name.toUpperCase())!;
  const n = src.recordCount(scope.id, "Sector");
  const operations = Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    select: { record: "Sector", pin: { map: scope.name, expectedIndex: i, fingerprint: src.fingerprints!.compute({ scope: scope.id, record: "Sector", index: i }) } },
    change: { lightlevel: { scale: 1 } },
  }));
  const r = planPatch(to.bytes, { schemaVersion: 1, name: "sweep", target: { format: "wad", maps: [scope.name] }, operations }, adapter);
  if (r.pins.length !== n) throw new Error(`${name}: expected ${n} pin results, got ${r.pins.length}: ${r.issues.map((i) => i.message).join("; ")}`);
  const ka = geometryKeys(from.wad, from.wad.findMap(name)!);
  const kb = geometryKeys(to.wad, to.wad.findMap(name)!);
  const ua = uniqueIndex(ka);
  const ub = uniqueIndex(kb);
  const s: Sweep = { pins: n, exact: 0, relocated: 0, ambiguous: 0, missing: 0, checkable: 0, correct: 0, wrong: 0, checkableRefused: 0, uncheckedApplied: 0, relocations: [], wrongs: [] };
  r.pins.forEach((p, i) => {
    if (p.result === "EXACT") s.exact++;
    else if (p.result === "RELOCATED") s.relocated++;
    else if (p.result === "CONFLICT_AMBIGUOUS") s.ambiguous++;
    else s.missing++;
    const truth = ua.get(ka[i]!) === i ? ub.get(ka[i]!) : undefined;
    if (p.result === "RELOCATED") s.relocations.push({ from: i, to: p.index!, score: p.score!, truth });
    if (truth === undefined) {
      if (p.index !== undefined) s.uncheckedApplied++;
      return;
    }
    s.checkable++;
    if (p.index === undefined) s.checkableRefused++;
    else if (p.index === truth) s.correct++;
    else {
      s.wrong++;
      s.wrongs.push(`${name} #${i} → #${p.index}（对照为 #${truth}）`);
    }
  });
  return s;
}

const pct = (a: number, b: number) => (b === 0 ? "—" : `${((100 * a) / b).toFixed(1)}%`);
const fmtCandidates = (p: PinResolution) =>
  p.candidates.length === 0 ? "无" : p.candidates.slice(0, 3).map((c) => `#${c.index}（${c.score}）`).join("、") + (p.candidateCount > 3 ? ` 等 ${p.candidateCount} 个` : "");

// ---------------------------------------------------------------------------

out(
  `# 重定位报告：${patch.name}`,
  "",
  `由 \`packages/adapter-wad/scripts/relocation-report.ts\` 生成，不要手工编辑。在 \`packages/adapter-wad\` 下重新生成：`,
  "",
  "```text",
  `node scripts/relocation-report.ts ${args.map((a) => a.replace(/\\/g, "/")).join(" ")}`,
  "```",
  "",
  `两个 WAD 取自 GitHub 上 freedoom/freedoom 的发行版 v${OLD.version} 和 v${NEW.version}（\`freedoom-<版本>.zip\`），放在 \`fixtures/cache/\` 下，不提交。下载和校验情况见 \`docs/decisions.md\`。`,
  "",
  "所有 pin 都经补丁引擎的 `planPatch` 解析（干跑，不写文件）。报告只列出检查结果，不说明地图可以通关。",
  "",
  "## 输入",
  "",
  "| 版本 | 文件 | SHA-256 |",
  "| :--- | :--- | :--- |",
  `| Freedoom ${OLD.version} | \`${basename(OLD.path)}\` | \`${OLD.sha256}\` |`,
  `| Freedoom ${NEW.version} | \`${basename(NEW.path)}\` | \`${NEW.sha256}\` |`,
  "",
  `重定位阈值：高置信度 ${RELOCATION_THRESHOLDS.high}，候选下限 ${RELOCATION_THRESHOLDS.low}，唯一候选与第二名至少差 ${RELOCATION_THRESHOLDS.margin}。` +
    `指纹权重：${Object.entries(FINGERPRINT_WEIGHTS).map(([k, v]) => `${k} ${v}`).join("，")}；几何中心相距 ${CENTROID_RADIUS} 个单位及以上得 0。`,
  "",
);

const targetMaps = patch.target.maps === "*" ? NEW.wad.maps.filter((m) => m.format === "doom").map((m) => m.name) : patch.target.maps;
out("## 目标地图在两个版本之间的差异", "", `| 地图 | 扇区数（${OLD.version} → ${NEW.version}） | 线段数 | 顶点数 | 有差异的 Lump |`, "| :--- | :--- | :--- | :--- | :--- |");
for (const name of targetMaps) {
  const a = OLD.wad.findMap(name);
  const b = NEW.wad.findMap(name);
  if (!a || !b) {
    out(`| ${name} | 某个版本没有这张地图 | | | |`);
    continue;
  }
  const d = differs(name);
  const c = (l: (typeof DATA)[number]) => `${count(OLD.wad, a, l)} → ${count(NEW.wad, b, l)}`;
  out(`| ${name} | ${c("SECTORS")} | ${c("LINEDEFS")} | ${c("VERTEXES")} | ${d.same ? "无，五个数据 Lump 逐字节相同" : d.changed.join("、")} |`);
}
out("");

out("## 补丁重放：每个 pin 的结果", "");
for (const input of [NEW, OLD]) {
  const r = planPatch(input.bytes, patch, adapter);
  const byCode = new Map<string, number>();
  for (const i of r.issues) byCode.set(i.code, (byCode.get(i.code) ?? 0) + 1);
  out(
    `### Freedoom ${input.version}`,
    "",
    r.ok
      ? `干跑通过：没有问题，${r.changedCount} 个字段会改变。`
      : `干跑被拒绝，不会写出任何字节：${[...byCode].map(([k, v]) => `${k} ${v} 条`).join("，")}。`,
    "",
  );
  if (r.pins.length === 0) {
    out(r.issues.length > 0 ? "补丁在解析 pin 之前就被拒绝，没有 pin 结果。" : "补丁没有 pin。", "");
    continue;
  }
  out("| 操作 | 地图 | expectedIndex | 结果 | 选中 | 相似度 | 校验了指纹 | 候选（相似度 ≥ 下限） |", "| :--- | :--- | ---: | :--- | :--- | ---: | :--- | :--- |");
  for (const p of r.pins) {
    out(`| \`${p.operationId}\` | ${p.map} | ${p.expectedIndex} | ${p.result} | ${p.index === undefined ? "—" : `#${p.index}`} | ${p.score ?? "—"} | ${p.fingerprintChecked ? "是" : "否"} | ${fmtCandidates(p)} |`);
  }
  out("");
  const notPins = r.issues.filter((i) => i.code !== "CONFLICT_AMBIGUOUS" && i.code !== "CONFLICT_MISSING");
  if (notPins.length > 0) {
    out("pin 以外的问题（前 10 条）：", "");
    for (const i of notPins.slice(0, 10)) out(`- ${i.code}${i.reason ? ` ${i.reason}` : ""}${i.hook ? ` ${i.hook}` : ""}：${i.message}`);
    out("");
  }
  for (const p of r.pins) {
    if (p.result === "CONFLICT_AMBIGUOUS" || p.result === "CONFLICT_MISSING") {
      const fp = adapter.open(input.bytes);
      const scope = fp.scopes().find((s) => s.name.toUpperCase() === p.map.toUpperCase());
      if (scope && p.expectedIndex < fp.recordCount(scope.id, "Sector")) {
        out(`\`${p.operationId}\` 在 ${input.version} 上 #${p.expectedIndex} 的指纹：\`${JSON.stringify(fp.fingerprints!.compute({ scope: scope.id, record: "Sector", index: p.expectedIndex }))}\``, "");
      }
    }
  }
}
const pinOps = patch.operations.filter((o) => "pin" in o.select);
for (const o of pinOps) {
  const fp = (o.select.pin as { fingerprint?: unknown }).fingerprint;
  out(`\`${o.id}\` 补丁里的指纹：${fp === undefined ? "没有" : `\`${JSON.stringify(fp)}\``}`, "");
}

// 有差异的地图：优先 MAP01，否则第一张有差异的地图
const common = NEW.wad.maps.filter((m) => m.format === "doom" && OLD.wad.findMap(m.name)?.format === "doom").map((m) => m.name);
const firstTarget = targetMaps[0] ?? "MAP01";
const sweepMap = !differs(firstTarget).same ? firstTarget : common.find((n) => !differs(n).same);

const sweepTable = (rows: Array<[string, Sweep]>) => {
  out(
    "| 方向 | pin 数 | EXACT | RELOCATED | CONFLICT_AMBIGUOUS | CONFLICT_MISSING | 有对照 | 对照一致 | 选错 | 有对照但拒绝 | 无对照但应用 |",
    "| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const [label, s] of rows) {
    out(
      `| ${label} | ${s.pins} | ${s.exact} | ${s.relocated} | ${s.ambiguous} | ${s.missing} | ${s.checkable} | ${s.correct}（${pct(s.correct, s.checkable)}） | ${s.wrong} | ${s.checkableRefused} | ${s.uncheckedApplied} |`,
    );
  }
  out("");
};

out(
  "## 跨版本重定位",
  "",
  "把一张地图的每个扇区都当作一个带指纹的 pin（指纹取自源版本，`expectedIndex` 为源版本的下标），在另一个版本上解析。",
  "",
  "“对照”是一个独立于指纹的判断：扇区全部边界线段的坐标完全相同，并且这组线段在两个版本里都只属于这一个扇区。有对照的 pin 可以自动核对选得对不对；几何改过的扇区没有对照，被应用时无法自动判断对错，单独计数。",
  "",
);
if (!sweepMap) {
  out("两个版本的所有同名地图都没有差异，无法测试 RELOCATED。", "");
} else {
  out(
    sweepMap === firstTarget
      ? `补丁的第一张目标地图 ${sweepMap} 在两个版本之间有差异，直接用它测试。`
      : `补丁的第一张目标地图 ${firstTarget} 在两个版本之间没有差异（五个数据 Lump 逐字节相同），改用第一张有差异的地图 ${sweepMap}。`,
    "",
    `### ${sweepMap}`,
    "",
  );
  const fwd = sweep(OLD, NEW, sweepMap);
  const back = sweep(NEW, OLD, sweepMap);
  sweepTable([
    [`${OLD.version} → ${NEW.version}`, fwd],
    [`${NEW.version} → ${OLD.version}`, back],
  ]);
  for (const [label, s] of [[`${OLD.version} → ${NEW.version}`, fwd], [`${NEW.version} → ${OLD.version}`, back]] as const) {
    out(`${label} 的全部 RELOCATED（${s.relocations.length} 个）：`, "");
    if (s.relocations.length === 0) out("没有。", "");
    else {
      out("| 源下标 | 目标下标 | 相似度 | 对照 |", "| ---: | ---: | ---: | :--- |");
      for (const x of s.relocations) out(`| #${x.from} | #${x.to} | ${x.score} | ${x.truth === undefined ? "无对照" : x.truth === x.to ? "一致" : `不一致（对照为 #${x.truth}）`} |`);
      out("");
    }
    if (s.wrongs.length > 0) out("选错的 pin：", "", ...s.wrongs.map((w) => `- ${w}`), "");
  }
}

out("### 全部同名地图", "", `${common.length} 张地图，两个方向分别统计。`, "");
const total = (from: Input, to: Input): Sweep => {
  const t: Sweep = { pins: 0, exact: 0, relocated: 0, ambiguous: 0, missing: 0, checkable: 0, correct: 0, wrong: 0, checkableRefused: 0, uncheckedApplied: 0, relocations: [], wrongs: [] };
  for (const name of common) {
    const s = sweep(from, to, name);
    for (const k of ["pins", "exact", "relocated", "ambiguous", "missing", "checkable", "correct", "wrong", "checkableRefused", "uncheckedApplied"] as const) t[k] += s[k];
    t.wrongs.push(...s.wrongs);
  }
  return t;
};
const allFwd = total(OLD, NEW);
const allBack = total(NEW, OLD);
sweepTable([
  [`${OLD.version} → ${NEW.version}`, allFwd],
  [`${NEW.version} → ${OLD.version}`, allBack],
]);
const wrongs = [...allFwd.wrongs, ...allBack.wrongs];
out(wrongs.length === 0 ? "有对照的 pin 没有一个被重定位到错误的扇区。" : `选错的 pin：\n\n${wrongs.map((w) => `- ${w}`).join("\n")}`, "");
out(
  "## 没有验证的内容",
  "",
  "- 没有对照、但被应用的 pin（上表最后一列）是否选对，没有逐个核对。它们多半是几何被改过的扇区，指纹仍高度相似。",
  "- 对照本身是启发式：边界线段完全相同的两个扇区被视为同一个扇区，没有人工确认。",
  "- 这里只做干跑，没有把跨版本重定位后的结果导出并放进引擎运行。",
  "",
);

writeFileSync(outPath, lines.join("\n"));
console.log(`wrote ${outPath}`);
