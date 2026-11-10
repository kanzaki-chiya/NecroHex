/**
 * 预设补丁：patches/ 下的示例文件，加上 Mockup 里的 careless-edit 样例（展示拒绝原因）。
 */
import haunted from "@patches/haunted-house.nhpatch.json";
import relocation from "@patches/relocation-demo.nhpatch.json";
import type { Json } from "./logic.ts";

export interface Preset {
  /** 列表里显示的文件名。 */
  readonly file: string;
  readonly patch: Json;
  readonly imported: boolean;
}

/** Mockup 的样例：把玩家出生点换成 Imp、贴图名超过 8 个字符，两处都会被拦下。 */
export const CARELESS_EDIT: Json = {
  schemaVersion: 1,
  name: "Careless Edit",
  target: { format: "wad", maps: ["MAP01"] },
  operations: [
    { id: "starts-to-imps", select: { record: "Thing", where: { type: { eq: 1 } } }, change: { type: { set: 3001 } } },
    { id: "long-flat-name", select: { record: "Sector", where: { floorpic: { eq: "SLIME14" } } }, change: { floorpic: { set: "BLOODPOOL9" } } },
  ],
};

export const BUILTIN_PRESETS: readonly Preset[] = [
  { file: "patches/haunted-house.nhpatch.json", patch: haunted as Json, imported: false },
  { file: "patches/relocation-demo.nhpatch.json", patch: relocation as Json, imported: false },
  { file: "(sample) careless-edit.nhpatch.json", patch: CARELESS_EDIT, imported: false },
];
