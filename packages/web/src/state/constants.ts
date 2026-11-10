/**
 * 来自 Mockup 的显示常量：special 的说明、图例、扇区颜色。只用于显示，不参与任何检查。
 */
import { THING_TYPES } from "@necrohex/adapter-wad";

export const SPECIAL: Readonly<Record<number, string>> = {
  0: "none",
  1: "light blinks randomly",
  2: "light blinks 0.5 s",
  3: "light blinks 1 s",
  4: "blink + 20% damage",
  5: "damage 10%",
  7: "damage 5%",
  8: "light glows",
  9: "secret",
  12: "light sync 0.5 s",
  13: "light sync 1 s",
  16: "damage 20%",
  17: "light flickers",
};

export const SPECIAL_OPTIONS: readonly (readonly [number, string])[] = Object.entries(SPECIAL).map(([k, t]) => [Number(k), t] as const);

export const LEGEND: readonly (readonly [color: string, label: string])[] = [
  ["hsl(200 9% 26%)", "Light level"],
  ["hsl(357 55% 20%)", "Blood floor"],
  ["var(--stain)", "Changed by the operation"],
  ["var(--review)", "Relocated, review"],
  ["var(--blocked)", "Write blocked"],
];

export const lightFill = (light: number, blood: boolean): string =>
  blood ? `hsl(357 55% ${6 + (light / 255) * 24}%)` : `hsl(200 9% ${4 + (light / 255) * 30}%)`;

export const typeName = (t: number): string => THING_TYPES.get(t)?.name ?? `unknown type ${t}`;

export const THING_OPTIONS: readonly { readonly value: string; readonly label: string }[] = [...THING_TYPES.values()].map((i) => ({
  value: String(i.type),
  label: `${i.name} (${i.category})`,
}));

export const hexOf = (n: number, w: number): string => n.toString(16).toUpperCase().padStart(w, "0");
