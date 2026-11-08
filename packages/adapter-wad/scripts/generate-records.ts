/**
 * 从 spec/wad.records.yaml 生成 src/generated/records.ts。
 * 用法：node scripts/generate-records.ts [--check]
 * --check 只比较，不写文件；生成结果过期时以非零状态退出。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

type FieldType = "int16" | "uint16" | "name8";

interface FieldSpec {
  name: string;
  type: FieldType;
  count?: number;
}

interface RecordSpec {
  lump: string;
  size: number;
  fields: FieldSpec[];
}

const TYPE_SIZE: Record<FieldType, number> = { int16: 2, uint16: 2, name8: 8 };
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fail(message: string): never {
  throw new Error(`wad.records.yaml: ${message}`);
}

function validate(doc: unknown): Record<string, RecordSpec> {
  if (typeof doc !== "object" || doc === null || !("records" in doc)) fail("missing top-level `records`");
  const records = (doc as { records: unknown }).records;
  if (typeof records !== "object" || records === null) fail("`records` must be a map");
  const out: Record<string, RecordSpec> = {};
  for (const [name, raw] of Object.entries(records)) {
    if (!IDENT.test(name)) fail(`invalid record name ${name}`);
    const spec = raw as Partial<RecordSpec>;
    if (typeof spec.lump !== "string" || !/^[A-Z0-9_]{1,8}$/.test(spec.lump)) fail(`${name}: bad lump name`);
    if (!Number.isInteger(spec.size) || (spec.size as number) <= 0) fail(`${name}: bad size`);
    if (!Array.isArray(spec.fields) || spec.fields.length === 0) fail(`${name}: no fields`);
    const seen = new Set<string>();
    let total = 0;
    for (const f of spec.fields) {
      if (!IDENT.test(f.name)) fail(`${name}: invalid field name ${String(f.name)}`);
      if (seen.has(f.name)) fail(`${name}: duplicate field ${f.name}`);
      seen.add(f.name);
      if (!(f.type in TYPE_SIZE)) fail(`${name}.${f.name}: unknown type ${String(f.type)}`);
      if (f.count !== undefined && (!Number.isInteger(f.count) || f.count < 2)) fail(`${name}.${f.name}: count must be an integer >= 2`);
      total += TYPE_SIZE[f.type] * (f.count ?? 1);
    }
    if (total !== spec.size) fail(`${name}: fields add up to ${total} bytes but size is ${spec.size}`);
    out[name] = spec as RecordSpec;
  }
  return out;
}

function tsType(f: FieldSpec): string {
  const base = f.type === "name8" ? "string" : "number";
  return f.count ? `readonly [${Array.from({ length: f.count }, () => base).join(", ")}]` : base;
}

function readExpr(f: FieldSpec, offset: number): string {
  const one = (o: number): string => {
    switch (f.type) {
      case "int16":
        return `view.getInt16(offset + ${o}, true)`;
      case "uint16":
        return `view.getUint16(offset + ${o}, true)`;
      case "name8":
        return `decodeName8(view, offset + ${o})`;
    }
  };
  if (!f.count) return one(offset);
  const step = TYPE_SIZE[f.type];
  return `[${Array.from({ length: f.count }, (_, i) => one(offset + i * step)).join(", ")}]`;
}

export function generateRecordsSource(yamlText: string): string {
  const records = validate(parse(yamlText));
  const names = Object.keys(records);
  const lines: string[] = [];
  lines.push(
    "// 由 scripts/generate-records.ts 根据 spec/wad.records.yaml 生成。",
    "// 不要手工编辑；修改 YAML 后重新运行 `pnpm --filter @necrohex/adapter-wad generate`。",
    "",
    'import { decodeName8, encodeField, type RecordLayout } from "../field-codec.ts";',
    "",
  );

  for (const [name, spec] of Object.entries(records)) {
    lines.push(`export interface ${name} {`);
    for (const f of spec.fields) lines.push(`  readonly ${f.name}: ${tsType(f)};`);
    lines.push("}", "");

    lines.push(`export const ${name}Layout = {`, `  name: ${JSON.stringify(name)},`, `  lump: ${JSON.stringify(spec.lump)},`, `  size: ${spec.size},`, "  fields: {");
    let offset = 0;
    const offsets: number[] = [];
    for (const f of spec.fields) {
      offsets.push(offset);
      const count = f.count ?? 1;
      lines.push(`    ${f.name}: { offset: ${offset}, type: ${JSON.stringify(f.type)}, count: ${count} },`);
      offset += TYPE_SIZE[f.type] * count;
    }
    lines.push("  },", "} as const satisfies RecordLayout;", "");

    lines.push(`export function read${name}(view: DataView, offset: number): ${name} {`, "  return {");
    spec.fields.forEach((f, i) => lines.push(`    ${f.name}: ${readExpr(f, offsets[i]!)},`));
    lines.push("  };", "}", "");

    lines.push(
      `/** 把 ${name}.<field> 的新值编码为字节，写入位置为记录偏移加 ${name}Layout.fields[field].offset。 */`,
      `export function encode${name}Field<K extends keyof ${name}>(field: K, value: ${name}[K]): Uint8Array {`,
      `  return encodeField(${name}Layout.fields[field], ${JSON.stringify(name)} + "." + field, value);`,
      "}",
      "",
    );
  }

  lines.push("export interface RecordTypes {");
  for (const n of names) lines.push(`  ${n}: ${n};`);
  lines.push("}", "", "export type RecordName = keyof RecordTypes;", "");
  lines.push("export const RECORD_LAYOUTS = {");
  for (const n of names) lines.push(`  ${n}: ${n}Layout,`);
  lines.push("} as const;", "");
  lines.push("export const RECORD_READERS: { [K in RecordName]: (view: DataView, offset: number) => RecordTypes[K] } = {");
  for (const n of names) lines.push(`  ${n}: read${n},`);
  lines.push("};", "");
  lines.push("export const RECORD_BY_LUMP: Readonly<Record<string, RecordName>> = {");
  for (const [n, s] of Object.entries(records)) lines.push(`  ${s.lump}: ${JSON.stringify(n)},`);
  lines.push("};", "");
  return lines.join("\n");
}

const here = dirname(fileURLToPath(import.meta.url));
export const SPEC_PATH = resolve(here, "../spec/wad.records.yaml");
export const OUTPUT_PATH = resolve(here, "../src/generated/records.ts");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const source = generateRecordsSource(readFileSync(SPEC_PATH, "utf8"));
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(OUTPUT_PATH, "utf8");
    } catch {
      /* 缺失视为过期 */
    }
    if (current !== source) {
      console.error("src/generated/records.ts is out of date. Run `pnpm generate`.");
      process.exit(1);
    }
  } else {
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, source);
    console.log(`wrote ${OUTPUT_PATH}`);
  }
}
