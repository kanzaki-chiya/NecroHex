// 由 scripts/generate-records.ts 根据 spec/wad.records.yaml 生成。
// 不要手工编辑；修改 YAML 后重新运行 `pnpm --filter @necrohex/adapter-wad generate`。

import { decodeName8, encodeField, type RecordLayout } from "../field-codec.ts";

export interface Sector {
  readonly floorheight: number;
  readonly ceilingheight: number;
  readonly floorpic: string;
  readonly ceilingpic: string;
  readonly lightlevel: number;
  readonly special: number;
  readonly tag: number;
}

export const SectorLayout = {
  name: "Sector",
  lump: "SECTORS",
  size: 26,
  fields: {
    floorheight: { offset: 0, type: "int16", count: 1 },
    ceilingheight: { offset: 2, type: "int16", count: 1 },
    floorpic: { offset: 4, type: "name8", count: 1 },
    ceilingpic: { offset: 12, type: "name8", count: 1 },
    lightlevel: { offset: 20, type: "int16", count: 1 },
    special: { offset: 22, type: "int16", count: 1 },
    tag: { offset: 24, type: "int16", count: 1 },
  },
} as const satisfies RecordLayout;

export function readSector(view: DataView, offset: number): Sector {
  return {
    floorheight: view.getInt16(offset + 0, true),
    ceilingheight: view.getInt16(offset + 2, true),
    floorpic: decodeName8(view, offset + 4),
    ceilingpic: decodeName8(view, offset + 12),
    lightlevel: view.getInt16(offset + 20, true),
    special: view.getInt16(offset + 22, true),
    tag: view.getInt16(offset + 24, true),
  };
}

/** 把 Sector.<field> 的新值编码为字节，写入位置为记录偏移加 SectorLayout.fields[field].offset。 */
export function encodeSectorField<K extends keyof Sector>(field: K, value: Sector[K]): Uint8Array {
  return encodeField(SectorLayout.fields[field], "Sector" + "." + field, value);
}

export interface Thing {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
  readonly type: number;
  readonly flags: number;
}

export const ThingLayout = {
  name: "Thing",
  lump: "THINGS",
  size: 10,
  fields: {
    x: { offset: 0, type: "int16", count: 1 },
    y: { offset: 2, type: "int16", count: 1 },
    angle: { offset: 4, type: "int16", count: 1 },
    type: { offset: 6, type: "int16", count: 1 },
    flags: { offset: 8, type: "uint16", count: 1 },
  },
} as const satisfies RecordLayout;

export function readThing(view: DataView, offset: number): Thing {
  return {
    x: view.getInt16(offset + 0, true),
    y: view.getInt16(offset + 2, true),
    angle: view.getInt16(offset + 4, true),
    type: view.getInt16(offset + 6, true),
    flags: view.getUint16(offset + 8, true),
  };
}

/** 把 Thing.<field> 的新值编码为字节，写入位置为记录偏移加 ThingLayout.fields[field].offset。 */
export function encodeThingField<K extends keyof Thing>(field: K, value: Thing[K]): Uint8Array {
  return encodeField(ThingLayout.fields[field], "Thing" + "." + field, value);
}

export interface Linedef {
  readonly v1: number;
  readonly v2: number;
  readonly flags: number;
  readonly special: number;
  readonly tag: number;
  readonly sidenum: readonly [number, number];
}

export const LinedefLayout = {
  name: "Linedef",
  lump: "LINEDEFS",
  size: 14,
  fields: {
    v1: { offset: 0, type: "uint16", count: 1 },
    v2: { offset: 2, type: "uint16", count: 1 },
    flags: { offset: 4, type: "uint16", count: 1 },
    special: { offset: 6, type: "int16", count: 1 },
    tag: { offset: 8, type: "int16", count: 1 },
    sidenum: { offset: 10, type: "int16", count: 2 },
  },
} as const satisfies RecordLayout;

