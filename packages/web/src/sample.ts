/**
 * 内置样本：Freedoom 0.13.0 的 freedoom2.wad。构建脚本（scripts/fetch-freedoom.ts）和页面共用这些常量。
 * 两个哈希：zip 的来自官方 CHECKSUM 文件（freedoom-0.13.0-CHECKSUM，有 PGP 签名），WAD 的是从这个 zip 解出的文件。
 * Freedoom 以 BSD 许可发布，COPYING.txt 随站点一起发布。
 */
export const SAMPLE = {
  version: "Freedoom 0.13.0",
  file: "freedoom2.wad",
  zipUrl: "https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip",
  zipSha256: "3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59",
  /** zip 内的路径。 */
  wadEntry: "freedoom-0.13.0/freedoom2.wad",
  copyingEntry: "freedoom-0.13.0/COPYING.txt",
  wadSha256: "a8772e088847032510d97ba2312406a6998f21cbab44d4ff10696faa9c0ecd4b",
  wadSize: 28787748,
  /** 相对站点根目录。 */
  wadPath: "freedoom/freedoom2.wad",
  copyingPath: "freedoom/COPYING.txt",
} as const;
