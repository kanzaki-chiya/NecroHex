/**
 * Doom / Doom II（含 Freedoom）的 Thing 类型表：编号、类别、碰撞尺寸和精灵前缀。
 * 尺寸取自原版引擎的 mobjinfo（半径、高度，单位为地图单位）；不产生对象的类型（例如死亡竞赛出生点）记名义尺寸。
 * 只收录原版类型。Boom、MBF 和 ZDoom 的扩展类型不在表里，补丁写入它们会被拒绝。
 */

export type ThingCategory =
  | "player-start"
  | "deathmatch-start"
  | "teleport-destination"
  | "key"
  | "monster"
  | "boss-support"
  | "weapon"
  | "ammo"
  | "health"
  | "armor"
  | "powerup"
  | "barrel"
  /** 立在地上、阻挡移动的装饰。 */
  | "obstacle"
  /** 挂在天花板上、阻挡移动的装饰。 */
  | "hanging-obstacle"
  /** 不阻挡移动的装饰。 */
  | "decoration";

export interface ThingInfo {
  readonly type: number;
  readonly name: string;
  readonly category: ThingCategory;
  readonly radius: number;
  readonly height: number;
  /** 精灵名前 4 个字符；不显示的类型为 null。 */
  readonly sprite: string | null;
}

/** 阻挡移动、替换后可能卡住的类别。 */
export const SOLID_CATEGORIES: ReadonlySet<ThingCategory> = new Set<ThingCategory>(["monster", "barrel", "obstacle", "hanging-obstacle"]);

type Row = readonly [type: number, name: string, radius: number, height: number, sprite: string | null];

