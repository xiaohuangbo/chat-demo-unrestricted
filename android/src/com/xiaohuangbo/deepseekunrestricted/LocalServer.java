package com.xiaohuangbo.deepseekunrestricted;

import android.content.Context;
import android.content.res.AssetManager;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.util.Arrays;
import java.util.Random;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;

/**
 * Serves the built web app from assets over http://127.0.0.1:18765.
 *
 * A real HTTP origin (rather than file://) gives localStorage, IndexedDB and
 * fetch a stable origin, and also matches the MCP backend's allowed origins.
 */
final class LocalServer implements Closeable {
    private final Context context;
    private final int port;
    private final ExecutorService pool = Executors.newCachedThreadPool(new ThreadFactory() {
        @Override
        public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "local-assets");
            thread.setDaemon(true);
            return thread;
        }
    });
    private volatile boolean running;
    private ServerSocket serverSocket;
    /** 注入到 index.html 的随机 token：本地代理只接受带它的请求，避免被别的页面当成开放代理 */
    private final String proxyToken = Long.toHexString(new Random().nextLong());

    String proxyToken() {
        return proxyToken;
    }

    LocalServer(Context context, int port) {
        this.context = context.getApplicationContext();
        this.port = port;
    }

    void start() throws IOException {
        ServerSocket socket = new ServerSocket();
        socket.setReuseAddress(true);
        socket.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port));
        serverSocket = socket;
        running = true;
        Thread accept = new Thread(new Runnable() {
            @Override
            public void run() {
                while (running) {
                    try {
                        final Socket client = socket.accept();
                        pool.execute(new Runnable() {
                            @Override
                            public void run() {
                                handle(client);
                            }
                        });
                    } catch (IOException error) {
                        if (running) {
                            // Socket closed while shutting down; otherwise ignore one bad client.
                        }
                    }
                }
            }
        }, "local-assets-accept");
        accept.setDaemon(true);
        accept.start();
    }

    private void handle(Socket socket) {
        try (Socket client = socket) {
            client.setSoTimeout(15000);
            // 按字节读到头部结束（\r\n\r\n），后面的字节留给 body：
            // 用 BufferedReader 会预读，把 POST 的 body 吞进它自己的缓冲里。
            String headerText = readHeaderBlock(client.getInputStream(), 16384);
            if (headerText == null) {
                return;
            }
            String[] headerLines = headerText.split("\r\n");
            String requestLine = headerLines.length > 0 ? headerLines[0] : "";
            if (requestLine.isEmpty()) {
                return;
            }
            int contentLength = 0;
            String rangeHeader = null;
            for (int index = 1; index < headerLines.length; index += 1) {
                String line = headerLines[index];
                int colon = line.indexOf(':');
                if (colon > 0) {
                    String name = line.substring(0, colon).trim();
                    String value = line.substring(colon + 1).trim();
                    if ("content-length".equalsIgnoreCase(name)) {
                        try {
                            contentLength = Integer.parseInt(value);
                        } catch (NumberFormatException ignored) {
                            contentLength = 0;
                        }
                    } else if ("range".equalsIgnoreCase(name)) {
                        rangeHeader = value;
                    }
                }
            }

            String[] parts = requestLine.split(" ");
            String method = parts.length > 0 ? parts[0].toUpperCase(Locale.ROOT) : "GET";
            String target = parts.length > 1 ? parts[1] : "/";
            int qmark = target.indexOf('?');
            String rawQuery = qmark >= 0 ? target.substring(qmark + 1) : "";
            boolean proxyRoute = target.startsWith("/__nanovm/");
            if (!"GET".equals(method) && !"HEAD".equals(method) && !("POST".equals(method) && proxyRoute)) {
                sendText(client.getOutputStream(), 405, "Method Not Allowed", "Method Not Allowed");
                return;
            }

            // 代理请求可能带 body（curl -d / POST），其余路由只处理 GET/HEAD
            byte[] requestBody = new byte[0];
            if ("POST".equals(method) && contentLength > 0) {
                requestBody = new byte[Math.min(contentLength, 4 * 1024 * 1024)];
                int offset = 0;
                while (offset < requestBody.length) {
                    int read = client.getInputStream().read(requestBody, offset, requestBody.length - offset);
                    if (read <= 0) {
                        break;
                    }
                    offset += read;
                }
            }

            String rawPath = target;
            int query = rawPath.indexOf('?');
            if (query >= 0) {
                rawPath = rawPath.substring(0, query);
            }
            String path;
            try {
                path = URLDecoder.decode(rawPath, "UTF-8");
            } catch (Exception error) {
                sendText(client.getOutputStream(), 400, "Bad Request", "Bad Request");
                return;
            }
            path = path.replace('\\', '/');
            if (path.equals("/__nanovm/ping") || path.equals("/__nanovm/fetch")) {
                serveProxy(client.getOutputStream(), path, rawQuery, method, requestBody);
                return;
            }
            if (path.contains("..") || path.indexOf('\0') >= 0) {
                sendText(client.getOutputStream(), 403, "Forbidden", "Forbidden");
                return;
            }
            if (!path.startsWith("/")) {
                path = "/" + path;
            }
            if (path.equals("/") || path.endsWith("/")) {
                path += "index.html";
            }

            AssetManager assets = context.getAssets();
            byte[] body = readAsset(assets, "public" + path);
            if (body == null && !hasExtension(path)) {
                body = readAsset(assets, "public/index.html");
            }
            if (body == null) {
                sendText(client.getOutputStream(), 404, "Not Found", "Not Found");
                return;
            }

            String contentType = contentType(path);
            if (contentType.startsWith("text/html") && body != null) {
                String html = new String(body, StandardCharsets.UTF_8);
                String meta = "<meta name=\"nanovm-proxy\" content=\"" + proxyToken + "\">"
                    + "<meta name=\"nanovm-app\" content=\"android\">";
                if (html.contains("<head>")) {
                    html = html.replaceFirst("<head>", "<head>" + meta);
                } else {
                    html = meta + html;
                }
                body = html.getBytes(StandardCharsets.UTF_8);
            }
            int totalLength = body.length;
            int rangeStart = 0;
            int rangeEnd = body.length - 1;
            boolean partial = false;
            if (rangeHeader != null && rangeHeader.startsWith("bytes=") && body.length > 0) {
                String spec = rangeHeader.substring("bytes=".length()).trim();
                int dash = spec.indexOf('-');
                if (dash >= 0) {
                    try {
                        String left = spec.substring(0, dash).trim();
                        String right = spec.substring(dash + 1).trim();
                        if (left.isEmpty()) {
                            int suffix = Integer.parseInt(right);
                            rangeStart = Math.max(0, body.length - suffix);
                            rangeEnd = body.length - 1;
                        } else {
                            rangeStart = Integer.parseInt(left);
                            rangeEnd = right.isEmpty() ? body.length - 1 : Integer.parseInt(right);
                        }
                        if (rangeStart < 0 || rangeEnd < rangeStart || rangeStart >= body.length) {
                            OutputStream invalid = client.getOutputStream();
                            invalid.write(("HTTP/1.1 416 Range Not Satisfiable\r\n"
                                + "Content-Range: bytes */" + body.length + "\r\n"
                                + "Content-Length: 0\r\n"
                                + "Connection: close\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
                            invalid.flush();
                            return;
                        }
                        rangeEnd = Math.min(rangeEnd, body.length - 1);
                        body = Arrays.copyOfRange(body, rangeStart, rangeEnd + 1);
                        partial = true;
                    } catch (NumberFormatException ignored) {
                        // A malformed Range falls back to the full body.
                    }
                }
            }

            OutputStream output = client.getOutputStream();
            String status = partial ? "206 Partial Content" : "200 OK";
            String header = "HTTP/1.1 " + status + "\r\n"
                + "Content-Type: " + contentType + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Accept-Ranges: bytes\r\n"
                + (partial ? ("Content-Range: bytes " + rangeStart + "-" + rangeEnd + "/"
                    + totalLength + "\r\n") : "")
                + "Cache-Control: no-cache\r\n"
                + "X-Content-Type-Options: nosniff\r\n"
                + "Connection: close\r\n\r\n";
            output.write(header.getBytes(StandardCharsets.ISO_8859_1));
            if (!"HEAD".equals(method)) {
                output.write(body);
            }
            output.flush();
        } catch (Exception ignored) {
            // A broken asset request must not take down the accept loop.
        }
    }

    private static byte[] readAsset(AssetManager assets, String name) {
        try (InputStream input = assets.open(name)) {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
            }
            return output.toByteArray();
        } catch (FileNotFoundException error) {
            return null;
        } catch (IOException error) {
            return null;
        }
    }

    private static boolean hasExtension(String path) {
        String name = path.substring(path.lastIndexOf('/') + 1);
        return name.indexOf('.') > 0;
    }

    private static String contentType(String path) {
        int dot = path.lastIndexOf('.');
        String ext = dot >= 0 ? path.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        switch (ext) {
            case "html":
            case "htm":
                return "text/html; charset=utf-8";
            case "js":
            case "mjs":
                return "application/javascript; charset=utf-8";
            case "css":
                return "text/css; charset=utf-8";
            case "json":
            case "map":
                return "application/json; charset=utf-8";
            case "txt":
                return "text/plain; charset=utf-8";
            case "svg":
                return "image/svg+xml";
            case "png":
                return "image/png";
            case "jpg":
            case "jpeg":
                return "image/jpeg";
            case "gif":
                return "image/gif";
            case "webp":
                return "image/webp";
            case "ico":
                return "image/x-icon";
            case "woff2":
                return "font/woff2";
            case "woff":
                return "font/woff";
            case "ttf":
                return "font/ttf";
            case "wasm":
                return "application/wasm";
            default:
                return "application/octet-stream";
        }
    }

    /**
     * 本地反向代理：页面同源访问它，它用 HttpURLConnection 真发请求。
     * 这样 APK 里的 NanoVM 就能访问任意站点，不受 WebView 的 CORS 限制。
     */
    private void serveProxy(
        OutputStream output,
        String path,
        String rawQuery,
        String requestMethod,
        byte[] requestBody
    ) throws IOException {
        String token = queryParam(rawQuery, "token");
        if (token == null || !token.equals(proxyToken)) {
            sendText(output, 403, "Forbidden", "bad token");
            return;
        }
        if ("/__nanovm/ping".equals(path)) {
            sendText(output, 200, "OK", "ok");
            return;
        }
        String targetUrl = queryParam(rawQuery, "url");
        if (targetUrl == null || targetUrl.isEmpty()) {
            sendText(output, 400, "Bad Request", "missing url");
            return;
        }
        String upstreamMethod = queryParam(rawQuery, "method");
        if (upstreamMethod == null || upstreamMethod.isEmpty()) {
            upstreamMethod = "GET";
        }
        upstreamMethod = upstreamMethod.toUpperCase(Locale.ROOT);
        String bodyText = requestBody.length > 0
            ? new String(requestBody, StandardCharsets.UTF_8)
            : null;
        String requestContentType = queryParam(rawQuery, "ctype");
        if (requestContentType == null || requestContentType.isEmpty()) {
            requestContentType = "application/x-www-form-urlencoded";
        }

        HttpURLConnection connection = null;
        try {
            URL url = new URL(targetUrl);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(20000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", "Mozilla/5.0 (NanoVM Slim)");
            connection.setRequestProperty("Accept", "*/*");
            connection.setRequestMethod(upstreamMethod);
            if (bodyText != null && !"GET".equals(upstreamMethod) && !"HEAD".equals(upstreamMethod)) {
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", requestContentType);
                OutputStream requestStream = connection.getOutputStream();
                requestStream.write(bodyText.getBytes(StandardCharsets.UTF_8));
                requestStream.flush();
                requestStream.close();
            }
            int status = connection.getResponseCode();
            InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            byte[] payload = readLimited(input, 8 * 1024 * 1024);
            String type = connection.getContentType();
            if (type == null || type.isEmpty()) {
                type = "application/octet-stream";
            }
            StringBuilder headerBuilder = new StringBuilder();
            headerBuilder.append("HTTP/1.1 200 OK\r\n")
                .append("Content-Type: ").append(type).append("\r\n")
                .append("Content-Length: ").append(payload.length).append("\r\n")
                .append("Cache-Control: no-store\r\n")
                .append("X-NanoVM-Status: ").append(status).append("\r\n")
                .append("X-NanoVM-Type: ").append(type).append("\r\n");
            // 把上游响应头转发给页面（curl -I 要用），跳过会破坏本地响应的几个
            for (java.util.Map.Entry<String, java.util.List<String>> entry
                : connection.getHeaderFields().entrySet()) {
                String name = entry.getKey();
                if (name == null || name.isEmpty()) {
                    continue;
                }
                String lower = name.toLowerCase(Locale.ROOT);
                if ("content-length".equals(lower) || "transfer-encoding".equals(lower)
                    || "connection".equals(lower) || "content-encoding".equals(lower)
                    || lower.startsWith("x-nanovm-")) {
                    continue;
                }
                java.util.List<String> values = entry.getValue();
                if (values == null || values.isEmpty()) {
                    continue;
                }
                headerBuilder.append("X-NanoVM-H-").append(name)
                    .append(": ").append(values.get(0).replace("\r", " ").replace("\n", " "))
                    .append("\r\n");
            }
            headerBuilder.append("Connection: close\r\n\r\n");
            String header = headerBuilder.toString();
            output.write(header.getBytes(StandardCharsets.ISO_8859_1));
            if (!"HEAD".equals(requestMethod) && !"HEAD".equals(upstreamMethod)) {
                output.write(payload);
            }
            output.flush();
        } catch (Exception error) {
            String message = error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage());
            sendText(output, 502, "Bad Gateway", message);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static String queryParam(String rawQuery, String name) {
        if (rawQuery == null || rawQuery.isEmpty()) {
            return null;
        }
        for (String pair : rawQuery.split("&")) {
            int equals = pair.indexOf('=');
            String key = equals >= 0 ? pair.substring(0, equals) : pair;
            if (!name.equals(key)) {
                continue;
            }
            String value = equals >= 0 ? pair.substring(equals + 1) : "";
            try {
                return URLDecoder.decode(value, "UTF-8");
            } catch (Exception error) {
                return value;
            }
        }
        return null;
    }

    private static byte[] readLimited(InputStream input, int limit) throws IOException {
        if (input == null) {
            return new byte[0];
        }
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int total = 0;
        int read;
        while ((read = input.read(chunk)) != -1) {
            int allowed = Math.min(read, limit - total);
            if (allowed <= 0) {
                break;
            }
            buffer.write(chunk, 0, allowed);
            total += allowed;
        }
        input.close();
        return buffer.toByteArray();
    }

    /** 读到第一个空行为止，返回头部原文（不含结尾的空行）；超长或直接 EOF 返回 null */
    private static String readHeaderBlock(InputStream input, int limit) throws IOException {
        java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
        int matched = 0;
        int read;
        while ((read = input.read()) != -1) {
            buffer.write(read);
            if ((matched == 0 || matched == 2) && read == '\r') {
                matched += 1;
            } else if ((matched == 1 || matched == 3) && read == '\n') {
                matched += 1;
            } else {
                matched = 0;
            }
            if (matched == 4) {
                break;
            }
            if (buffer.size() > limit) {
                return null;
            }
        }
        String text = new String(buffer.toByteArray(), StandardCharsets.ISO_8859_1);
        int end = text.lastIndexOf("\r\n\r\n");
        if (end >= 0) {
            text = text.substring(0, end);
        }
        return text;
    }

    private static void sendText(OutputStream output, int status, String reason, String text)
        throws IOException {
        byte[] body = text.getBytes(StandardCharsets.UTF_8);
        String header = "HTTP/1.1 " + status + " " + reason + "\r\n"
            + "Content-Type: text/plain; charset=utf-8\r\n"
            + "Content-Length: " + body.length + "\r\n"
            + "Connection: close\r\n\r\n";
        output.write(header.getBytes(StandardCharsets.ISO_8859_1));
        output.write(body);
        output.flush();
    }

    @Override
    public void close() {
        running = false;
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {
            }
        }
        pool.shutdownNow();
    }
}
