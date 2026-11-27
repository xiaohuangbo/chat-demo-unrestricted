## 9. 运行与构建

**Windows 用户**可以直接双击仓库根目录的两个脚本：

- `启动chat-web前端.bat`：自动检测 Node.js / pnpm / `node_modules`，缺失时通过 winget / corepack / npm 自动安装，然后启动 http://localhost:8090；
- `启动mcp后端越狱实验台.bat`：自动检测 Python / `.venv` / MCP 依赖 / fastchat / torch / datasets / EasyJailbreak，缺失时自动安装；EasyJailbreak 会先尝试 pip 安装，失败再尝试 GitHub 与镜像克隆，最后启动 http://127.0.0.1:8765/mcp。

手动方式（任意系统），准备 Node.js 22.12+ 与 pnpm：

```sh
git clone https://github.com/xiaohuangbo/chat-demo-unrestricted.git
cd chat-demo-unrestricted
pnpm install
pnpm dev        # http://localhost:8090
```

生成静态产物：

```sh
pnpm build      # 产物在 dist/
```
本地模型用到的 `@mlc-ai/web-llm@0.2.87` 会打进构建产物，并额外产出一个 Web Worker chunk（约 6 MB）；模型权重与 wasm 库不在包里，首次使用时从 Hugging Face / GitHub Raw 下载并写入浏览器缓存。


`dist/index.html` 里包含首屏加载页（内联 CSS / JS，见 `src/index.html`）：主包执行前先按本机主题与语言显示字标、转圈与提示，界面渲染完自动淡出移除，不依赖任何外部资源。`dist/` 可以直接部署到静态服务器，也可以双击 `dist/index.html` 本地打开（需要浏览器允许 `file://` 页面使用存储，并允许跨域请求你的 API 地址）。首次使用在设置 → 数据管理里填写 API Key。

本地模型必须在 http(s) 页面下运行：`file://` 打开时 Worker 与 WebGPU 都受限制；MLC-LLM API 也需要目标服务允许跨域。

| 命令          | 用途                   |
| ------------- | ---------------------- |
| `pnpm dev`    | 启动开发服务器（8090） |
| `pnpm build`  | 构建到 `dist/`         |
| `pnpm type`   | TypeScript 类型检查    |
| `pnpm lint`   | oxlint 检查            |
| `pnpm format` | oxfmt 格式化           |

API 地址在 [`rspack.config.ts`](../../rspack.config.ts) 的 `createConfig({ apiOrigin })` 里配置，默认 `https://api.deepseek.com`。

WebVM（CheerpX）需要跨源隔离。浏览器版如果部署在 GitHub Pages 这类不能自定义响应头的静态托管上，第一次启用 WebVM 时会注册 `coi-sw.js` 并刷新一次，之后由 Service Worker 为同源响应补头。**Android WebView 不支持跨源隔离（Chromium issue 40914606），所以 APK 内无法运行 WebVM；请在手机 Chrome 或桌面浏览器里打开在线版。** 也可以自己在 Nginx / Vercel 上直接配置 `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: credentialless`，省掉这次刷新。

Unkernel 默认在主线程运行，不需要跨源隔离；多 CPU 需要跨源隔离，静态站点会注册 `coi-sw.js` 并刷新一次。完整页面、内核 wasm（UP + SMP）与 Alpine / Debian 镜像从 `public/unkernel/` 复制到 `dist/unkernel/`，Android 资源服务器会对镜像响应 `Range` 请求。它需要 JSPI，旧 WebView 会显示启动错误而不是终端。

**重建 `public/unkernel/`。** 页面来自上游 `pithings/unkernel` 的 `web/`（Vite + Nitro），构建时会从最新 GitHub Release 下载内核与发行版镜像：

```sh
cd ../unkernel                # 上游 checkout
pnpm install
KW_BASE=/unkernel/ pnpm -C web build
PORT=3100 node web/.output/server/index.mjs &   # Nitro 渲染 index.html
curl -s http://127.0.0.1:3100/unkernel/ -o web/.output/public/index.html
find web/.output/public -type f \( -name '*.br' -o -name '*.gz' -o -name '*.zst' \) -delete
rsync -a --delete web/.output/public/ ../chat-demo-unrestricted/public/unkernel/
cd ../chat-demo-unrestricted && pnpm patch:unkernel
```

