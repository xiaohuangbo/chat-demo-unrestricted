package com.xiaohuangbo.deepseekunrestricted;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Serves camera captures from the app cache to the system camera app.
 *
 * The WebView file chooser hands a content:// URI to the camera as
 * {@code MediaStore.EXTRA_OUTPUT}; the camera app writes the JPEG through this
 * provider, and WebView reads it back when the activity returns. Keeping the
 * file in cache avoids storage permissions and MediaStore clutter.
 */
public final class PhotoProvider extends ContentProvider {
    static final String AUTHORITY = "com.xiaohuangbo.deepseekunrestricted.photos";

    static File captureDir(Context context) {
        File dir = new File(context.getCacheDir(), "captures");
        if (!dir.exists() && !dir.mkdirs()) {
            return context.getCacheDir();
        }
        // 照片拍完就交给网页上传并存进 IndexedDB，缓存副本只留一天
        File[] stale = dir.listFiles();
        if (stale != null) {
            long cutoff = System.currentTimeMillis() - 24L * 60L * 60L * 1000L;
            for (File file : stale) {
                if (file.isFile() && file.lastModified() < cutoff) {
                    file.delete();
                }
            }
        }
        return dir;
    }

    static Uri uriFor(String name) {
        return new Uri.Builder().scheme("content").authority(AUTHORITY).appendPath(name).build();
    }

    static File fileFor(Context context, Uri uri) {
        String name = uri == null ? null : uri.getLastPathSegment();
        if (name == null || name.isEmpty() || name.contains("/") || name.contains("..")) {
            return null;
        }
        return new File(captureDir(context), name);
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        Context context = getContext();
        File file = context == null ? null : fileFor(context, uri);
        if (file == null) {
            throw new FileNotFoundException("Unknown capture: " + uri);
        }
        int flags = ParcelFileDescriptor.MODE_READ_ONLY;
        if (mode != null && mode.indexOf('w') >= 0) {
            flags = ParcelFileDescriptor.MODE_READ_WRITE
                | ParcelFileDescriptor.MODE_CREATE
                | ParcelFileDescriptor.MODE_TRUNCATE;
        } else if (mode != null && mode.indexOf('r') < 0) {
            throw new FileNotFoundException("Unsupported mode: " + mode);
        }
        return ParcelFileDescriptor.open(file, flags);
    }

    @Override
    public String getType(Uri uri) {
        return "image/jpeg";
    }

    @Override
    public Cursor query(
        Uri uri,
        String[] projection,
        String selection,
        String[] selectionArgs,
        String sortOrder
    ) {
        return null;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
