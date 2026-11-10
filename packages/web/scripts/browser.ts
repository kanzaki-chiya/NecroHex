/**
 * 截图和导出验证脚本共用：用本机已安装的 Edge 或 Chrome（playwright-core 不下载浏览器）。
 */
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright-core";

const CANDIDATES = [
  process.env["NECROHEX_BROWSER"],
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((p): p is string => !!p);

export async function launch(): Promise<Browser> {
  const executablePath = CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) throw new Error("no Edge or Chrome found; set NECROHEX_BROWSER to a Chromium-based browser");
  return chromium.launch({ executablePath, headless: true });
}
