/**
 * 校准扇区指纹的相似度参数。只用于开发，产品代码不读取它的输出。
 * 用法：node scripts/calibrate-relocation.ts <a.wad> <a-version> <b.wad> <b-version> [<c.wad> <c-version> ...]
 *
 * 对相邻的每一对版本（a↔b、b↔c ...）的全部同名 Doom 地图，把每个扇区都当作一个带自身指纹的 pin，在另一个版本上分级，两个方向都做。
 * 每组参数打印一行：应用数、两个对照的结果、多个源 pin 定位到同一目标的数量、同版本歧义数。
 * 分级用 core 的 classifyPin 和 RELOCATION_THRESHOLDS，与补丁引擎一致；各组成部分的相似度用 src/fingerprint.ts 的实现。
 *
 * 环境变量：
 * - CALIBRATE_GRID=1：边界框按绝对偏移打分、只用重叠比例两组对比；CALIBRATE_GRID=2：加入面积后的权重网格。
 * - CALIBRATE_SPLIT=1：每个方向单独一行。
 * - CALIBRATE_DUMP=<参数名>：列出该组参数下覆盖率 < 0.5 的被应用 pin（LOW）和定位到同一目标的源 pin（SAME），不打印表格。
 */
import { readFileSync } from "node:fs";
import { classifyPin, RELOCATION_THRESHOLDS } from "@necrohex/core";
import {
  FINGERPRINT_PARAMS,
  sectorFingerprintParts,
  sectorFingerprints,
  weightedScore,
  WadFile,
  type FingerprintPart,
  type SectorFingerprint,
} from "../src/index.ts";
import { geometryKeys, geometryTruth, mapArea, type MapArea } from "./relocation-controls.ts";

const args = process.argv.slice(2);
if (args.length < 4 || args.length % 2 !== 0) {
  console.error("usage: node scripts/calibrate-relocation.ts <a.wad> <a-version> <b.wad> <b-version> [...]");
  process.exit(2);
}

interface MapData {
  readonly fps: SectorFingerprint[];
  readonly area: MapArea;
  readonly keys: string[];
}
interface Version {
  readonly version: string;
  readonly maps: Map<string, MapData>;
}
const versions: Version[] = [];
for (let i = 0; i < args.length; i += 2) {
  const wad = WadFile.parse(new Uint8Array(readFileSync(args[i]!)));
  const maps = new Map<string, MapData>();
  for (const m of wad.maps) if (m.format === "doom") maps.set(m.name.toUpperCase(), { fps: sectorFingerprints(wad, m), area: mapArea(wad, m), keys: geometryKeys(wad, m) });
  versions.push({ version: args[i + 1]!, maps });
}

interface Direction {
  readonly label: string;
  readonly maps: Array<{ name: string; src: MapData; dst: MapData; truth: Array<number | undefined>; hits: Array<Map<number, number> | null> }>;
}
const directions: Direction[] = [];
for (let i = 0; i + 1 < versions.length; i++) {
  for (const [a, b] of [
    [versions[i]!, versions[i + 1]!],
    [versions[i + 1]!, versions[i]!],
  ] as const) {
    const maps: Direction["maps"] = [];
    for (const [name, src] of a.maps) {
      const dst = b.maps.get(name);
      if (!dst) continue;
      // 每个源扇区的采样点落在目标各扇区内的比例
      const hits = src.fps.map((_, s) => {
        const pts = src.area.samples[s]!;
        if (pts.length === 0) return null;
        const h = new Map<number, number>();
        for (const [x, y] of pts) for (const t of dst.area.sectorsAt(x, y)) h.set(t, (h.get(t) ?? 0) + 1 / pts.length);
        return h;
      });
      maps.push({ name, src, dst, truth: geometryTruth(src.keys, dst.keys), hits });
    }
    directions.push({ label: `${a.version}→${b.version}`, maps });
  }
}

type Scorer = (e: SectorFingerprint, a: SectorFingerprint) => number;

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
  lowExact: number;
  lowRelocated: number;
  noSamples: number;
  collisions: number;
  selfAmbiguous: number;
}

