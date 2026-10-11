package org.rareguard.app;

import android.content.Context;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;

public final class RemoteApi {
    private final SecureSettings settings;
    RemoteApi(Context context){settings=new SecureSettings(context);}
    public JSONObject pair(String url,String code) throws Exception {
        if(!settings.url().isEmpty())throw new IllegalStateException("本机已配对；请使用当前家庭，避免旧数据被上传到其他家庭。更换家庭前请导出并清除应用数据");
        URI uri=URI.create(url);
        if(!"https".equals(uri.getScheme()) && !(org.rareguard.rareguard.BuildConfig.DEBUG && "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost())))
            throw new IllegalArgumentException("业务入口须为 HTTPS；开发版仅允许 USB 回环 HTTP");
        if(uri.getUserInfo()!=null || uri.getQuery()!=null || uri.getFragment()!=null)throw new IllegalArgumentException("入口不能含凭据、查询或片段");
        url=url.replaceAll("/+$","");
        JSONObject result=call(url,"POST","/v1/pairings/exchange",new JSONObject().put("code",code),null);
        settings.save(url,result.getString("token"));result.remove("token");return result;
    }
    public JSONObject request(String method,String path,JSONObject body) throws Exception {
        if(!path.startsWith("/v1/") || path.contains("://"))throw new IllegalArgumentException("无效业务路径");
        if(settings.token()==null)throw new IllegalStateException("请先在设置中完成服务端配对");
        return call(settings.url(),method,path,body,settings.token());
    }
    private JSONObject call(String url,String method,String path,JSONObject body,String token) throws Exception {
        HttpURLConnection c=(HttpURLConnection)URI.create(url+path).toURL().openConnection();
        c.setConnectTimeout(8000);c.setReadTimeout(12000);c.setInstanceFollowRedirects(false);c.setRequestMethod(method);
        if(token!=null)c.setRequestProperty("Authorization","Bearer "+token);
        try {
            if(body!=null){c.setDoOutput(true);c.setRequestProperty("Content-Type","application/json");try(var out=c.getOutputStream()){out.write(body.toString().getBytes(StandardCharsets.UTF_8));}}
            int status=c.getResponseCode();var stream=status>=200&&status<300?c.getInputStream():c.getErrorStream();
            String text="";if(stream!=null){try(var in=stream){byte[] bytes=in.readNBytes(1048577);if(bytes.length>1048576)throw new IllegalStateException("服务端响应过大");text=new String(bytes,StandardCharsets.UTF_8);}}
            if(status<200 || status>=300) {
                JSONObject err=text.isEmpty()?new JSONObject():new JSONObject(text);
                throw new IllegalStateException("HTTP "+status+" · "+err.optString("code","request_failed")+" · "+err.optString("message","请检查入口、配对与网络"));
            }
            return new JSONObject(text);
        } finally {c.disconnect();}
    }
    String url(){return settings.url();}
}