export function readLinedef(view: DataView, offset: number): Linedef {
  return {
    v1: view.getUint16(offset + 0, true),
    v2: view.getUint16(offset + 2, true),
    flags: view.getUint16(offset + 4, true),
    special: view.getInt16(offset + 6, true),
    tag: view.getInt16(offset + 8, true),
    sidenum: [view.getInt16(offset + 10, true), view.getInt16(offset + 12, true)],
  };
}

/** 把 Linedef.<field> 的新值编码为字节，写入位置为记录偏移加 LinedefLayout.fields[field].offset。 */
export function encodeLinedefField<K extends keyof Linedef>(field: K, value: Linedef[K]): Uint8Array {
  return encodeField(LinedefLayout.fields[field], "Linedef" + "." + field, value);
}

export interface Sidedef {
  readonly textureoffset: number;
  readonly rowoffset: number;
  readonly toptexture: string;
  readonly bottomtexture: string;
  readonly midtexture: string;
  readonly sector: number;
}

export const SidedefLayout = {
  name: "Sidedef",
  lump: "SIDEDEFS",
  size: 30,
  fields: {
    textureoffset: { offset: 0, type: "int16", count: 1 },
    rowoffset: { offset: 2, type: "int16", count: 1 },
    toptexture: { offset: 4, type: "name8", count: 1 },
    bottomtexture: { offset: 12, type: "name8", count: 1 },
    midtexture: { offset: 20, type: "name8", count: 1 },
    sector: { offset: 28, type: "int16", count: 1 },
  },
} as const satisfies RecordLayout;

export function readSidedef(view: DataView, offset: number): Sidedef {
  return {
    textureoffset: view.getInt16(offset + 0, true),
    rowoffset: view.getInt16(offset + 2, true),
    toptexture: decodeName8(view, offset + 4),
    bottomtexture: decodeName8(view, offset + 12),
    midtexture: decodeName8(view, offset + 20),
    sector: view.getInt16(offset + 28, true),
  };
}

/** 把 Sidedef.<field> 的新值编码为字节，写入位置为记录偏移加 SidedefLayout.fields[field].offset。 */
export function encodeSidedefField<K extends keyof Sidedef>(field: K, value: Sidedef[K]): Uint8Array {
  return encodeField(SidedefLayout.fields[field], "Sidedef" + "." + field, value);
}

export interface Vertex {
  readonly x: number;
  readonly y: number;
}

export const VertexLayout = {
  name: "Vertex",
  lump: "VERTEXES",
  size: 4,
  fields: {
    x: { offset: 0, type: "int16", count: 1 },
    y: { offset: 2, type: "int16", count: 1 },
  },
} as const satisfies RecordLayout;

export function readVertex(view: DataView, offset: number): Vertex {
  return {
    x: view.getInt16(offset + 0, true),
    y: view.getInt16(offset + 2, true),
  };
}

/** 把 Vertex.<field> 的新值编码为字节，写入位置为记录偏移加 VertexLayout.fields[field].offset。 */
export function encodeVertexField<K extends keyof Vertex>(field: K, value: Vertex[K]): Uint8Array {
  return encodeField(VertexLayout.fields[field], "Vertex" + "." + field, value);
}

export interface RecordTypes {
  Sector: Sector;
  Thing: Thing;
  Linedef: Linedef;
  Sidedef: Sidedef;
  Vertex: Vertex;
}

export type RecordName = keyof RecordTypes;

export const RECORD_LAYOUTS = {
  Sector: SectorLayout,
  Thing: ThingLayout,
  Linedef: LinedefLayout,
  Sidedef: SidedefLayout,
  Vertex: VertexLayout,
} as const;

export const RECORD_READERS: { [K in RecordName]: (view: DataView, offset: number) => RecordTypes[K] } = {
  Sector: readSector,
  Thing: readThing,
  Linedef: readLinedef,
  Sidedef: readSidedef,
  Vertex: readVertex,
};

export const RECORD_BY_LUMP: Readonly<Record<string, RecordName>> = {
  SECTORS: "Sector",
  THINGS: "Thing",
  LINEDEFS: "Linedef",
  SIDEDEFS: "Sidedef",
  VERTEXES: "Vertex",
};