function run(score: Scorer, dirs: readonly Direction[]): Stats {
  const s: Stats = { pins: 0, exact: 0, relocated: 0, ambiguous: 0, missing: 0, keyed: 0, keyedRight: 0, keyedWrong: 0, keyedRefused: 0, lowExact: 0, lowRelocated: 0, noSamples: 0, collisions: 0, selfAmbiguous: 0 };
  const selfSeen = new Set<MapData>();
  for (const d of dirs) {
    for (const m of d.maps) {
      const targets = new Map<number, number>();
      m.src.fps.forEach((fp, i) => {
        s.pins++;
        const c = classifyPin(m.dst.fps.map((x) => score(fp, x)), i);
        if (c.result === "CONFLICT_AMBIGUOUS") s.ambiguous++;
        else if (c.result === "CONFLICT_MISSING") s.missing++;
        else {
          if (c.result === "EXACT") s.exact++;
          else s.relocated++;
          targets.set(c.index, (targets.get(c.index) ?? 0) + 1);
          const h = m.hits[i];
          if (h === null || h === undefined) s.noSamples++;
          else if ((h.get(c.index) ?? 0) < 0.5) c.result === "EXACT" ? s.lowExact++ : s.lowRelocated++;
        }
        const truth = m.truth[i];
        if (truth !== undefined) {
          s.keyed++;
          if (c.result === "EXACT" || c.result === "RELOCATED") c.index === truth ? s.keyedRight++ : s.keyedWrong++;
          else s.keyedRefused++;
        }
      });
      for (const n of targets.values()) if (n > 1) s.collisions += n;
      // 同版本歧义：源地图上自己的指纹不是 EXACT（每张源地图只算一次）
      if (!selfSeen.has(m.src)) {
        selfSeen.add(m.src);
        m.src.fps.forEach((fp, i) => {
          if (classifyPin(m.src.fps.map((x) => score(fp, x)), i).result !== "EXACT") s.selfAmbiguous++;
        });
      }
    }
  }
  return s;
}

type Weights = Record<FingerprintPart, number>;
const ZERO: Weights = { centroid: 0, bbox: 0, area: 0, lineCount: 0, heights: 0, floorpic: 0, ceilingpic: 0, tag: 0 };

/**
 * 一组参数。bbox 有两种打分：overlap（产品用的重叠比例，slack 为 bboxSlack）和 edge（四条边中最大偏移按 bboxRadius 线性衰减）。
 * area 有两种：lin（产品用的面积比）和 sqrt（面积比开方）。
 */
function scorer(w: Partial<Weights>, o: { bbox?: "overlap" | "edge"; bboxSlack?: number; bboxRadius?: number; area?: "lin" | "sqrt" } = {}): Scorer {
  const weights = { ...ZERO, ...w };
  const p = { ...FINGERPRINT_PARAMS, weights, bboxSlack: o.bboxSlack ?? FINGERPRINT_PARAMS.bboxSlack };
  return (e, a) => {
    const parts = { ...sectorFingerprintParts(e, a, p) };
    if (o.bbox === "edge") {
      parts.bbox = e.bbox === null || a.bbox === null ? (e.bbox === a.bbox ? 1 : 0) : Math.max(0, 1 - Math.max(...e.bbox.map((v, k) => Math.abs(v - a.bbox![k]!))) / (o.bboxRadius ?? 32));
    }
    if (o.area === "sqrt") parts.area = Math.sqrt(parts.area);
    return weightedScore(parts, weights);
  };
}

/** 其余权重按旧公式的比例分配：heights 2 份，lineCount、floorpic、ceilingpic、tag 各 1 份。 */
const rest = (geometry: Partial<Weights>): Partial<Weights> => {
  const u = (1 - Object.values(geometry).reduce((a, b) => a + (b ?? 0), 0)) / 6;
  return { ...geometry, heights: 2 * u, lineCount: u, floorpic: u, ceilingpic: u, tag: u };
};

