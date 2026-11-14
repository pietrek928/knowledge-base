import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import copy from "rollup-plugin-copy";
import { WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEV = process.env.DEV === "true";
const DIST = resolve(__dirname, "dist");
const SRC = resolve(__dirname, "src");
const ICON_SVG = join(SRC, "icons", "icon.svg");
const ICON_SIZES = [16, 48, 128];
const RELOAD_PORT = 9333;

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8"));
const VERSION = pkg.version;

let wss = null;
let sessionId = null;
let generation = 0;
let lastFinalizedHash = null;

function assertPortFree(port) {
  return new Promise((resolvePromise, reject) => {
    const srv = createServer();
    srv.once("error", (err) => {
      reject(
        new Error(
          `Live-reload port ${port} is already in use (${err.code}). Stop the other process or leave DEV=false.`
        )
      );
    });
    srv.once("listening", () => {
      srv.close(() => resolvePromise());
    });
    srv.listen(port, "127.0.0.1");
  });
}

function broadcastReload() {
  if (!wss) return;
  const frame = JSON.stringify({
    type: "reload",
    sessionId,
    generation,
  });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(frame);
  }
}

async function ensureWss() {
  if (!DEV || wss) return;
  await assertPortFree(RELOAD_PORT);
  sessionId = randomUUID();
  generation = 0;
  wss = new WebSocketServer({ host: "127.0.0.1", port: RELOAD_PORT });
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "hello", sessionId, generation }));
  });
  console.log(`[gemini-kb] live reload ws://127.0.0.1:${RELOAD_PORT} session=${sessionId}`);
}

function writeBuildMeta(contentHash) {
  const meta = {
    version: VERSION,
    contentHash,
    builtAt: new Date().toISOString(),
    dev: DEV,
  };
  writeFileSync(join(DIST, "build-meta.json"), JSON.stringify(meta, null, 2) + "\n");
  writeFileSync(
    join(DIST, "build-meta.js"),
    `globalThis.__KB_BUILD_META__ = ${JSON.stringify(meta)};\n`
  );
}

function patchDistManifest() {
  const manifestPath = join(DIST, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.content_scripts?.[0]) {
    throw new Error("dist/manifest.json missing content_scripts[0]");
  }
  manifest.content_scripts[0].js = ["build-meta.js", "content.js"];
  manifest.background = { service_worker: "background.js" };
  manifest.action = { ...(manifest.action || {}), default_popup: "popup.html" };

  const hosts = new Set(manifest.host_permissions || []);
  if (DEV) hosts.add("http://127.0.0.1:9333/*");
  else hosts.delete("http://127.0.0.1:9333/*");
  manifest.host_permissions = [...hosts];

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

function applyDevReload() {
  const destReload = join(DIST, "dev-reload.js");
  if (!DEV) {
    if (existsSync(destReload)) unlinkSync(destReload);
    return;
  }
  copyFileSync(join(SRC, "dev", "reload.js"), destReload);
  const bgPath = join(DIST, "background.js");
  let bg = readFileSync(bgPath, "utf8");
  if (!bg.startsWith('importScripts("dev-reload.js")')) {
    writeFileSync(bgPath, 'importScripts("dev-reload.js");\n' + bg);
  }
}

function renderIcons() {
  if (!existsSync(ICON_SVG)) {
    throw new Error(`icon source missing: ${ICON_SVG}`);
  }
  const outDir = join(DIST, "icons");
  mkdirSync(outDir, { recursive: true });
  for (const size of ICON_SIZES) {
    const dest = join(outDir, `icon${size}.png`);
    const r = spawnSync(
      "rsvg-convert",
      ["-w", String(size), "-h", String(size), "-o", dest, ICON_SVG],
      { encoding: "utf8" }
    );
    if (r.status !== 0) {
      throw new Error(
        `rsvg-convert failed for ${size}px: ${r.stderr || r.stdout || r.error || "unknown"}`
      );
    }
  }
}

function finalizeDist() {
  const contentPath = join(DIST, "content.js");
  if (!existsSync(contentPath)) {
    throw new Error("finalize: dist/content.js missing");
  }
  if (!existsSync(join(DIST, "background.js"))) {
    throw new Error("finalize: dist/background.js missing");
  }
  if (!existsSync(join(DIST, "popup.js"))) {
    throw new Error("finalize: dist/popup.js missing");
  }
  if (!existsSync(join(DIST, "manifest.json"))) {
    throw new Error("finalize: dist/manifest.json missing");
  }

  renderIcons();

  const contentJs = readFileSync(contentPath);
  const contentHash = createHash("sha256").update(contentJs).digest("hex").slice(0, 16);
  writeBuildMeta(contentHash);
  patchDistManifest();
  applyDevReload();

  const bg = readFileSync(join(DIST, "background.js"), "utf8");
  if (/importScripts\s*\(\s*["']constants\.js["']/.test(bg)) {
    throw new Error('dist/background.js still importScripts("constants.js")');
  }

  if (contentHash === lastFinalizedHash) return;
  lastFinalizedHash = contentHash;

  if (DEV) {
    generation += 1;
    broadcastReload();
    console.log(`[gemini-kb] build generation=${generation} contentHash=${contentHash}`);
  } else {
    console.log(`[gemini-kb] build contentHash=${contentHash}`);
  }
}

function sharedPlugins({ withCopy = false, finalize = false } = {}) {
  const plugins = [
    nodeResolve({ browser: true, preferBuiltins: false }),
    commonjs(),
  ];
  if (withCopy) {
    plugins.push(
      copy({
        targets: [
          { src: "src/manifest.json", dest: "dist" },
          { src: "src/popup/index.html", dest: "dist", rename: "popup.html" },
        ],
        hook: "writeBundle",
      })
    );
  }
  plugins.push({
    name: "gemini-kb-build",
    async buildStart() {
      if (withCopy) {
        lastFinalizedHash = null;
        await ensureWss();
      }
      this.addWatchFile(join(SRC, "manifest.json"));
      this.addWatchFile(join(SRC, "popup", "index.html"));
      this.addWatchFile(join(SRC, "dev", "reload.js"));
      this.addWatchFile(ICON_SVG);
    },
    writeBundle() {
      if (finalize) finalizeDist();
    },
  });
  return plugins;
}

const iifeEntries = [
  { name: "background", input: resolve(SRC, "background/main.js") },
  { name: "content", input: resolve(SRC, "content/main.js") },
  { name: "popup", input: resolve(SRC, "popup/main.js") },
];

const extensionConfigs = iifeEntries.map((entry, idx) => ({
  input: entry.input,
  output: {
    file: join(DIST, `${entry.name}.js`),
    format: "iife",
    // Side-effect entries (listeners); no global name required.
    strict: true,
  },
  plugins: sharedPlugins({
    withCopy: idx === 0,
    // Finalize after the last IIFE entry.
    finalize: idx === iifeEntries.length - 1,
  }),
}));

export default extensionConfigs;
