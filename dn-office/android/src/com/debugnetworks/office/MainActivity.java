package com.debugnetworks.office;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * DN Office: the Debug Networks office app. The app itself is the web page in assets/www,
 * served to a WebView from a private https address so its records stay in the app's storage.
 * This class adds what a phone app needs: sharing files to WhatsApp, copying text, opening
 * WhatsApp, the dialer and UPI apps, picking a backup file, and the back button.
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String START = "https://" + HOST + "/www/index.html";
    static final int PICK_FILE = 41;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true); // test builds only, so the emulator check can drive the page
        }
        web = new WebView(this);
        web.setBackgroundColor(0xFF0A1F44);
        setContentView(web);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        web.addJavascriptInterface(new Bridge(), "DNAndroid");
        web.setWebViewClient(new AppClient());
        web.setWebChromeClient(new AppChrome());
        web.loadUrl(START);
    }

    /** Back closes the open page inside the app first, then returns to Today, then leaves the app. */
    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript("(function(){try{return !!(window.__dnBack&&window.__dnBack());}catch(e){return false;}})()",
            new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String handled) {
                    if (!"true".equals(handled)) leaveApp();
                }
            });
    }

    void leaveApp() {
        super.onBackPressed();
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == PICK_FILE) {
            if (fileCallback != null) {
                Uri[] result = null;
                if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                    result = new Uri[] { data.getData() };
                }
                fileCallback.onReceiveValue(result);
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }

    void openExternal(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException e) {
            toast(url.startsWith("upi:") ? "No UPI app found on this phone." : "No app on this phone can open this link.");
        }
    }

    void shareText(String text) {
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType("text/plain");
        send.putExtra(Intent.EXTRA_TEXT, text);
        try {
            startActivity(Intent.createChooser(send, "Share"));
        } catch (ActivityNotFoundException e) {
            toast("No app on this phone can share this.");
        }
    }

    void shareFile(String base64, String name, String mime, String text) {
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            File dir = new File(getCacheDir(), ShareProvider.DIR);
            if (!dir.exists()) dir.mkdirs();
            String safe = (name == null || name.length() == 0) ? "file" : name.replaceAll("[^A-Za-z0-9._-]", "_");
            File file = new File(dir, safe);
            FileOutputStream out = new FileOutputStream(file);
            try {
                out.write(bytes);
            } finally {
                out.close();
            }
            Uri uri = new Uri.Builder().scheme("content").authority(ShareProvider.AUTHORITY).appendPath(safe).build();
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType((mime == null || mime.length() == 0) ? "application/octet-stream" : mime);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            if (text != null && text.length() > 0) send.putExtra(Intent.EXTRA_TEXT, text);
            send.setClipData(ClipData.newRawUri(safe, uri));
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(Intent.createChooser(send, "Share " + safe));
        } catch (Exception e) {
            toast("Could not share the file. Try again.");
        }
    }

    void copyText(String text) {
        ClipboardManager clipboard = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard != null) clipboard.setPrimaryClip(ClipData.newPlainText("DN Office", text));
    }

    static String mimeFor(String path) {
        String p = path.toLowerCase();
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".json") || p.endsWith(".webmanifest")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    /** Methods the web page calls as window.DNAndroid. They arrive on a background thread. */
    public class Bridge {
        @JavascriptInterface
        public void shareFile(final String base64, final String name, final String mime, final String text) {
            runOnUiThread(new Runnable() {
                public void run() { MainActivity.this.shareFile(base64, name, mime, text); }
            });
        }

        @JavascriptInterface
        public void shareText(final String text) {
            runOnUiThread(new Runnable() {
                public void run() { MainActivity.this.shareText(text); }
            });
        }

        @JavascriptInterface
        public void copyText(final String text) {
            runOnUiThread(new Runnable() {
                public void run() { MainActivity.this.copyText(text); }
            });
        }

        @JavascriptInterface
        public void openExternal(final String url) {
            runOnUiThread(new Runnable() {
                public void run() { MainActivity.this.openExternal(url); }
            });
        }
    }

    /** Serves the app from assets and sends every other link to the right app (WhatsApp, dialer, UPI, browser). */
    class AppClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, String url) {
            Uri uri = Uri.parse(url);
            if (HOST.equals(uri.getHost())) return false;
            openExternal(url);
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!HOST.equals(uri.getHost())) return null;
            String path = uri.getPath();
            if (path == null || path.length() <= 1) path = "/www/index.html";
            if (path.endsWith("/")) path = path + "index.html";
            String asset = path.substring(1);
            Map<String, String> headers = new HashMap<String, String>();
            headers.put("Access-Control-Allow-Origin", "*");
            headers.put("Cache-Control", "no-cache");
            try {
                InputStream in = getAssets().open(asset);
                return new WebResourceResponse(mimeFor(asset), "UTF-8", 200, "OK", headers, in);
            } catch (IOException e) {
                return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found", headers, new ByteArrayInputStream(new byte[0]));
            }
        }
    }

    /** Opens the phone's file picker when the page asks for a backup file. */
    class AppChrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            pick.setType("*/*");
            try {
                startActivityForResult(Intent.createChooser(pick, "Choose your backup file"), PICK_FILE);
                return true;
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                toast("No file picker found on this phone.");
                return false;
            }
        }
    }
}
