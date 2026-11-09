/**
 * 用真实的 Freedoom 发行版重放补丁，生成重定位报告（Markdown）。
 * 用法：node scripts/relocation-report.ts <old.wad> <old-version> <new.wad> <new-version> <patch.json> <report.md> [--holdout <wad> <version>]...
 *
 * old 与 new 是校准集：指纹参数和阈值只用这两个版本校准。--holdout 给出的版本是留出集，不参与校准，
 * 报告把它与 old、new 两两组合（两个方向）单独统计。
 *
 * 报告内容：
 * 1. 输入文件的 SHA-256，补丁目标地图在校准集两个版本之间的差异。
 * 2. 补丁在 old、new 上各干跑一次（planPatch，不写文件），列出每个 pin 的结果。
 * 3. 把每张同名地图的每个扇区都当作一个带自身指纹的 pin，在另一个版本上解析（两个方向），用两个独立对照核对：
 *    对照一：边界线段坐标完全相同；对照二：面积覆盖（见 relocation-controls.ts）。另外统计多个源 pin 定位到同一目标的情况。
 * 4. 修复前的公式（没有 bbox 和面积）在同样的 pin 上的结果，用 core 的 classifyPin 重算，作对比。
 * 5. 人工抽查的样例和判断。
 * 当前公式的所有 pin 都经补丁引擎的 planPatch 解析，不另写一套判断。报告只写检查过什么，不声称地图可以通关。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { classifyPin, planPatch, RELOCATION_THRESHOLDS, type PinResolution } from "@necrohex/core";
import {
  createWadAdapter,
  FINGERPRINT_PARAMS,
  sectorFingerprints,
  sectorFingerprintScore,
  WadFile,
  type FingerprintParams,
  type MapScope,
  type SectorFingerprint,
} from "../src/index.ts";
import { coverage, geometryKeys, geometryTruth, mapArea, type MapArea } from "./relocation-controls.ts";

const argv = process.argv.slice(2);
const holdoutArgs: Array<[string, string]> = [];
for (let at = argv.indexOf("--holdout"); at >= 0; at = argv.indexOf("--holdout")) {
  holdoutArgs.push([argv[at + 1]!, argv[at + 2]!]);
  argv.splice(at, 3);
}
if (argv.length !== 6 || holdoutArgs.some(([p, v]) => !p || !v)) {
  console.error("usage: node scripts/relocation-report.ts <old.wad> <old-version> <new.wad> <new-version> <patch.json> <report.md> [--holdout <wad> <version>]...");
  process.exit(2);
}
const [oldPath, oldVersion, newPath, newVersion, patchPath, outPath] = argv as [string, string, string, string, string, string];

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
const HOLDOUT = holdoutArgs.map(([p, v]) => load(p, v));
const patch = JSON.parse(readFileSync(patchPath, "utf8")) as { name: string; target: { maps: "*" | string[] }; operations: Array<{ id: string; select: Record<string, unknown> }> };
const adapter = createWadAdapter();

/** 修复前的公式：没有 bbox 和面积，几何中心 0.4，半径 32。 */
const OLD_PARAMS: FingerprintParams = {
  ...FINGERPRINT_PARAMS,
  weights: { centroid: 0.4, bbox: 0, area: 0, lineCount: 0.1, heights: 0.2, floorpic: 0.1, ceilingpic: 0.1, tag: 0.1 },
};

const lines: string[] = [];
const out = (...l: string[]) => lines.push(...l);
const DATA = ["THINGS", "LINEDEFS", "SIDEDEFS", "VERTEXES", "SECTORS"] as const;

function lumpHash(w: WadFile, index: number | undefined): string | undefined {
  return index === undefined ? undefined : createHash("sha256").update(w.lumpBytes(index)).digest("hex");
}

function differs(a: Input, b: Input, name: string): { same: boolean; changed: string[] } {
  const ma = a.wad.findMap(name);
  const mb = b.wad.findMap(name);
  if (!ma || !mb) return { same: false, changed: ["(map missing)"] };
  const changed = DATA.filter((l) => lumpHash(a.wad, ma.lumps[l]) !== lumpHash(b.wad, mb.lumps[l]));
  return { same: changed.length === 0, changed };
}

