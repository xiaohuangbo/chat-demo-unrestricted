# Android APK（DeepSeek Unrestricted 2.7.8）

这是纯原生 WebView 壳，不依赖 Capacitor / Cordova：

- `MainActivity` 启动一个只监听 `127.0.0.1:18765` 的本地静态服务器，把 `assets/public` 作为网页根目录；
- WebView 打开 `http://127.0.0.1:18765/index.html`，因此 localStorage、IndexedDB、fetch 都有稳定的 HTTP Origin；
- 已接入文件选择器、拍照（系统相机 + content:// 回传）、麦克风运行时权限、返回键和外部浏览器跳转；
- Android WebView 不支持跨源隔离（SharedArrayBuffer），所以 WebVM 无法在 APK 内运行；应用内会提示用手机 Chrome / 桌面浏览器打开在线版，NanoVM 不受影响；
- WebView 也没有 WebGPU，浏览器内的 WebLLM 模型不可用；设置 → 本地模型里改用 MLC-LLM API 或切回云端模型；
- `assets/backend` 内含 `mcp-server` 与 EasyJailbreak 源码，仅作随包附带；Python / torch 后端不会在 Android 内执行。

## 产物

`android/deepseek-unrestricted-2.7.8.apk`，versionCode 278，使用
`/home/xiaohuangbo/桌面/xiaohuangbo.jks`（别名 `xiaohuangbo`）签名。

SHA-256：`8765337b130a9767758650276281776814c1317b697ffffaa7d7bcc87a1b79ec`（24 MB）。

## 构建

仓库根目录的 `构建APK.sh` 会自动读取 `package.json` 版本、构建 Web、调用本目录脚本并输出根目录 APK：

```sh
KS_PASS=<keystore-password> ./构建APK.sh
```

版本号由构建脚本注入（`aapt2 link --replace-version`），`AndroidManifest.xml` 里的值只是兜底，因此改 `package.json` 的版本就会同时改 APK 的 versionCode / versionName。

手动构建需要：

- Android SDK platform 34、build-tools 34.0.0；
- JDK 17（JDK 27 下 d8 8.2 会内部崩溃）；
- 已执行 `pnpm build` 生成 `../dist`。

```sh
export ANDROID_HOME=$HOME/android-sdk
export JAVA_HOME=/path/to/jdk-17
pnpm build
KS_PASS=<keystore-password> KEY_PASS=<key-password> ./android/build-apk.sh
```

签名口令通过环境变量传入，密钥库不进入仓库。脚本会执行 aapt2、javac、d8、zipalign 和 apksigner，并打印签名证书。

## 后端

APK 不会启动 Python 后端。需要实验台时，在电脑上运行：

```sh
cd mcp-server
./run.sh            # http://127.0.0.1:8765/mcp
```

然后在应用「实验台」中把地址改为 `http://<电脑局域网 IP>:8765/mcp`。手机页面 Origin 是
`http://127.0.0.1:18765`，后端默认允许 `http://127.0.0.1:*`。