const configs: Array<[string, Scorer]> = [
  // 修复前的提交：没有 bbox 和面积，几何中心 0.4，半径 32
  ["old", scorer({ centroid: 0.4, lineCount: 0.1, heights: 0.2, floorpic: 0.1, ceilingpic: 0.1, tag: 0.1 })],
  ["default", scorer(FINGERPRINT_PARAMS.weights)],
];
const grid = process.env["CALIBRATE_GRID"];
if (grid === "1") {
  for (const [c, b] of [
    [0.2, 0.2],
    [0.2, 0.3],
    [0.1, 0.4],
    [0.25, 0.25],
    [0, 0.5],
  ] as const) {
    for (const br of [16, 32, 64]) configs.push([`edge c${c} b${b} r${br}`, scorer(rest({ centroid: c, bbox: b }), { bbox: "edge", bboxRadius: br })]);
  }
  for (const [c, b] of [
    [0.2, 0.3],
    [0.1, 0.4],
    [0.25, 0.25],
  ] as const) {
    for (const slack of [4, 8, 16]) configs.push([`overlap c${c} b${b} slack${slack}`, scorer(rest({ centroid: c, bbox: b }), { bboxSlack: slack })]);
  }
} else if (grid === "2") {
  for (const [c, b, a] of [
    [0.15, 0.2, 0.1],
    [0.15, 0.2, 0.2],
    [0.15, 0.3, 0.1],
    [0.15, 0.3, 0.2],
    [0.2, 0.2, 0.1],
    [0.2, 0.2, 0.2],
    [0.2, 0.25, 0.15],
    [0.2, 0.3, 0.1],
    [0.2, 0.3, 0.15],
    [0.2, 0.3, 0.2],
    [0.2, 0.3, 0.25],
    [0.2, 0.35, 0.2],
    [0.25, 0.3, 0.2],
    [0.25, 0.35, 0.25],
  ] as const) {
    for (const mode of ["lin", "sqrt"] as const) configs.push([`overlap+area ${mode} c${c} b${b} a${a}`, scorer(rest({ centroid: c, bbox: b, area: a }), { area: mode })]);
  }
}

const dumpName = process.env["CALIBRATE_DUMP"];
if (dumpName) {
  const score = configs.find(([n]) => n === dumpName)?.[1];
  if (!score) throw new Error(`no config named ${dumpName}`);
  for (const d of directions) {
    for (const m of d.maps) {
      const chosen = m.src.fps.map((fp, i) => classifyPin(m.dst.fps.map((x) => score(fp, x)), i));
      const byTarget = new Map<number, number[]>();
      chosen.forEach((c, i) => {
        if (c.result === "EXACT" || c.result === "RELOCATED") byTarget.set(c.index, [...(byTarget.get(c.index) ?? []), i]);
      });
      for (const [t, from] of byTarget) {
        if (from.length > 1) console.log(`SAME | ${d.label} | ${m.name} | ${from.map((i) => `#${i}(${chosen[i]!.result} ${(chosen[i] as { score: number }).score}, cov ${(m.hits[i]?.get(t) ?? 0).toFixed(2)})`).join(" ")} → #${t}`);
      }
      chosen.forEach((c, i) => {
        if (c.result !== "EXACT" && c.result !== "RELOCATED") return;
        const h = m.hits[i];
        if (!h || (h.get(c.index) ?? 0) >= 0.5) return;
        const best = [...h].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
        const second = c.candidates[1];
        console.log(
          [
            "LOW",
            d.label,
            m.name,
            `#${i}→#${c.index}`,
            c.result,
            `score ${c.score}`,
            `second ${second ? `#${second.index} ${second.score}` : "-"}`,
            `cov ${(h.get(c.index) ?? 0).toFixed(2)}`,
            `best ${best ? `#${best[0]} ${best[1].toFixed(2)}` : "-"}`,
            `samples ${m.src.area.samples[i]!.length}`,
            `src ${JSON.stringify(m.src.fps[i])}`,
            `dst ${JSON.stringify(m.dst.fps[c.index])}`,
          ].join(" | "),
        );
      });
    }
  }
  process.exit(0);
}

console.log("| 参数 | 方向 | pin | EXACT | RELOCATED | 歧义 | 缺失 | 对照一有 | 对照一一致 | 对照一选错 | 对照一拒绝 | 覆盖<0.5 EXACT | 覆盖<0.5 RELOCATED | 无采样 | 同目标 pin | 同版本歧义 |");
console.log("| :--- | :--- |" + " ---: |".repeat(14));
const groups = process.env["CALIBRATE_SPLIT"] === "1" ? directions.map((d) => [d.label, [d]] as const) : [["全部", directions] as const];
for (const [name, score] of configs) {
  for (const [label, dirs] of groups) {
    const s = run(score, dirs);
    console.log(
      `| ${name} | ${label} | ${s.pins} | ${s.exact} | ${s.relocated} | ${s.ambiguous} | ${s.missing} | ${s.keyed} | ${s.keyedRight} | ${s.keyedWrong} | ${s.keyedRefused} | ${s.lowExact} | ${s.lowRelocated} | ${s.noSamples} | ${s.collisions} | ${s.selfAmbiguous} |`,
    );
  }
}