const GROUPS: ReadonlyArray<readonly [ThingCategory, readonly Row[]]> = [
  ["player-start", [
    [1, "Player 1 start", 16, 56, "PLAY"],
    [2, "Player 2 start", 16, 56, "PLAY"],
    [3, "Player 3 start", 16, 56, "PLAY"],
    [4, "Player 4 start", 16, 56, "PLAY"],
  ]],
  ["deathmatch-start", [[11, "Deathmatch start", 16, 56, null]]],
  ["teleport-destination", [[14, "Teleport destination", 20, 16, null]]],
  ["key", [
    [5, "Blue keycard", 20, 16, "BKEY"],
    [6, "Yellow keycard", 20, 16, "YKEY"],
    [13, "Red keycard", 20, 16, "RKEY"],
    [38, "Red skull key", 20, 16, "RSKU"],
    [39, "Yellow skull key", 20, 16, "YSKU"],
    [40, "Blue skull key", 20, 16, "BSKU"],
  ]],
  ["monster", [
    [3004, "Zombieman", 20, 56, "POSS"],
    [9, "Shotgun guy", 20, 56, "SPOS"],
    [65, "Heavy weapon dude", 20, 56, "CPOS"],
    [3001, "Imp", 20, 56, "TROO"],
    [3002, "Demon", 30, 56, "SARG"],
    [58, "Spectre", 30, 56, "SARG"],
    [3006, "Lost soul", 16, 56, "SKUL"],
    [3005, "Cacodemon", 31, 56, "HEAD"],
    [69, "Hell knight", 24, 64, "BOS2"],
    [3003, "Baron of Hell", 24, 64, "BOSS"],
    [68, "Arachnotron", 64, 64, "BSPI"],
    [71, "Pain elemental", 31, 56, "PAIN"],
    [66, "Revenant", 20, 56, "SKEL"],
    [67, "Mancubus", 48, 64, "FATT"],
    [64, "Arch-vile", 20, 56, "VILE"],
    [7, "Spider Mastermind", 128, 100, "SPID"],
    [16, "Cyberdemon", 40, 110, "CYBR"],
    [84, "Wolfenstein SS", 20, 56, "SSWV"],
    [72, "Commander Keen", 16, 72, "KEEN"],
  ]],
  ["boss-support", [
    [88, "Boss brain", 16, 16, "BBRN"],
    [89, "Boss shooter", 20, 32, null],
    [87, "Boss spawn spot", 20, 32, null],
  ]],
  ["weapon", [
    [2005, "Chainsaw", 20, 16, "CSAW"],
    [2001, "Shotgun", 20, 16, "SHOT"],
    [82, "Super shotgun", 20, 16, "SGN2"],
    [2002, "Chaingun", 20, 16, "MGUN"],
    [2003, "Rocket launcher", 20, 16, "LAUN"],
    [2004, "Plasma gun", 20, 16, "PLAS"],
    [2006, "BFG9000", 20, 16, "BFUG"],
  ]],
  ["ammo", [
    [2007, "Clip", 20, 16, "CLIP"],
    [2048, "Box of bullets", 20, 16, "AMMO"],
    [2008, "Shells", 20, 16, "SHEL"],
    [2049, "Box of shells", 20, 16, "SBOX"],
    [2010, "Rocket", 20, 16, "ROCK"],
    [2046, "Box of rockets", 20, 16, "BROK"],
    [2047, "Cell", 20, 16, "CELL"],
    [17, "Cell pack", 20, 16, "CELP"],
    [8, "Backpack", 20, 16, "BPAK"],
  ]],
  ["health", [
    [2014, "Health bonus", 20, 16, "BON1"],
    [2011, "Stimpack", 20, 16, "STIM"],
    [2012, "Medikit", 20, 16, "MEDI"],
  ]],
  ["armor", [
    [2015, "Armor bonus", 20, 16, "BON2"],
    [2018, "Green armor", 20, 16, "ARM1"],
    [2019, "Blue armor", 20, 16, "ARM2"],
  ]],
  ["powerup", [
    [2013, "Soulsphere", 20, 16, "SOUL"],
    [83, "Megasphere", 20, 16, "MEGA"],
    [2022, "Invulnerability", 20, 16, "PINV"],
    [2023, "Berserk", 20, 16, "PSTR"],
    [2024, "Partial invisibility", 20, 16, "PINS"],
    [2025, "Radiation suit", 20, 16, "SUIT"],
    [2026, "Computer area map", 20, 16, "PMAP"],
    [2045, "Light amplification visor", 20, 16, "PVIS"],
  ]],
  ["barrel", [[2035, "Exploding barrel", 10, 42, "BAR1"]]],
  ["obstacle", [
    [2028, "Floor lamp", 16, 16, "COLU"],
    [30, "Tall green pillar", 16, 16, "COL1"],
    [31, "Short green pillar", 16, 16, "COL2"],
    [32, "Tall red pillar", 16, 16, "COL3"],
    [33, "Short red pillar", 16, 16, "COL4"],
    [36, "Short green pillar with heart", 16, 16, "COL5"],
    [37, "Short red pillar with skull", 16, 16, "COL6"],
    [35, "Candelabra", 16, 16, "CBRA"],
    [41, "Evil eye", 16, 16, "CEYE"],
    [42, "Floating skull rock", 16, 16, "FSKU"],
    [43, "Burnt tree", 16, 16, "TRE1"],
    [54, "Big tree", 32, 16, "TRE2"],
    [44, "Tall blue firestick", 16, 16, "TBLU"],
    [45, "Tall green firestick", 16, 16, "TGRN"],
    [46, "Tall red firestick", 16, 16, "TRED"],
    [55, "Short blue firestick", 16, 16, "SMBT"],
    [56, "Short green firestick", 16, 16, "SMGT"],
    [57, "Short red firestick", 16, 16, "SMRT"],
    [47, "Stalagmite", 16, 16, "SMIT"],
    [48, "Tall techno column", 16, 16, "ELEC"],
    [70, "Burning barrel", 16, 16, "FCAN"],
    [85, "Tall techno floor lamp", 16, 16, "TLMP"],
    [86, "Short techno floor lamp", 16, 16, "TLP2"],
    [25, "Impaled human", 16, 16, "POL1"],
    [26, "Twitching impaled human", 16, 16, "POL6"],
    [27, "Skull on a pole", 16, 16, "POL4"],
    [28, "Five skulls shish kebab", 16, 16, "POL2"],
    [29, "Pile of skulls and candles", 16, 16, "POL3"],
  ]],
  ["hanging-obstacle", [
    [49, "Hanging victim, twitching", 16, 68, "GOR1"],
    [50, "Hanging victim, arms out", 16, 84, "GOR2"],
    [51, "Hanging victim, one-legged", 16, 84, "GOR3"],
    [52, "Hanging pair of legs", 16, 68, "GOR4"],
    [53, "Hanging leg", 16, 52, "GOR5"],
    [73, "Hanging victim, guts removed", 16, 88, "HDB1"],
    [74, "Hanging victim, guts and brain removed", 16, 88, "HDB2"],
    [75, "Hanging torso, looking down", 16, 64, "HDB3"],
    [76, "Hanging torso, open skull", 16, 64, "HDB4"],
    [77, "Hanging torso, looking up", 16, 64, "HDB5"],
    [78, "Hanging torso, brain removed", 16, 64, "HDB6"],
  ]],
  ["decoration", [
    [34, "Candle", 20, 16, "CAND"],
    [59, "Hanging victim, arms out (non-blocking)", 20, 84, "GOR2"],
    [60, "Hanging pair of legs (non-blocking)", 20, 68, "GOR4"],
    [61, "Hanging victim, one-legged (non-blocking)", 20, 52, "GOR3"],
    [62, "Hanging leg (non-blocking)", 20, 52, "GOR5"],
    [63, "Hanging victim, twitching (non-blocking)", 20, 68, "GOR1"],
    [10, "Bloody mess", 20, 16, "PLAY"],
    [12, "Bloody mess 2", 20, 16, "PLAY"],
    [15, "Dead player", 20, 16, "PLAY"],
    [18, "Dead zombieman", 20, 16, "POSS"],
    [19, "Dead shotgun guy", 20, 16, "SPOS"],
    [20, "Dead imp", 20, 16, "TROO"],
    [21, "Dead demon", 20, 16, "SARG"],
    [22, "Dead cacodemon", 20, 16, "HEAD"],
    [23, "Dead lost soul", 20, 16, "SKUL"],
    [24, "Pool of blood and flesh", 20, 16, "POL5"],
    [79, "Pool of blood", 20, 16, "POB1"],
    [80, "Pool of blood 2", 20, 16, "POB2"],
    [81, "Pool of brains", 20, 16, "BRS1"],
  ]],
];