function count(w: WadFile, m: MapScope, lump: (typeof DATA)[number]): number {
  const i = m.lumps[lump];
  if (i === undefined) return 0;
  const record = ({ THINGS: "Thing", LINEDEFS: "Linedef", SIDEDEFS: "Sidedef", VERTEXES: "Vertex", SECTORS: "Sector" } as const)[lump];
  return w.recordCount(i, record);
}

// ---------------------------------------------------------------------------
// 每个版本、每张地图的对照数据，按需计算并缓存

interface MapData {
  readonly fps: SectorFingerprint[];
  readonly area: MapArea;
  readonly keys: string[];
}
const mapCache = new Map<string, MapData>();
function mapData(input: Input, name: string): MapData {
  const key = `${input.version}/${name}`;
  let d = mapCache.get(key);
  if (!d) {
    const m = input.wad.findMap(name)!;
    mapCache.set(key, (d = { fps: sectorFingerprints(input.wad, m), area: mapArea(input.wad, m), keys: geometryKeys(input.wad, m) }));
  }
  return d;
}

/** 一个 pin 的结果和两个对照。 */
interface Row {
  readonly map: string;
  readonly from: number;
  readonly result: PinResolution["result"];
  readonly index: number | undefined;
  readonly score: number | undefined;
  /** 对照一给出的目标（没有对照为 undefined） */
  readonly truth: number | undefined;
  /** 源扇区的面积覆盖采样点数，0 表示无法判断 */
  readonly samples: number;
  /** 采样点落在被选中扇区内的比例（没有选中为 0） */
  readonly chosen: number;
  readonly best: { readonly index: number; readonly coverage: number } | undefined;
}

type Formula = "current" | "old";

/** from 版本的 name 地图上每个扇区一个带自身指纹的 pin，在 to 版本上解析。current 用 planPatch，old 用 classifyPin 和旧公式。 */
function sweep(from: Input, to: Input, name: string, formula: Formula): Row[] {
  const src = mapData(from, name);
  const dst = mapData(to, name);
  const truth = geometryTruth(src.keys, dst.keys);
  let resolved: Array<{ result: PinResolution["result"]; index: number | undefined; score: number | undefined }>;
  if (formula === "current") {
    const operations = src.fps.map((fingerprint, i) => ({
      id: `s${i}`,
      select: { record: "Sector", pin: { map: name, expectedIndex: i, fingerprint } },
      change: { lightlevel: { scale: 1 } },
    }));
    const r = planPatch(to.bytes, { schemaVersion: 1, name: "sweep", target: { format: "wad", maps: [name] }, operations }, adapter);
    if (r.pins.length !== src.fps.length) throw new Error(`${name}: expected ${src.fps.length} pin results, got ${r.pins.length}: ${r.issues.map((i) => i.message).join("; ")}`);
    resolved = r.pins.map((p) => ({ result: p.result, index: p.index, score: p.score }));
  } else {
    resolved = src.fps.map((fp, i) => {
      const c = classifyPin(dst.fps.map((x) => sectorFingerprintScore(fp, x, OLD_PARAMS)), i);
      return { result: c.result, index: "index" in c ? c.index : undefined, score: "score" in c ? c.score : undefined };
    });
  }
  return resolved.map((p, i) => {
    const c = coverage(src.area, dst.area, i, p.index);
    return { map: name, from: i, result: p.result, index: p.index, score: p.score, truth: truth[i], samples: c.samples, chosen: c.chosen, best: c.best };
  });
}

const applied = (r: Row) => r.result === "EXACT" || r.result === "RELOCATED";
const low = (r: Row) => applied(r) && r.samples > 0 && r.chosen < 0.5;

interface Stats {
  pins: number;
  exact: number;
  relocated: number;
  ambiguous: number;
  missing: number;
  keyed: number;
  keyedRight: number;
  keyedWrong: number;
  keyedRefused: number;
  unkeyedApplied: number;
  noSamples: number;
  lowExact: number;
  lowRelocated: number;
  /** 被两个及以上源 pin 选中的目标数，以及涉及的源 pin 数 */
  sharedTargets: number;
  sharedPins: number;
}

