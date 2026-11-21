package com.xiaohuangbo.deepseekunrestricted;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

public final class MainActivity extends Activity {
    private static final int PORT = 18765;
    private static final int FILE_CHOOSER_REQUEST = 1001;
    private static final int MIC_REQUEST = 1002;
    private static final int CAPTURE_REQUEST = 1003;

    private WebView webView;
    private LocalServer server;
    private ValueCallback<Uri[]> filePathCallback;
    private Uri captureOutputUri;
    private PermissionRequest pendingPermission;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        getWindow().setStatusBarColor(Color.WHITE);
        getWindow().setNavigationBarColor(Color.WHITE);
        int flags = getWindow().getDecorView().getSystemUiVisibility();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        getWindow().getDecorView().setSystemUiVisibility(flags);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.WHITE);
        webView.setFitsSystemWindows(true);
        webView.setOverScrollMode(View.OVER_SCROLL_NEVER);
        webView.setVerticalScrollBarEnabled(false);
        webView.setHorizontalScrollBarEnabled(false);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        // 版本号从包信息读取，避免每次发版都要回来改这一行
        String versionName = "unknown";
        try {
            versionName = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception ignored) {
            // 取不到时保留 unknown，不影响页面加载
        }
        settings.setUserAgentString(
            settings.getUserAgentString() + " DeepSeekUnrestrictedAndroid/" + versionName
        );

        webView.addJavascriptInterface(new DownloadBridge(), "AndroidDownload");
        // NanoVM Slim 的「切换输入法」按钮：WebView 里没法直接唤起输入法选择器
        webView.addJavascriptInterface(new KeyboardBridge(), "AndroidKeyboard");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return openExternal(request.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return openExternal(Uri.parse(url));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                injectDownloadHook(view);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                WebView view,
                ValueCallback<Uri[]> callback,
                FileChooserParams params
            ) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                // <input type="file" accept="image/*" capture>：直接调系统相机，
                // 结果通过 PhotoProvider 的 content:// URI 交回 WebView。
                if (params.isCaptureEnabled() && acceptsImages(params) && startPhotoCapture()) {
                    return true;
                }
                Intent intent;
                try {
                    intent = params.createIntent();
                } catch (Exception error) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                }
                if (intent == null) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                }
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                } catch (ActivityNotFoundException error) {
                    filePathCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
                return true;
            }

            private boolean acceptsImages(FileChooserParams params) {
                String[] types = params.getAcceptTypes();
                if (types == null || types.length == 0) {
                    return true;
                }
                for (String type : types) {
                    if (type != null && type.trim().toLowerCase().startsWith("image/")) {
                        return true;
                    }
                }
                return false;
            }

            private boolean startPhotoCapture() {
                try {
                    File dir = PhotoProvider.captureDir(MainActivity.this);
                    File photo = new File(dir, "photo-" + System.currentTimeMillis() + ".jpg");
                    Uri output = PhotoProvider.uriFor(photo.getName());
                    Intent intent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
                    intent.putExtra(MediaStore.EXTRA_OUTPUT, output);
                    intent.addFlags(
                        Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                            | Intent.FLAG_GRANT_READ_URI_PERMISSION
                    );
                    if (intent.resolveActivity(getPackageManager()) == null) {
                        return false;
                    }
                    captureOutputUri = output;
                    startActivityForResult(intent, CAPTURE_REQUEST);
                    return true;
                } catch (RuntimeException error) {
                    captureOutputUri = null;
                    return false;
                }
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                boolean wantsAudio = false;
                boolean wantsVideo = false;
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                        wantsAudio = true;
                    } else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                        wantsVideo = true;
                    }
                }
                if (!wantsAudio) {
                    if (wantsVideo) {
                        request.deny();
                    } else {
                        request.grant(request.getResources());
                    }
                    return;
                }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
                    return;
                }
                pendingPermission = request;
                requestPermissions(
                    new String[] { Manifest.permission.RECORD_AUDIO },
                    MIC_REQUEST
                );
            }
        });

        setContentView(webView);
        try {
            server = new LocalServer(this, PORT);
            server.start();
            webView.loadUrl("http://127.0.0.1:" + PORT + "/index.html");
        } catch (Exception error) {
            showStartupError(error);
        }
    }

    private boolean openExternal(Uri uri) {
        if (uri == null) {
            return false;
        }
        String scheme = uri.getScheme();
        if (scheme == null) {
            return false;
        }
        if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
            String host = uri.getHost();
            if ("127.0.0.1".equals(host) || "localhost".equals(host)) {
                return false;
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException ignored) {
                // No browser installed; keep the page as-is.
            }
            return true;
        }
        if ("mailto".equalsIgnoreCase(scheme) || "tel".equalsIgnoreCase(scheme)) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (ActivityNotFoundException ignored) {
            }
            return true;
        }
        return false;
    }

    /** Bridges the terminal's "switch keyboard" button to the system IME picker. */
    public class KeyboardBridge {
        @JavascriptInterface
        public boolean available() {
            return true;
        }

        @JavascriptInterface
        public void showInputMethodPicker() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        InputMethodManager manager =
                            (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
                        if (manager != null) {
                            manager.showInputMethodPicker();
                        }
                    } catch (RuntimeException ignored) {
                        // Some vendor ROMs refuse the picker; the terminal keeps working.
                    }
                }
            });
        }
    }

    /** Blob/data downloads cannot be handled by WebView's DownloadListener; route them to MediaStore. */
    private void injectDownloadHook(WebView view) {
        String script = "(function(){"
            + "if(window.__androidDownloadHooked){return;}"
            + "window.__androidDownloadHooked=true;"
            + "function save(href,name){"
            + "fetch(href).then(function(response){return response.blob();}).then(function(blob){"
            + "var reader=new FileReader();"
            + "reader.onload=function(){"
            + "var data=String(reader.result||'');"
            + "var comma=data.indexOf(',');"
            + "AndroidDownload.saveBase64(name||'download.bin',blob.type||'application/octet-stream',data.slice(comma+1));"
            + "};"
            + "reader.readAsDataURL(blob);"
            + "}).catch(function(){});"
            + "}"
            + "var originalClick=HTMLAnchorElement.prototype.click;"
            + "HTMLAnchorElement.prototype.click=function(){"
            + "var href=this.href||'';"
            + "if(this.download&&(href.indexOf('blob:')===0||href.indexOf('data:')===0)){"
            + "save(href,this.download);return;"
            + "}"
            + "return originalClick.apply(this,arguments);"
            + "};"
            + "document.addEventListener('click',function(event){"
            + "var target=event.target;"
            + "var anchor=target&&target.closest?target.closest('a[download]'):null;"
            + "if(!anchor){return;}"
            + "var href=anchor.href||'';"
            + "if(href.indexOf('blob:')!==0&&href.indexOf('data:')!==0){return;}"
            + "event.preventDefault();event.stopPropagation();"
            + "save(href,anchor.download);"
            + "},true);"
            + "})()";
        view.evaluateJavascript(script, null);
    }

    public class DownloadBridge {
        @JavascriptInterface
        public void saveBase64(String name, String mime, String base64) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                String safeName = name == null ? "download.bin" : new File(name).getName();
                safeName = safeName.replaceAll("[\\\\/:*?\"<>|]", "_");
                if (safeName.trim().isEmpty()) {
                    safeName = "download.bin";
                }
                String safeMime = mime == null || mime.trim().isEmpty()
                    ? "application/octet-stream"
                    : mime;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    saveToMediaStore(safeName, safeMime, bytes);
                } else {
                    File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                    if (dir == null) {
                        dir = getFilesDir();
                    }
                    if (!dir.exists() && !dir.mkdirs()) {
                        throw new IllegalStateException("Cannot create download directory");
                    }
                    File file = new File(dir, safeName);
                    try (FileOutputStream out = new FileOutputStream(file)) {
                        out.write(bytes);
                    }
                    final String path = file.getAbsolutePath();
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            Toast.makeText(
                                MainActivity.this,
                                "已保存到 " + path,
                                Toast.LENGTH_LONG
                            ).show();
                        }
                    });
                }
            } catch (Exception error) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(
                            MainActivity.this,
                            "保存失败，请重试",
                            Toast.LENGTH_SHORT
                        ).show();
                    }
                });
            }
        }
    }

    private void saveToMediaStore(String name, String mime, byte[] bytes) throws Exception {
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new IllegalStateException("Cannot create MediaStore entry");
        }
        try {
            try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                if (out == null) {
                    throw new IllegalStateException("Cannot open output stream");
                }
                out.write(bytes);
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            getContentResolver().update(uri, done, null, null);
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(
                        MainActivity.this,
                        "已保存到下载目录",
                        Toast.LENGTH_SHORT
                    ).show();
                }
            });
        } catch (Exception error) {
            getContentResolver().delete(uri, null, null);
            throw error;
        }
    }

    private void showStartupError(Exception error) {
        String message = error.getMessage() == null ? error.toString() : error.getMessage();
        String html = "<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
            + "<style>body{font-family:sans-serif;padding:28px;line-height:1.6;color:#222}"
            + "h1{font-size:20px}code{background:#f2f2f2;padding:2px 5px;border-radius:4px}</style></head><body>"
            + "<h1>本地服务启动失败</h1>"
            + "<p>应用需要在本机监听 <code>127.0.0.1:" + PORT + "</code> 来加载界面。</p>"
            + "<p>请确认没有其他应用占用该端口，然后重新打开应用。</p>"
            + "<p><small>" + escapeHtml(message) + "</small></p>"
            + "</body></html>";
        webView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private static String escapeHtml(String value) {
        return value
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == CAPTURE_REQUEST) {
            if (filePathCallback != null) {
                Uri[] result = null;
                if (resultCode == RESULT_OK && captureOutputUri != null) {
                    result = new Uri[] { captureOutputUri };
                }
                filePathCallback.onReceiveValue(result);
                filePathCallback = null;
            }
            captureOutputUri = null;
            return;
        }
        if (requestCode == FILE_CHOOSER_REQUEST) {
            if (filePathCallback == null) {
                return;
            }
            Uri[] result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            filePathCallback.onReceiveValue(result);
            filePathCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onRequestPermissionsResult(
        int requestCode,
        String[] permissions,
        int[] grantResults
    ) {
        if (requestCode == MIC_REQUEST) {
            PermissionRequest request = pendingPermission;
            pendingPermission = null;
            if (request == null) {
                return;
            }
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                request.grant(new String[] { PermissionRequest.RESOURCE_AUDIO_CAPTURE });
            } else {
                request.deny();
            }
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        if (webView.canGoBack()) {
            webView.goBack();
            return;
        }
        // Let the web app close its top modal (settings / stats / dialogs) first.
        webView.evaluateJavascript(
            "(function(){var d=document.querySelector('[role=dialog]');"
                + "if(!d){return false;}"
                + "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));"
                + "return true;})()",
            new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    if (!"true".equals(value)) {
                        runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                finish();
                            }
                        });
                    }
                }
            }
        );
    }

    @Override
    protected void onDestroy() {
        if (server != null) {
            server.close();
            server = null;
        }
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
