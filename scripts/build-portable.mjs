// 打 Windows 绿色免安装版：单个 exe，拷到任意目录双击即用。
//
// 为什么不用 `tauri build --bundles app`：Tauri 2 在 Windows 上 `--bundles`
// 只接受 `msi|nsis`（`app` 仅 macOS 支持）。改用 cargo 直接构建 src-tauri，
// 其默认 feature `custom-protocol` 会把 `dist/` 前端资源内嵌进 exe。
//
// 用法：
//   npm run build:portable              # 先构建前端，再编译并产出 dist-bin/*.exe
//   npm run build:portable -- --skip-frontend   # 复用现有 dist/
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const crate = "wb-switch-rust";
const product = "workbuddy-switch";

function run(cmd) {
  execSync(cmd, { cwd: root, stdio: "inherit" });
}

if (process.platform !== "win32") {
  console.error(
    "build:portable 仅用于 Windows 绿色版；macOS / Linux 请使用 npm run build:app。",
  );
  process.exit(1);
}

const skipFrontend = process.argv.includes("--skip-frontend");

if (skipFrontend) {
  // 内嵌资源来自 dist/，缺失会把打不开的包静默产出，这里直接拦下。
  if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
    console.error("dist/index.html 不存在，请去掉 --skip-frontend 或先执行 npm run build。");
    process.exit(1);
  }
  console.log("[1/3] 跳过前端构建（复用现有 dist/）");
} else {
  // dist/ 会被内嵌进 exe，而 cargo build 不会触发 beforeBuildCommand，
  // 不先构建会把旧前端打进去。
  console.log("[1/3] 构建前端");
  run("npm run build");
}

console.log("[2/3] 编译 Release（cargo）");
run(`cargo build -p ${crate} --release`);

// 版本以 App 实际版本（src-tauri/tauri.conf.json）为准，而不是 package.json，
// 后者可能因发版脚本先一步 bump，导致文件名与 App 内显示版本不一致。
const appVersion = JSON.parse(
  fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"),
).version;
const pkgVersion = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8"),
).version;
if (appVersion !== pkgVersion) {
  console.warn(
    `警告：App 版本 ${appVersion} 与 package.json ${pkgVersion} 不一致，文件名以 ${appVersion} 为准。`,
  );
}

const src = path.join(root, "target", "release", `${crate}.exe`);
if (!fs.existsSync(src)) {
  console.error(`未找到产物: ${src}`);
  process.exit(1);
}

console.log("[3/3] 复制绿色版");
const outDir = path.join(root, "dist-bin");
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${product}-${appVersion}-portable.exe`);
try {
  fs.copyFileSync(src, out);
} catch (err) {
  if (err.code === "EBUSY" || err.code === "EPERM") {
    console.error(
      `\n写入失败：${out} 正在被占用。请先完全退出正在运行的 workbuddy-switch（含托盘图标），再重跑本命令。`,
    );
  }
  throw err;
}

const sizeMb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
console.log(`\n绿色版已生成: ${out} (${sizeMb} MB)`);
console.log("单文件免安装，可直接双击运行（依赖系统 WebView2）。");
console.log("注意：未签名，App 内自动更新不可用，需手动替换 exe。");
