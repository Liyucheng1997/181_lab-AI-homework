// 构建纯网页版（GitHub Pages）：public/ + chart.js + 打包成浏览器可用的 Claude SDK → dist/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { build } from "esbuild";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(path.join(root, "public"), dist, { recursive: true });
fs.mkdirSync(path.join(dist, "vendor"), { recursive: true });
fs.copyFileSync(
  path.join(root, "node_modules/chart.js/dist/chart.umd.js"),
  path.join(dist, "vendor/chart.umd.js")
);

await build({
  stdin: { contents: 'export { default } from "@anthropic-ai/sdk";', resolveDir: root },
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  outfile: path.join(dist, "vendor/anthropic-sdk.js"),
  logLevel: "warning"
});

console.log("纯网页版已构建到 dist/");
