// 独立程序入口（Node SEA 的 main）。
//
// SEA 对 ESM 入口不可靠，所以这个文件是**纯 CJS 且零依赖**——只用 node 内置模块。
// 前端构建产物（index.html + assets/*.js|.css）在构建时内联成 SEA 资源，
// 运行时从内存里发出去；官方立绘/语音/3D 模型不内联（体积 35MB、且是别人的版权素材），
// 改成「exe 同目录的 assets/ 里有就用，没有就回落到远端 PRTS」。
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const VERSION = "__VERSION__";
const MARKER = "__MARKER__";

function sea() {
  try {
    return require("node:sea");
  } catch {
    return null;
  }
}

/** 内联资源：SEA 里走 getRawAsset，直接 node 跑时回落到磁盘。
 *
 * 注意：不能用 getAsset(name, "buffer") —— Node 24 上直接抛
 * ERR_ENCODING_NOT_SUPPORTED: The "buffer" encoding is not supported（实测）。
 * 二进制一律用 getRawAsset（返回 ArrayBuffer）。
 */
function readAsset(name) {
  const s = sea();
  if (s && s.isSea()) {
    try {
      return Buffer.from(s.getRawAsset(name));
    } catch {
      return null;
    }
  }
  const p = path.join(__dirname, "build", "web", name);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".mp3": "audio/mpeg",
  ".glb": "model/gltf-binary",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

function mimeOf(p) {
  return MIME[path.extname(p).toLowerCase()] || "application/octet-stream";
}

/** 用户放在 exe 旁边的素材（立绘、语音、模型），路径做越界保护 */
function diskAsset(rel, rootDir) {
  const safe = path.normalize(rel).replace(/^([/\\])+/, "");
  if (safe.includes("..")) return null;
  const p = path.join(rootDir, "assets", safe);
  return fs.existsSync(p) && fs.statSync(p).isFile() ? p : null;
}

function selfTest() {
  let manifest = null;
  try {
    const raw = readAsset("manifest.json");
    manifest = raw ? JSON.parse(raw.toString("utf8")) : null;
  } catch {
    manifest = null;
  }
  console.log(`amadeus-exusiai ${VERSION}`);
  const s = sea();
  const keys = s && s.isSea() ? s.getAssetKeys() : [];
  console.log(`SEA 内联资源键 ${keys.length} 个: ${keys.slice(0, 8).join(", ")}${keys.length > 8 ? " …" : ""}`);
  if (!manifest) {
    console.error("自检失败：读不到内联的 manifest.json，说明 SEA 注入没生效");
    process.exit(1);
  }
  const files = manifest.files || [];
  const missing = files.filter((f) => !readAsset(f));
  const total = files.reduce((n, f) => {
    const b = readAsset(f);
    return n + (b ? b.length : 0);
  }, 0);
  const html = readAsset("index.html");
  const okMarker = Boolean(html && html.toString("utf8").includes(MARKER));
  console.log(`内联资源 ${files.length} 个，合计 ${(total / 1024).toFixed(1)} KB`);
  console.log(`页面标记 ${JSON.stringify(MARKER)}: ${okMarker ? "PASS" : "FAIL"}`);
  console.log(`资源完整性: ${missing.length === 0 ? "PASS" : "FAIL " + missing.join(",")}`);
  // 关键：第一行打印的必须是这个程序的版本号，不是 Node 的版本号（注入失败会打印 Node 版本）
  if (!okMarker || missing.length) {
    console.error("自检失败：要么注入没生效，要么资源不全");
    process.exit(1);
  }
  process.exit(0);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(VERSION);
    return;
  }
  if (argv.includes("--self-test")) {
    selfTest();
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`用法: amadeus-exusiai [选项]

把「新约能天使」的对话终端跑在本地，自动用默认浏览器打开。

选项:
  --port <n>     监听端口（默认 17800，被占用时自动往后找）
  --no-open      不自动打开浏览器
  --self-test    只做产物自检（验证前端资源真的被内联进来）
  --version      打印版本号
  --help         显示这段帮助

素材：把官方立绘/语音/3D 模型放在本程序同目录的 assets/ 下即可（可选）。
  没有素材也能跑：立绘与语音会回落到 PRTS 的在线地址。
`);
    return;
  }

  const portArg = argv.indexOf("--port");
  const wantPort = portArg >= 0 ? Number(argv[portArg + 1]) : Number(process.env.PORT) || 17800;
  const noOpen = argv.includes("--no-open");
  const rootDir = process.env.SEA_ROOT || path.dirname(process.execPath);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const p = decodeURIComponent(url.pathname);

    // 后端接口：独立程序里没有 LLM 代理与 WebRTC 服务，
    // 返回明确的「未配置」，前端会退到本地人格引擎（src/lib/api.ts 里写好了）。
    if (p === "/api/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ configured: false, model: null, persona: "offline" }));
      return;
    }
    if (p.startsWith("/api/")) {
      res.writeHead(501, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "独立程序不含 LLM 代理，请用 npm run dev:api" }));
      return;
    }
    if (p.startsWith("/rtc/")) {
      res.writeHead(501, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "独立程序不含 WebRTC 语音服务" }));
      return;
    }

    const rel = p === "/" ? "index.html" : p.replace(/^\//, "");

    // 1) 内联的应用资源（index.html / assets/*.js|*.css）
    const embedded = readAsset(rel);
    if (embedded) {
      res.writeHead(200, { "content-type": mimeOf(rel), "cache-control": "no-cache" });
      res.end(embedded);
      return;
    }

    // 2) exe 同目录 assets/ 下用户自备的素材
    if (rel.startsWith("assets/")) {
      const onDisk = diskAsset(rel.slice("assets/".length), rootDir);
      if (onDisk) {
        res.writeHead(200, { "content-type": mimeOf(onDisk), "cache-control": "no-cache" });
        fs.createReadStream(onDisk).pipe(res);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("没有这个素材。把它放到本程序同目录的 assets/ 下即可。");
      return;
    }

    // 3) 其余路径交给前端路由
    const html = readAsset("index.html");
    if (html) {
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end(html);
    } else {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("内联资源缺失，请重新构建");
    }
  });

  const tryListen = (port) =>
    new Promise((resolve, reject) => {
      const onErr = (e) => {
        server.removeListener("listening", onOk);
        reject(e);
      };
      const onOk = () => {
        server.removeListener("error", onErr);
        resolve(port);
      };
      server.once("error", onErr);
      server.once("listening", onOk);
      server.listen(port, "127.0.0.1");
    });

  let port = wantPort;
  for (let i = 0; i < 20; i++) {
    try {
      port = await tryListen(wantPort + i);
      break;
    } catch (e) {
      if (e.code !== "EADDRINUSE" || i === 19) throw e;
    }
  }

  const url = `http://127.0.0.1:${port}/`;
  console.log(`amadeus-exusiai ${VERSION}`);
  console.log(`已启动: ${url}`);
  console.log(`素材目录: ${path.join(rootDir, "assets")}（可选；没有就回落到在线 PRTS）`);
  console.log("按 Ctrl+C 退出。");

  if (!noOpen) {
    const cmd =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    execFile(cmd[0], cmd[1], () => {});
  }
}

main().catch((e) => {
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(1);
});
