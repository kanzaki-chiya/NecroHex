/**
 * 在真实浏览器里用默认预设（haunted-house）导出 PWAD 和回执，存到仓库根目录的 out/：
 * 打开工作台 → Export PWAD → 改文件名 → 下载 PWAD 和回执。之后可以用 `necrohex verify` 或 verify_output 验证。
 * 先启动 dev 或 preview 服务器。用法：node scripts/export-in-browser.ts [url] [文件名]
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { launch } from "./browser.ts";

const REPO = resolve(import.meta.dirname, "../../..");
const OUT = join(REPO, "out");
const url = process.argv[2] ?? process.env["NECROHEX_WEB_URL"] ?? "http://localhost:5173/";
const name = process.argv[3] ?? "haunted-house-web";
mkdirSync(OUT, { recursive: true });

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
page.on("pageerror", (e) => console.error(`pageerror: ${e.message}`));
await page.goto(url);
await page.waitForFunction(() => (document.querySelector("#verdict .big")?.textContent ?? "").startsWith("Ready"), null, { timeout: 90_000 });
await page.click("#export");
await page.waitForSelector("#savePwad", { timeout: 60_000 });
await page.fill("#exportName", name);
const save = async (selector: string) => {
  const [d] = await Promise.all([page.waitForEvent("download"), page.click(selector)]);
  const path = join(OUT, d.suggestedFilename());
  if (existsSync(path)) rmSync(path);
  await d.saveAs(path);
  console.log(`saved ${path}`);
};
await save("#savePwad");
await save("#saveReceipt");
console.log((await page.locator("dialog.export .body").innerText()).trim());
await browser.close();
