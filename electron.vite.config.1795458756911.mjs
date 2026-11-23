// electron.vite.config.ts
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// package.json
var package_default = {
  name: "enso-code",
  version: "0.3.13",
  description: "EnsoCode - Electron Multi-Window Scaffold",
  main: "./out/main/index.js",
  bin: {
    enso: "./scripts/enso-cli.mjs"
  },
  author: {
    name: "EnsoAI Team",
    email: "i@j3.do"
  },
  license: "AGPL-3.0-only",
  type: "module",
  packageManager: "pnpm@10.26.2",
  scripts: {
    predev: "pnpm rtk:prepare",
    dev: "electron-vite dev",
    build: "electron-vite build && vite build -c vite.web-preload.config.ts",
    preview: "electron-vite preview",
    "build:mac": "pnpm build && electron-builder --mac",
    "build:mac:dir": "pnpm build && electron-builder --mac --arm64 --dir -c.mac.notarize=false",
    "build:win": "pnpm build && electron-builder --win",
    "build:linux": "pnpm build && electron-builder --linux",
    "build:server": "pnpm build && vite build -c vite.server.config.ts",
    "build:server:bundle": "vite build -c vite.server.config.ts",
    "pack:server": "node scripts/pack-server.mjs",
    "harbor:eval": "node scripts/harbor-eval.mjs",
    "generate:themes": "npx tsx scripts/generate-themes.ts",
    "rtk:prepare": "node scripts/prepare-rtk.mjs",
    "knowledge:check": "npx tsx scripts/knowledge.ts check",
    "knowledge:clean": "npx tsx scripts/knowledge.ts clean",
    "knowledge:compact": "npx tsx scripts/knowledge.ts compact",
    "memory:compact": "npx tsx scripts/memory-compact.ts",
    typecheck: "tsc --noEmit",
    lint: "biome check .",
    "lint:fix": "biome check --write .",
    test: "node scripts/test.mjs",
    "test:changed": "node scripts/test-changed.mjs",
    "test:formal": "ENSO_FORMAL_FULL=1 vitest run src/renderer/stores/sessions/deliveryEcho.formal.test.ts src/agent/turnPhase.formal.test.ts src/main/services/agentService.formal.test.ts",
    "test:e2e:server": "ENSO_RUN_E2E=1 vitest run src/server/run/cli.e2e.test.ts",
    "test:watch": "vitest",
    format: "biome format --write .",
    postinstall: "node node_modules/electron/install.js && node scripts/fix-node-pty-helper.mjs"
  },
  dependencies: {
    "@bufbuild/protobuf": "^2.14.0",
    "@earendil-works/pi-agent-core": "1.5.1",
    "@earendil-works/pi-ai": "1.5.1",
    "@earendil-works/pi-coding-agent": "1.5.1",
    "@earendil-works/pi-mcp": "1.5.1",
    "@earendil-works/pi-tui": "1.5.1",
    "@electron-toolkit/utils": "^4.0.0",
    "@huggingface/tokenizers": "0.2.0",
    "@modelcontextprotocol/sdk": "^1.32.2",
    "@mozilla/readability": "^0.6.0",
    "@rahularya01/pi-cursor": "1.4.39",
    "@vscode/ripgrep": "1.17.0",
    "better-sqlite3": "^13.0.3",
    "electron-updater": "^6.8.11",
    koffi: "^3.3.1",
    level: "^10.0.0",
    linkedom: "^0.18.13",
    "node-datachannel": "^0.33.2",
    "node-pty": "^1.1.0",
    "quickjs-wasi": "3.6.0",
    "smol-toml": "^1.9.1",
    "sqlite-vec": "0.1.9",
    turndown: "^7.2.4",
    tweetnacl: "^1.0.3",
    typebox: "1.3.27",
    undici: "^8.12.4",
    "web-push": "^3.6.7",
    yaml: "^2.9.0"
  },
  devDependencies: {
    "@base-ui/react": "^1.7.0",
    "@biomejs/biome": "^2.5.10",
    "@dnd-kit/core": "^6.3.1",
    "@dnd-kit/modifiers": "^9.0.0",
    "@dnd-kit/sortable": "^10.0.0",
    "@dnd-kit/utilities": "^3.2.2",
    "@electron-toolkit/tsconfig": "^2.0.0",
    "@pierre/diffs": "^1.3.5",
    "@shikijs/themes": "4.4.3",
    "@tailwindcss/vite": "^4.3.3",
    "@types/better-sqlite3": "^9.6.0",
    "@types/hast": "^3.0.5",
    "@types/mdast": "^4.0.4",
    "@types/node": "^26.2.0",
    "@types/qrcode": "^1.5.6",
    "@types/react": "^19.2.18",
    "@types/react-dom": "^19.2.5",
    "@types/turndown": "^5.0.6",
    "@types/web-push": "^3.6.4",
    "@types/ws": "^8.18.2",
    "@vitejs/plugin-react": "^5.0.4",
    "@xterm/addon-fit": "^0.11.0",
    "@xterm/addon-search": "^0.16.0",
    "@xterm/addon-serialize": "^0.14.0",
    "@xterm/addon-unicode11": "^0.9.0",
    "@xterm/addon-web-links": "^0.12.0",
    "@xterm/xterm": "^6.0.0",
    "boring-avatars": "2.0.4",
    "class-variance-authority": "^0.7.1",
    clsx: "^2.1.1",
    cytoscape: "3.34.2",
    "cytoscape-fcose": "2.2.0",
    "dockview-react": "^8.2.0",
    electron: "^45.3.1",
    "electron-builder": "^26.18.0",
    "electron-vite": "^5.0.0",
    "framer-motion": "^13.1.1",
    "hast-util-sanitize": "^5.0.2",
    "lucide-react": "^1.33.0",
    mermaid: "^11.17.2",
    prettier: "^3.9.9",
    qrcode: "^1.5.4",
    react: "^19.2.8",
    "react-dom": "^19.2.8",
    "react-markdown": "^10.1.0",
    "react-virtuoso": "^4.18.12",
    "rehype-parse": "^9.0.1",
    "rehype-raw": "^7.0.0",
    "rehype-sanitize": "^6.0.0",
    "rehype-stringify": "^10.0.1",
    "remark-gfm": "^4.0.1",
    shiki: "4.4.3",
    "tailwind-merge": "^3.6.0",
    tailwindcss: "^4.3.3",
    typescript: "^7.0.2",
    unified: "^11.0.5",
    "unist-util-visit": "^5.1.0",
    vite: "^7.1.9",
    vitest: "^4.1.11",
    ws: "^8.21.3",
    zustand: "^5.0.15"
  },
  engines: {
    node: ">=22"
  },
  pnpm: {
    onlyBuiltDependencies: [
      "@google/genai",
      "@vscode/ripgrep",
      "classic-level",
      "electron",
      "electron-winstaller",
      "esbuild",
      "node-llama-cpp",
      "node-pty",
      "onnxruntime-node",
      "protobufjs",
      "workerd"
    ],
    ignoredBuiltDependencies: [
      "better-sqlite3"
    ],
    patchedDependencies: {
      "@earendil-works/pi-ai@1.5.1": "patches/@earendil-works__pi-ai@1.5.1.patch",
      "@rahularya01/pi-cursor@1.4.39": "patches/@rahularya01__pi-cursor@1.4.39.patch",
      "@earendil-works/pi-coding-agent@1.5.1": "patches/@earendil-works__pi-coding-agent@1.5.1.patch",
      "electron-vite@5.0.0": "patches/electron-vite@5.0.0.patch"
    }
  },
  optionalDependencies: {
    "node-llama-cpp": "3.20.0"
  }
};

