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


`dist/` 可以直接部署到静态服务器，也可以双击 `dist/index.html` 本地打开（需要浏览器允许 `file://` 页面使用存储，并允许跨域请求你的 API 地址）。首次使用在设置 → 数据管理里填写 API Key。

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

### 9.1 Android APK

仓库内置一个原生 WebView 壳，APK 产物为 `android/deepseek-unrestricted-2.7.8.apk`：

- 应用在 `http://127.0.0.1:18765` 启动本地静态服务器，再加载 `assets/public`，给 localStorage / IndexedDB / fetch 一个稳定的安全来源；
- 支持文件选择、拍照（系统相机 + content:// 回传）、麦克风权限、返回键和外部链接跳转；
- 构建需要 Android SDK 34、build-tools 34.0.0 与 JDK 17（JDK 27 会让 d8 崩溃）。仓库根目录提供一键脚本，会读取 `package.json` 的版本（当前 2.7.8 / 278），依次构建 Web、APK 并签名：
  ```sh
  KS_PASS=... ./构建APK.sh
  ```
  也可以手动执行：
  ```sh
  export ANDROID_HOME=$HOME/android-sdk
  export JAVA_HOME=/path/to/jdk-17
  pnpm build
  KS_PASS=... KEY_PASS=... ./android/build-apk.sh
  ```
- APK 使用 `xiaohuangbo.jks`、别名 `xiaohuangbo` 签名，versionCode 278；
- **Python 后端不会在 APK 内执行**：`android/assets/backend` 只打包 `mcp-server` 与 EasyJailbreak 源码供参考；实验台仍需在电脑或服务器上运行后端，并在「实验台」里把地址改为 `http://<电脑IP>:8765/mcp`。手机页面的 Origin 是 `http://127.0.0.1:18765`，已在后端允许来源内。

---

---

[← 返回 README](../../README.md) · [全部文档](README.md)