export const THING_TYPES: ReadonlyMap<number, ThingInfo> = new Map(
  GROUPS.flatMap(([category, rows]) =>
    rows.map(([type, name, radius, height, sprite]): [number, ThingInfo] => [type, Object.freeze({ type, name, category, radius, height, sprite })]),
  ),
);

export function thingInfo(type: number): ThingInfo | undefined {
  return THING_TYPES.get(type);
}

/**
 * 原版引擎在特定地图上依赖的 Boss 类型：它们全部死亡时触发 tag 666/667 的扇区动作或结束关卡。
 * 按地图名判断，不读取 UMAPINFO 等扩展定义。
 */
const MAP_BOSSES: Readonly<Record<string, readonly number[]>> = {
  MAP07: [67, 68],
  E1M8: [3003],
  E2M8: [16],
  E3M8: [7],
  E4M6: [16],
  E4M8: [7],
};

/** 任何地图上都有特殊作用的类型：Commander Keen（全部死亡打开 tag 666）、Boss brain、Boss shooter 和刷怪点。 */
const ANY_MAP_BOSSES: readonly number[] = [72, 88, 89, 87];

export function mapBossTypes(mapName: string): ReadonlySet<number> {
  return new Set([...(MAP_BOSSES[mapName.toUpperCase()] ?? []), ...ANY_MAP_BOSSES]);
}