// electron.vite.config.ts
var __electron_vite_injected_dirname = "/Users/j3n5en/project/worktree/3e8dba26-4323-404d-9a0f-bfc787a8cace/01027e2c";
var pairAlias = path.resolve(__electron_vite_injected_dirname, "packages/pair/src/index.ts");
function rendererDevServer() {
  const raw = process.env.ENSO_RENDERER_PORT?.trim();
  if (!raw) return void 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`ENSO_RENDERER_PORT must be an integer TCP port`);
  }
  return { host: "127.0.0.1", port, strictPort: true };
}
var rendererServer = rendererDevServer();
var electron_vite_config_default = defineConfig({
  main: {
    build: {
      // Agent utilityProcess 走 `?modulePath` isolated build；Main 保持官方单入口，
      // 避免手工 multi-input 把无 export 的启动入口 tree-shake 成 0B facade。
      externalizeDeps: true,
      rollupOptions: {
        // externalizeDeps 只认 dependencies；node-llama-cpp 在 optionalDependencies 里，
        // 被打进 bundle 后它对 .node 绑定的动态 require 会失效。
        external: ["node-llama-cpp"]
      }
    },
    resolve: {
      alias: {
        "@shared": path.resolve(__electron_vite_injected_dirname, "src/shared"),
        "@enso/pair": pairAlias,
        "@platform": path.resolve(__electron_vite_injected_dirname, "src/main/desktop/platform.ts")
      }
    }
  },
  preload: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: path.resolve(__electron_vite_injected_dirname, "src/preload/index.ts"),
          // 远程节点壳（主窗口节点层与节点设置窗口）：只暴露 __ensoRemote
          nodeRemote: path.resolve(__electron_vite_injected_dirname, "src/preload/nodeRemote.ts"),
          // 拖放浮窗：不暴露 API，只处理拖放
          dropShelf: path.resolve(__electron_vite_injected_dirname, "src/preload/dropShelf.ts")
        }
      }
    },
    resolve: {
      alias: {
        "@shared": path.resolve(__electron_vite_injected_dirname, "src/shared")
      }
    }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    define: {
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(package_default.version)
    },
    resolve: {
      alias: {
        "@": path.resolve(__electron_vite_injected_dirname, "src/renderer"),
        "@shared": path.resolve(__electron_vite_injected_dirname, "src/shared"),
        "@enso/pair": pairAlias
      }
    },
    // diff 高亮 worker（@pierre/diffs）含动态 import，iife 格式打不了，需 es
    worker: { format: "es" },
    build: {
      // electron-vite renderer 默认 minify:false，未压缩的 mermaid/shiki chunk 有十几 MB
      minify: "esbuild",
      rollupOptions: {
        input: {
          index: path.resolve(__electron_vite_injected_dirname, "src/renderer/index.html"),
          settings: path.resolve(__electron_vite_injected_dirname, "src/renderer/settings.html")
        }
      }
    },
    ...rendererServer ? { server: rendererServer } : {}
  }
});
export {
  electron_vite_config_default as default
};
