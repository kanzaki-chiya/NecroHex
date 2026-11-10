/**
 * 用真实浏览器截图，存到仓库根目录的 out/（git 忽略）：
 * - workbench-1440.png、workbench-390.png（整页）：正式版，默认预设 haunted-house；
 * - mockup-1440.png：docs/workbench-mockup/index.html，同一预设（它的默认预设也是 haunted-house）；
 * - compare-1440.png：两张 1440 截图并排，左边示例，右边正式版。
 * 先启动 dev 或 preview 服务器。用法：node scripts/screenshots.ts [url]，默认 http://localhost:5173/
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Page } from "playwright-core";
import { launch } from "./browser.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const OUT = join(REPO, "out");
const url = process.argv[2] ?? process.env["NECROHEX_WEB_URL"] ?? "http://localhost:5173/";
mkdirSync(OUT, { recursive: true });

const browser = await launch();
const errors: string[] = [];

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => /^(Ready|Rejected)/.test(document.querySelector("#verdict .big")?.textContent ?? ""), null, { timeout: 90_000 });
  // 回执哈希在规划之后算出；字体加载完
  await page.waitForFunction(() => !!document.querySelector("#verdict .hash"), null, { timeout: 30_000 }).catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
}

async function shoot(name: string, target: string, width: number, height: number, fullPage: boolean): Promise<string> {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${name}: ${m.text()}`);
  });
  await page.goto(target);
  await ready(page);
  const path = join(OUT, name);
  await page.screenshot({ path, fullPage });
  await page.close();
  console.log(`wrote ${path}`);
  return path;
}

const mock = await shoot("mockup-1440.png", pathToFileURL(join(REPO, "docs/workbench-mockup/index.html")).href, 1440, 900, false);
const real = await shoot("workbench-1440.png", url, 1440, 900, false);
await shoot("workbench-390.png", url, 390, 844, true);
await shoot("workbench-390-top.png", url, 390, 844, false);

// 并排：在一个空白页里放两张图再截图
const b64 = (p: string) => `data:image/png;base64,${readFileSync(p).toString("base64")}`;
const page = await browser.newPage({ viewport: { width: 2 * 1440 + 24, height: 900 + 40 }, deviceScaleFactor: 1 });
await page.setContent(
  `<body style="margin:0;background:#000;color:#ccc;font:14px sans-serif;display:flex;gap:24px">` +
    `<figure style="margin:0"><figcaption style="height:40px;line-height:40px;padding-left:8px">docs/workbench-mockup/index.html</figcaption><img src="${b64(mock)}" width="1440" height="900"></figure>` +
    `<figure style="margin:0"><figcaption style="height:40px;line-height:40px;padding-left:8px">packages/web (${url})</figcaption><img src="${b64(real)}" width="1440" height="900"></figure></body>`,
);
await page.screenshot({ path: join(OUT, "compare-1440.png") });
console.log(`wrote ${join(OUT, "compare-1440.png")}`);
await browser.close();

if (errors.length) {
  console.error("browser errors:\n" + errors.join("\n"));
  process.exitCode = 1;
}
