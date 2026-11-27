# Android APK（DeepSeek Unrestricted 2.7.21）

这是纯原生 WebView 壳，不依赖 Capacitor / Cordova：

- `MainActivity` 启动一个只监听 `127.0.0.1:18765` 的本地静态服务器，把 `assets/public` 作为网页根目录；
- WebView 打开 `http://127.0.0.1:18765/index.html`，因此 localStorage、IndexedDB、fetch 都有稳定的 HTTP Origin；
- 已接入文件选择器、拍照（系统相机 + content:// 回传）、麦克风运行时权限、返回键和外部浏览器跳转；
- Android WebView 不支持跨源隔离（SharedArrayBuffer），所以 WebVM 无法在 APK 内运行；应用内会提示用手机 Chrome / 桌面浏览器打开在线版，NanoVM 不受影响；
- WebView 也没有 WebGPU，浏览器内的 WebLLM 模型不可用；设置 → 本地模型里改用 MLC-LLM API 或切回云端模型；
- `assets/backend` 内含 `mcp-server` 与 EasyJailbreak 源码，仅作随包附带；Python / torch 后端不会在 Android 内执行；
- `assets/public/unkernel/` 是 Unkernel Linux 的完整页面、UP/SMP 内核与 Alpine 镜像，资源服务器对 `alpine.erofs` 支持 HTTP Range；WebView 支持 JSPI 时可直接运行。

## 产物

`android/deepseek-unrestricted-2.7.21.apk`（本地构建产物，已加入 `.gitignore`，作为 Release 资产上传），versionCode 291，使用
`/home/xiaohuangbo/桌面/xiaohuangbo.jks`（别名 `xiaohuangbo`）签名。

SHA-256：`57babf16b091338cdd2ad46fed9df22cfdf1f384c253a41fc1c286430a7a00c9`（118 MB，123,764,738）。

## 上传 Release

APK 超过 GitHub 单文件 100 MB 限制，不能提交进仓库。构建后上传到 Release：

```sh
gh release upload 2.7.21 android/deepseek-unrestricted-2.7.21.apk --clobber
```

## 构建

仓库根目录的 `构建APK.sh` 会自动读取 `package.json` 版本、构建 Web、调用本目录脚本并输出根目录 APK：

```sh
KS_PASS=<keystore-password> ./构建APK.sh
```

版本号由构建脚本注入（`aapt2 link --replace-version`），`AndroidManifest.xml` 里的值只是兜底，因此改 `package.json` 的版本就会同时改 APK 的 versionCode / versionName。

手动构建需要：

- Android SDK platform 34、build-tools **35.0.1 或更新**（34.0.0 的 d8 在 JDK 21 下可能因匿名类的空 MethodParameters 崩溃）；
- JDK 21（或 17；脚本会自动选 21，JDK 27 下 `-source 8` 也可能被拒绝）；
- 已执行 `pnpm build` 生成 `../dist`，或让脚本构建。

`android/build-apk.sh` 默认交互式：会依次询问版本名、版本号、签名文件、别名、口令、输出路径，以及是否先构建 Web、是否安装到设备。非交互环境用 `--yes`：

```sh
export ANDROID_HOME=$HOME/android-sdk
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk

./android/build-apk.sh                  # 交互式
KS_PASS=<keystore-password> ./android/build-apk.sh --yes
```

常用参数：`--build-web` / `--no-build-web`、`--install`、`--version`、`--version-code`、`--keystore`、`--alias`、`--out`、`--sdk`。签名口令通过 `KS_PASS` / `KEY_PASS` 或交互输入传入，脚本用 `apksigner` 的 `env:` 方式读取，不会出现在进程命令行里。

## 后端

APK 不会启动 Python 后端。需要实验台时，在电脑上运行：

```sh
cd mcp-server
./run.sh            # http://127.0.0.1:8765/mcp
```

然后在应用「实验台」中把地址改为 `http://<电脑局域网 IP>:8765/mcp`。手机页面 Origin 是
`http://127.0.0.1:18765`，后端默认允许 `http://127.0.0.1:*`。