function stats(rows: readonly Row[]): Stats {
  const s: Stats = { pins: 0, exact: 0, relocated: 0, ambiguous: 0, missing: 0, keyed: 0, keyedRight: 0, keyedWrong: 0, keyedRefused: 0, unkeyedApplied: 0, noSamples: 0, lowExact: 0, lowRelocated: 0, sharedTargets: 0, sharedPins: 0 };
  for (const r of rows) {
    s.pins++;
    if (r.result === "EXACT") s.exact++;
    else if (r.result === "RELOCATED") s.relocated++;
    else if (r.result === "CONFLICT_AMBIGUOUS") s.ambiguous++;
    else s.missing++;
    if (r.truth !== undefined) {
      s.keyed++;
      if (!applied(r)) s.keyedRefused++;
      else if (r.index === r.truth) s.keyedRight++;
      else s.keyedWrong++;
    } else if (applied(r)) s.unkeyedApplied++;
    if (applied(r) && r.samples === 0) s.noSamples++;
    if (low(r)) r.result === "EXACT" ? s.lowExact++ : s.lowRelocated++;
  }
  for (const g of shared(rows)) {
    s.sharedTargets++;
    s.sharedPins += g.rows.length;
  }
  return s;
}

/** 同一张地图上被两个及以上源 pin 选中的目标。 */
function shared(rows: readonly Row[]): Array<{ map: string; target: number; rows: Row[] }> {
  const by = new Map<string, Row[]>();
  for (const r of rows) {
    if (!applied(r)) continue;
    const k = `${r.map}#${r.index}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return [...by.values()].filter((g) => g.length > 1).map((g) => ({ map: g[0]!.map, target: g[0]!.index!, rows: g }));
}

const pct = (a: number, b: number) => (b === 0 ? "—" : `${((100 * a) / b).toFixed(1)}%`);
const f2 = (v: number) => v.toFixed(2);
const fmtCandidates = (p: PinResolution) =>
  p.candidates.length === 0 ? "无" : p.candidates.slice(0, 3).map((c) => `#${c.index}（${c.score}）`).join("、") + (p.candidateCount > 3 ? ` 等 ${p.candidateCount} 个` : "");
const fmtBest = (r: Row) => (r.best === undefined ? "无（采样点不在任何扇区内）" : `#${r.best.index}（${f2(r.best.coverage)}）`);

function statsTable(rows: Array<[string, Stats]>): void {
  out(
    "| 方向 | pin 数 | EXACT | RELOCATED | CONFLICT_AMBIGUOUS | CONFLICT_MISSING | 对照一：有对照 | 对照一：一致 | 对照一：选错 | 对照一：拒绝 | 无对照但应用 | 对照二：覆盖 < 0.5 的 EXACT | 对照二：覆盖 < 0.5 的 RELOCATED | 对照二：无采样点 | 多个源 pin 共用的目标（涉及 pin） |",
    "| :--- |" + " ---: |".repeat(14),
  );
  for (const [label, s] of rows) {
    out(
      `| ${label} | ${s.pins} | ${s.exact} | ${s.relocated} | ${s.ambiguous} | ${s.missing} | ${s.keyed} | ${s.keyedRight}（${pct(s.keyedRight, s.keyed)}） | ${s.keyedWrong} | ${s.keyedRefused} | ${s.unkeyedApplied} | ${s.lowExact} | ${s.lowRelocated} | ${s.noSamples} | ${s.sharedTargets}（${s.sharedPins}） |`,
    );
  }
  out("");
}

function lowList(label: string, rows: readonly Row[]): void {
  const lows = rows.filter(low);
  for (const kind of ["EXACT", "RELOCATED"] as const) {
    const ls = lows.filter((r) => r.result === kind);
    out(`${label} 覆盖率 < 0.5 的 ${kind}（${ls.length} 个）：`, "");
    if (ls.length === 0) {
      out("没有。", "");
      continue;
    }
    out("| 地图 | 源 → 选中 | 相似度 | 覆盖率 | 覆盖率最高的目标 | 采样点 |", "| :--- | :--- | ---: | ---: | :--- | ---: |");
    for (const r of ls) out(`| ${r.map} | #${r.from} → #${r.index} | ${r.score} | ${f2(r.chosen)} | ${fmtBest(r)} | ${r.samples} |`);
    out("");
  }
}

/** 对照一判为选错的 pin，没有时不输出。 */
function keyedWrongList(label: string, rows: readonly Row[]): void {
  const ws = rows.filter((r) => r.truth !== undefined && applied(r) && r.index !== r.truth);
  if (ws.length === 0) return;
  out(`${label} 对照一判为选错的 pin（${ws.length} 个）：`, "");
  for (const r of ws) out(`- ${r.map} #${r.from} → #${r.index}（${r.result}，${r.score}；对照一为 #${r.truth}，面积覆盖 ${r.samples === 0 ? "无采样点" : f2(r.chosen)}）`);
  out("");
}

function sharedList(label: string, rows: readonly Row[]): void {
  const gs = shared(rows);
  out(`${label} 多个源 pin 定位到同一目标（${gs.length} 个目标）：`, "");
  if (gs.length === 0) {
    out("没有。", "");
    return;
  }
  out("| 地图 | 目标 | 源 pin（结果，相似度，覆盖率） |", "| :--- | :--- | :--- |");
  for (const g of gs) out(`| ${g.map} | #${g.target} | ${g.rows.map((r) => `#${r.from}（${r.result}，${r.score}，${f2(r.chosen)}）`).join("；")} |`);
  out("");
}

const doomMaps = (a: Input, b: Input) => b.wad.maps.filter((m) => m.format === "doom" && a.wad.findMap(m.name)?.format === "doom").map((m) => m.name);

/** 一对版本两个方向的全部同名地图。 */
interface PairResult {
  readonly label: string;
  readonly current: Row[];
  readonly old: Row[];
}
function pair(a: Input, b: Input): PairResult[] {
  return [
    [a, b],
    [b, a],
  ].map(([x, y]) => {
    const maps = doomMaps(x!, y!);
    return { label: `${x!.version} → ${y!.version}`, current: maps.flatMap((n) => sweep(x!, y!, n, "current")), old: maps.flatMap((n) => sweep(x!, y!, n, "old")) };
  });
}

// ---------------------------------------------------------------------------

out(
  `# 重定位报告：${patch.name}`,
  "",
  `由 \`packages/adapter-wad/scripts/relocation-report.ts\` 生成，不要手工编辑。在 \`packages/adapter-wad\` 下重新生成：`,
  "",
  "```text",
  `node scripts/relocation-report.ts ${process.argv
    .slice(2)
    .map((a) => a.replace(/\\/g, "/"))
    .join(" ")}`,
  "```",
  "",
  `WAD 取自 GitHub 上 freedoom/freedoom 的发行版（\`freedoom-<版本>.zip\`），放在 \`fixtures/cache/\` 下，不提交。下载和校验情况见 \`docs/decisions.md\`。`,
  "",
  `指纹参数和阈值只用校准集 Freedoom ${OLD.version} 与 ${NEW.version} 校准。${HOLDOUT.length > 0 ? `留出集 ${HOLDOUT.map((h) => h.version).join("、")} 不参与校准，结果单独列出。` : "这次没有给留出集。"}`,
  "",
  "当前公式的所有 pin 都经补丁引擎的 `planPatch` 解析（干跑，不写文件）。报告只列出检查结果，不说明地图可以通关。",
  "",
  "## 输入",
  "",
  "| 用途 | 版本 | 文件 | SHA-256 |",
  "| :--- | :--- | :--- | :--- |",
  `| 校准集 | Freedoom ${OLD.version} | \`${basename(OLD.path)}\` | \`${OLD.sha256}\` |`,
  `| 校准集 | Freedoom ${NEW.version} | \`${basename(NEW.path)}\` | \`${NEW.sha256}\` |`,
  ...HOLDOUT.map((h) => `| 留出集 | Freedoom ${h.version} | \`${basename(h.path)}\` | \`${h.sha256}\` |`),
  "",
  `重定位阈值：高置信度 ${RELOCATION_THRESHOLDS.high}，候选下限 ${RELOCATION_THRESHOLDS.low}，唯一候选与第二名至少差 ${RELOCATION_THRESHOLDS.margin}。`,
  "",
  `当前指纹权重：${Object.entries(FINGERPRINT_PARAMS.weights).map(([k, v]) => `${k} ${v}`).join("，")}。` +
    `几何中心相距 ${FINGERPRINT_PARAMS.centroidRadius} 个单位及以上得 0；边界框每个轴按 (重叠 + ${FINGERPRINT_PARAMS.bboxSlack}) / (并集 + ${FINGERPRINT_PARAMS.bboxSlack})，两轴相乘；` +
    `面积按 (较小 + ${FINGERPRINT_PARAMS.areaSlack}) / (较大 + ${FINGERPRINT_PARAMS.areaSlack})。`,
  "",
  `修复前的公式（下文“修复前”）：${Object.entries(OLD_PARAMS.weights).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}`).join("，")}，没有边界框和面积。修复前的数字用 core 的 \`classifyPin\` 按同样的阈值重算。`,
  "",
);

const targetMaps = patch.target.maps === "*" ? NEW.wad.maps.filter((m) => m.format === "doom").map((m) => m.name) : patch.target.maps;
out("## 目标地图在校准集两个版本之间的差异", "", `| 地图 | 扇区数（${OLD.version} → ${NEW.version}） | 线段数 | 顶点数 | 有差异的 Lump |`, "| :--- | :--- | :--- | :--- | :--- |");
for (const name of targetMaps) {
  const a = OLD.wad.findMap(name);
  const b = NEW.wad.findMap(name);
  if (!a || !b) {
    out(`| ${name} | 某个版本没有这张地图 | | | |`);
    continue;
  }
  const d = differs(OLD, NEW, name);
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
    r.ok ? `干跑通过：没有问题，${r.changedCount} 个字段会改变。` : `干跑被拒绝，不会写出任何字节：${[...byCode].map(([k, v]) => `${k} ${v} 条`).join("，")}。`,
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
for (const o of patch.operations.filter((o) => "pin" in o.select)) {
  const fp = (o.select.pin as { fingerprint?: unknown }).fingerprint;
  out(`\`${o.id}\` 补丁里的指纹：${fp === undefined ? "没有" : `\`${JSON.stringify(fp)}\``}`, "");
}

out(
  "## 跨版本重定位：怎么读下面的数字",
  "",
  "把一张地图的每个扇区都当作一个带自身指纹的 pin（指纹取自源版本，`expectedIndex` 为源版本的下标），在另一个版本上解析。“被应用”指结果为 EXACT 或 RELOCATED。",
  "",
  "每个数字只覆盖下面写明的那部分扇区：",
  "",
  "- **对照一（几何相同）**：扇区全部边界线段的坐标完全相同，并且这组线段在两个版本里都只属于这一个扇区。“有对照”只包括这些扇区，它们的几何没有改过；“对照一：选错”是这部分扇区里被定位到别的扇区的数量，**不包括几何改过的扇区**。",
  "- **无对照但应用**：几何改过（或在某个版本里不唯一）的扇区里被应用的 pin，对照一无法判断它们。",
  "- **对照二（面积覆盖）**：覆盖全部被应用的 pin。在源扇区内按网格取点（奇偶规则判断内外，两面都属于同一扇区的线段不算边界），计算这些点落在被选中扇区内的比例。覆盖率 < 0.5 记为可疑。它是启发式：窄扇区平移了自身宽度、扇区被拆分或合并、环形或嵌套结构重画，都会让覆盖率很低而选择其实是对的；下文的抽查逐个判断。“无采样点”是没有取到内部点的扇区（例如面积为 0 或边界不闭合），对照二无法判断。",
  "- **多个源 pin 共用的目标**：同一张地图上两个及以上不同的源 pin 被定位到同一个目标扇区。除非源扇区在新版本里被合并，否则其中至少一个选错。",
  "",
);

// 校准集
const calib = pair(OLD, NEW);
const firstTarget = targetMaps[0] ?? "MAP01";
const sweepMap = !differs(OLD, NEW, firstTarget).same ? firstTarget : doomMaps(OLD, NEW).find((n) => !differs(OLD, NEW, n).same);

out(`## 校准集：Freedoom ${OLD.version} ↔ ${NEW.version}`, "");
if (sweepMap) {
  out(
    `### ${sweepMap}`,
    "",
    sweepMap === firstTarget
      ? `补丁的第一张目标地图 ${sweepMap} 在两个版本之间有差异，单独列出。`
      : `补丁的第一张目标地图 ${firstTarget} 在两个版本之间没有差异（五个数据 Lump 逐字节相同），改列第一张有差异的地图 ${sweepMap}。`,
    "",
  );
  statsTable(calib.map((p) => [p.label, stats(p.current.filter((r) => r.map === sweepMap))]));
  for (const p of calib) {
    const rel = p.current.filter((r) => r.map === sweepMap && r.result === "RELOCATED");
    out(`${p.label} 的全部 RELOCATED（${rel.length} 个）：`, "");
    if (rel.length === 0) out("没有。", "");
    else {
      out("| 源下标 | 目标下标 | 相似度 | 对照一 | 对照二：覆盖率 | 覆盖率最高的目标 |", "| ---: | ---: | ---: | :--- | ---: | :--- |");
      for (const x of rel) out(`| #${x.from} | #${x.index} | ${x.score} | ${x.truth === undefined ? "无对照" : x.truth === x.index ? "一致" : `不一致（对照为 #${x.truth}）`} | ${x.samples === 0 ? "无采样点" : f2(x.chosen)} | ${fmtBest(x)} |`);
      out("");
    }
  }
}

out(`### 全部同名地图（${doomMaps(OLD, NEW).length} 张）`, "", "当前公式：", "");
statsTable(calib.map((p) => [p.label, stats(p.current)]));
out("修复前：", "");
statsTable(calib.map((p) => [p.label, stats(p.old)]));
for (const p of calib) {
  lowList(`当前公式 ${p.label}`, p.current);
  sharedList(`当前公式 ${p.label}`, p.current);
  keyedWrongList(`当前公式 ${p.label}`, p.current);
  keyedWrongList(`修复前 ${p.label}`, p.old);
}

// 留出集
const holdoutPairs = HOLDOUT.flatMap((h) => [OLD, NEW].map((c) => ({ h, c, results: pair(h, c) })));
for (const { h, c, results } of holdoutPairs) {
  out(`## 留出集：Freedoom ${h.version} ↔ ${c.version}`, "", `${h.version} 没有参与校准。${doomMaps(h, c).length} 张同名地图。`, "", "当前公式：", "");
  statsTable(results.map((p) => [p.label, stats(p.current)]));
  out("修复前：", "");
  statsTable(results.map((p) => [p.label, stats(p.old)]));
  for (const p of results) {
    lowList(`当前公式 ${p.label}`, p.current);
    sharedList(`当前公式 ${p.label}`, p.current);
    keyedWrongList(`当前公式 ${p.label}`, p.current);
    keyedWrongList(`修复前 ${p.label}`, p.old);
  }
}

// ---------------------------------------------------------------------------
// 人工抽查：用 scripts/sector-ascii.ts 把两个版本的同一区域画成字符图后逐个判断。判断是人写的，结果列由脚本按当前数据重算。

interface Spot {
  readonly from: string;
  readonly to: string;
  readonly map: string;
  readonly index: number;
  /** 被抽查的那次选择：哪个公式、选中了哪个目标 */
  readonly formula: "当前" | "修复前" | "校准中的候选公式";
  readonly picked: number;
  readonly verdict: "选对" | "选错" | "无法判断";
  readonly note: string;
}

const SPOTS: readonly Spot[] = [
  { from: "0.12.1", to: "0.13.0", map: "MAP12", index: 908, formula: "修复前", picked: 752, verdict: "选错", note: "#908 是两条竖条（中间夹着 #919），#752 是上下两条横条，位置不重叠，地板贴图也不同" },
  { from: "0.12.1", to: "0.13.0", map: "MAP12", index: 919, formula: "修复前", picked: 752, verdict: "选错", note: "#919 是中间的竖条，#752 是上下两条横条，位置不重叠" },
  { from: "0.12.1", to: "0.13.0", map: "MAP05", index: 107, formula: "修复前", picked: 66, verdict: "选错", note: "#107 是 H 形水面，#66 占的是 H 的空缺部分，两者互补、不重叠" },
  { from: "0.12.1", to: "0.13.0", map: "MAP12", index: 1072, formula: "修复前", picked: 152, verdict: "选错", note: "#1072 是上下两小块，#152 是夹在中间的一块，不重叠" },
  { from: "0.12.1", to: "0.13.0", map: "MAP01", index: 17, formula: "修复前", picked: 17, verdict: "选错", note: "EXACT 选错：0.12.1 的 #17 是 288×32 的一块，0.13.0 的 #17 是同一位置 1 单位高的细条，原来的区域在 0.13.0 里在地图之外" },
  { from: "0.13.0", to: "0.12.1", map: "MAP25", index: 375, formula: "修复前", picked: 375, verdict: "选错", note: "EXACT 选错：0.13.0 的 #375 是 64×64 的方块，0.12.1 的 #375 是这块区域里 8×8 的另一个小扇区，方块区域属于 #370" },
  { from: "0.13.0", to: "0.12.1", map: "MAP01", index: 106, formula: "校准中的候选公式", picked: 52, verdict: "选错", note: "#106 是新划出的斜向水道，原区域在 0.12.1 里大部分属于 #163；#52 在 0.13.0 里仍然存在（EXACT），两者边界框恰好相同" },
  { from: "0.13.0", to: "0.12.1", map: "MAP25", index: 514, formula: "修复前", picked: 514, verdict: "选对", note: "血池台阶：0.12.1 里台阶 #514 只剩左右两条边，中间是血池；0.13.0 里血池缩成两小块，台阶占了中间。同一个台阶扇区，形状被重新拆分" },
  { from: "0.12.1", to: "0.13.0", map: "MAP06", index: 94, formula: "修复前", picked: 94, verdict: "选对", note: "8 单位宽的竖条整体平移了 8 单位，形状、贴图、高度都相同，覆盖率因此为 0。这是覆盖率误判" },
  { from: "0.12.1", to: "0.13.0", map: "MAP12", index: 180, formula: "当前", picked: 180, verdict: "选对", note: "三条平行的窄斜条（FLOOR0_1、FLAT23、CEIL5_2）被重画成直线，各自平移了约一个条宽；贴图和高度一一对应" },
  { from: "0.12.1", to: "0.13.0", map: "MAP12", index: 182, formula: "当前", picked: 182, verdict: "选对", note: "同上，三条窄斜条中的一条" },
  { from: "0.12.1", to: "0.13.0", map: "MAP12", index: 273, formula: "当前", picked: 272, verdict: "选对", note: "地图另一侧对称的三条窄斜条，下标整体减 1" },
  { from: "0.12.1", to: "0.13.0", map: "MAP12", index: 1367, formula: "当前", picked: 510, verdict: "选对", note: "箱子边缘的斜向窄条，连同周围的墙整体平移了几个单位" },
  { from: "0.12.1", to: "0.13.0", map: "MAP22", index: 25, formula: "当前", picked: 264, verdict: "选对", note: "十字形的大片酸液扇区，中间部分在 0.13.0 被划成新的 #20（tag 14），#264 是剩下的部分。拆分" },
  { from: "0.12.1", to: "0.13.0", map: "MAP19", index: 124, formula: "当前", picked: 124, verdict: "选对", note: "八边形的环整体平移 8 单位，环宽 4 单位，覆盖率因此低" },
  { from: "0.12.1", to: "0.13.0", map: "MAP12", index: 4, formula: "当前", picked: 4, verdict: "选对", note: "弧形窄带被重画成直的斜带，两端位置不变" },
  { from: "0.13.0", to: "0.12.1", map: "MAP01", index: 72, formula: "当前", picked: 72, verdict: "无法判断", note: "448×40 的天空细条，字符图分辨率不够；贴图、高度、线段数相同，边界框差 4 单位，倾向选对" },
  { from: "0.11.3", to: "0.12.1", map: "MAP25", index: 621, formula: "当前", picked: 622, verdict: "选错", note: "留出集。两个同心八边形环：外环 #621 在 0.12.1 里被并入房间 #210，#622 是内环（变宽）。当前公式把外环选到内环，相似度 0.8596" },
  { from: "0.11.3", to: "0.12.1", map: "MAP10", index: 130, formula: "当前", picked: 129, verdict: "无法判断", note: "留出集。0.11.3 里 #130 覆盖 #129 的区域再向左上延伸，两扇区重叠；0.12.1 里只剩 #129。可能是合并，改动会落到原 #129 上" },
  { from: "0.12.1", to: "0.11.3", map: "MAP25", index: 126, formula: "当前", picked: 126, verdict: "选对", note: "留出集。三条窗台状的长条；0.11.3 里每条中间还有一条内条 #127，#126 是包住它们的外圈。同一个扇区，内部被划出了子扇区" },
  { from: "0.11.3", to: "0.12.1", map: "MAP15", index: 260, formula: "当前", picked: 228, verdict: "无法判断", note: "留出集。四块方形平台换成中间一块总面积相同的平台，贴图和高度相同。像是同一处被重新设计" },
];

const allResults = new Map<string, PairResult>();
for (const p of [...calib, ...holdoutPairs.flatMap((x) => x.results)]) allResults.set(p.label, p);
const rowOf = (s: Spot, formula: Formula): Row | undefined => allResults.get(`${s.from} → ${s.to}`)?.[formula].find((r) => r.map === s.map && r.from === s.index);
const fmtRow = (r: Row | undefined) =>
  r === undefined ? "（没有这组数据）" : applied(r) ? `${r.result} #${r.index}（${r.score}，覆盖 ${r.samples === 0 ? "无采样点" : f2(r.chosen)}）` : r.result;

out(
  "## 人工抽查",
  "",
  "用 `scripts/sector-ascii.ts` 把源扇区和被选中的扇区在两个版本里画成字符图，逐个判断。“判断”和“说明”是人写的；“修复前”和“当前”两列由脚本按当前数据重算。",
  "",
  "| 方向 | 地图 | 源 | 被抽查的选择 | 判断 | 修复前 | 当前 | 说明 |",
  "| :--- | :--- | ---: | :--- | :--- | :--- | :--- | :--- |",
);
for (const s of SPOTS) {
  out(`| ${s.from} → ${s.to} | ${s.map} | #${s.index} | ${s.formula}：#${s.picked} | ${s.verdict} | ${fmtRow(rowOf(s, "old"))} | ${fmtRow(rowOf(s, "current"))} | ${s.note} |`);
}
out("");
const tally = (v: Spot["verdict"]) => SPOTS.filter((s) => s.verdict === v).length;
out(`共抽查 ${SPOTS.length} 个：选对 ${tally("选对")}，选错 ${tally("选错")}，无法判断 ${tally("无法判断")}。抽查对象是挑出来的可疑样例，比例不代表整体。`, "");

out(
  "## 没有验证的内容",
  "",
  "- “无对照但应用”的 pin 只用面积覆盖核对过，覆盖率 ≥ 0.5 的没有逐个人工确认；覆盖率 < 0.5 的只抽查了上表列出的部分。",
  "- 两个对照都是启发式：对照一把边界线段完全相同的扇区视为同一个扇区，对照二按奇偶规则判断内外，遇到重叠线段或不闭合的边界会出错。",
  "- 留出集里仍有选错（见抽查）。阈值和权重没有为它调整，否则它就不再是留出集。",
  "- 这里只做干跑。导出并放进引擎运行的只有补丁本身和 `patches/relocation-demo.nhpatch.json`，见 `docs/decisions.md`。",
  "",
);

writeFileSync(outPath, lines.join("\n"));
console.log(`wrote ${outPath}`);
