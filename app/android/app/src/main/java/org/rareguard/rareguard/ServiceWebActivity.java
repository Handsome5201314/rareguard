package org.rareguard.rareguard;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Bitmap;
import android.net.http.SslError;
import android.view.View;
import android.webkit.*;
import android.widget.*;
import org.rareguard.core.DravetPolicy;

/** Web login stays in WebView; no native credentials or JavaScript bridge. */
public final class ServiceWebActivity extends Activity {
    private WebView web;
    private TextView status;
    private String entry;
    private boolean failed;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        entry = getIntent().getStringExtra("url");
        if (!DravetPolicy.allowedWeb(entry)) { finish(); return; }
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL);
        LinearLayout bar = new LinearLayout(this);
        Button back = new Button(this); back.setText("返回应用"); back.setOnClickListener(v -> finish()); bar.addView(back);
        Button retry = new Button(this); retry.setText("重试"); retry.setOnClickListener(v -> web.loadUrl(entry)); bar.addView(retry);
        root.addView(bar);
        status = new TextView(this); status.setPadding(16, 8, 16, 8); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); root.addView(status);
        web = new WebView(this); root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1)); setContentView(root);
        WebView.setWebContentsDebuggingEnabled(false);
        WebSettings s = web.getSettings(); s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false); s.setAllowContentAccess(false); s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportMultipleWindows(false); s.setJavaScriptCanOpenWindowsAutomatically(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                boolean allowed = DravetPolicy.allowedWeb(r.getUrl().toString());
                if (!allowed && r.isForMainFrame()) status.setText("已阻止离开已配置服务的链接");
                return !allowed;
            }
            @Override public void onPageStarted(WebView v, String url, Bitmap icon) { failed = false; status.setText("正在加载…"); }
            @Override public void onPageFinished(WebView v, String url) { if (!failed) status.setText("请在网页中登录；手机上传授权与智能体授权分别管理"); }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) { if (r.isForMainFrame()) { failed = true; status.setText("网页加载失败，请检查网络后重试"); } }
            @Override public void onReceivedHttpError(WebView v, WebResourceRequest r, WebResourceResponse e) { if (r.isForMainFrame()) { failed = true; status.setText("服务响应异常（" + e.getStatusCode() + "），请重试"); } }
            @Override public void onReceivedSslError(WebView v, SslErrorHandler handler, SslError e) { handler.cancel(); failed = true; status.setText("安全证书校验失败，已停止加载"); }
        });
        web.loadUrl(entry);
    }
    @Override public void onBackPressed() { if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed(); }
    @Override public void onDestroy() { if (web != null) { web.stopLoading(); web.destroy(); } super.onDestroy(); }
}