- **复制进产物时不要二次压缩**：`public/unkernel/` 是上游 Vite 构建好的产物，`rspack.config.ts` 的复制规则带 `info: { minimized: true }`；漏掉它，生产构建的 SWC 会再压一遍，把 `vk-host` 分块改坏（Vulkan 渲染器报 TDZ）。`pnpm build` 末尾的 `scripts/check-unkernel-assets.mjs` 会逐字节比对 `public/unkernel` 与 `dist/unkernel`，被改写就直接失败。
`KW_BASE=/unkernel/` 让 Vite 生成带前缀的资源与预加载地址；`pnpm patch:unkernel` 再补发行版镜像、`/vm-sw.js`、`/vm/` 预览路径与 manifest（脚本按模板字面量匹配，重复运行安全）。除 `.br/.gz/.zst` 预压缩副本外不要删其它文件：`index.html` 必须来自 Nitro（SSR 模板），其余直接取 `.output/public` 即可。

页面里的 `dropLegacyScope` 检查必须保留：它只会注销脚本名以 `/vm-sw.js` 结尾的根作用域 Service Worker，不能把宿主应用的 `coi-sw.js` 一起注销；否则多 CPU 的 iframe 重载会因缺少 COEP 被 Firefox 拦成 `NS_ERROR_DOM_COEP_FAILED`。这段保护在 `web/src/sw.ts`。

DSH go 是 `go-deepseek` 仓库 `cmd/dsh-go` 的构建产物（aarch64 静态 Go 二进制，约 24 MiB），现在作为普通应用放在 `web/src/apps/agents/dsh-go.ts`，二进制从 `web/public/demos/dsh-go/dsh-go-linux-arm64` 随页面分发；应用里固定了它的 SHA-256 和字节数，重新编译后要同步更新这两个值，否则页面会拒绝把文件推入 guest。

宿主设置通过 URL 参数传入（`distro`、`datasize`、`net`、`sound`、`display`、`data`、`worker`、`cpus`、`wisp`），并固定带 `routes=0` 让 guest 的纯 HTTP 也走 Wisp（否则 Debian 的 apt 会被上游 CORS 镜像的 Origin 白名单挡成 403）；内核内存由页面自己的设置决定，宿主不传 `mem`。参数细节见 `src/services/unkernel/config.ts`。

### 9.1 Android APK

仓库内置一个原生 WebView 壳，APK 产物为 `android/deepseek-unrestricted-2.7.21.apk`（约 118 MB，超过 GitHub 100 MB 单文件限制，已加入 `.gitignore`，请作为 Release 资产上传）：

- 应用在 `http://127.0.0.1:18765` 启动本地静态服务器，再加载 `assets/public`，给 localStorage / IndexedDB / fetch 一个稳定的安全来源；
- 支持文件选择、拍照（系统相机 + content:// 回传）、麦克风权限、返回键和外部链接跳转；
- 构建需要 Android SDK 34、build-tools 35.0.1+（34.0.0 的 d8 在 JDK 21 下可能崩溃）与 JDK 21/17。仓库根目录提供一键脚本，会读取 `package.json` 的版本（当前 2.7.21 / 291），依次构建 Web、APK 并签名：
  ```sh
  KS_PASS=... ./构建APK.sh
  ```
  也可以直接运行 `android/build-apk.sh`（默认交互式，询问版本、签名文件、输出路径、是否构建 Web / 安装）：
  ```sh
  export ANDROID_HOME=$HOME/android-sdk
  export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
  ./android/build-apk.sh
  # 非交互：KS_PASS=... ./android/build-apk.sh --yes --no-build-web
  ```
- APK 使用 `xiaohuangbo.jks`、别名 `xiaohuangbo` 签名，versionCode 291；
- **Python 后端不会在 APK 内执行**：`android/assets/backend` 只打包 `mcp-server` 与 EasyJailbreak 源码供参考；实验台仍需在电脑或服务器上运行后端，并在「实验台」里把地址改为 `http://<电脑IP>:8765/mcp`。手机页面的 Origin 是 `http://127.0.0.1:18765`，已在后端允许来源内。

---

---

[← 返回 README](../../README.md) · [全部文档](README.md)
