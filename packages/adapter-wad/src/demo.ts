/** Doom v1.9 演示录像（LMP）的版本字节。引擎据此按 Doom/Doom2 v1.9 兼容级别回放。 */
export const DEMO_VERSION_19 = 109;

const DEMO_END = 0x80;
const MAP_MARKER = /^(?:E([1-9])M([1-9])|MAP(\d\d))$/i;

export interface IdleDemoOptions {
  /** 目标地图标记名，ExMy 或 MAPxx。 */
  readonly map: string;
  /** 回放的 tic 数，1 到 35 * 3600。 */
  readonly tics: number;
  /** 0 到 4，对应 ITYTD 到 Nightmare。默认 2（HMP）。 */
  readonly skill?: number;
}

/**
 * 生成单人、无输入的 v1.9 演示录像：玩家 1 在目标地图上原地不动，持续 tics 个 tic。
 * 用于引擎冒烟测试：引擎按录像载入地图并逐 tic 运行，录像结束后退出。
 * 文件结构：13 字节头、每 tic 4 字节输入（全零）、结束标记 0x80。
 */
export function buildIdleDemo(options: IdleDemoOptions): Uint8Array {
  const m = MAP_MARKER.exec(options.map);
  if (!m) throw new RangeError(`map ${options.map} is not an ExMy or MAPxx name`);
  const episode = m[3] !== undefined ? 1 : Number(m[1]);
  const map = m[3] !== undefined ? Number(m[3]) : Number(m[2]);
  if (map < 1) throw new RangeError(`map ${options.map} has number 0`);
  const skill = options.skill ?? 2;
  if (!Number.isInteger(skill) || skill < 0 || skill > 4) throw new RangeError(`skill ${skill} is not an integer in 0..4`);
  if (!Number.isInteger(options.tics) || options.tics < 1 || options.tics > 35 * 3600) {
    throw new RangeError(`tics ${options.tics} is not an integer in 1..${35 * 3600}`);
  }
  const out = new Uint8Array(13 + options.tics * 4 + 1);
  // version, skill, episode, map, deathmatch, respawn, fast, nomonsters, consoleplayer, playeringame[4]
  out.set([DEMO_VERSION_19, skill, episode, map, 0, 0, 0, 0, 0, 1, 0, 0, 0], 0);
  out[out.length - 1] = DEMO_END;
  return out;
}
