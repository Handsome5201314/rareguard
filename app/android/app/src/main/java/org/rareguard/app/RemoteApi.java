package org.rareguard.app;

import android.content.Context;
import org.json.JSONObject;
import org.rareguard.core.DravetPolicy;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Instant;

/** Device upload credential only; parent and Octop sessions belong to their webpages. */
public final class RemoteApi {
    private final SecureSettings settings;
    private final LocalStore store;
    private volatile JSONObject binding;
    private volatile String configurationError = "";
    RemoteApi(Context context, LocalStore store) {
        this.store = store;
        settings = new SecureSettings(context);
        try { binding = settings.dravet(); }
        catch (Exception e) { configurationError = "手机配对凭据无法解密，请恢复原授权；本机记录仍保留"; }
    }
    public synchronized JSONObject pair(String raw, String localId) throws Exception {
        if (localId == null) throw new IllegalStateException("请先连接要绑定的戒指");
        if (!configurationError.isEmpty()) throw new IllegalStateException(configurationError);
        if (raw == null || raw.length() > 8192) throw new IllegalArgumentException("请粘贴完整的手机配对包");
        JSONObject p;
        try { p = new JSONObject(raw); }
        catch (org.json.JSONException e) {
            String detail = e.getMessage();
            throw new IllegalArgumentException("配对包 JSON 格式错误" + (detail == null ? "" : "：" + detail));
        }
        if (p.length() != 6 || !"dravet-device-pairing".equals(p.optString("kind")) || !Integer.valueOf(1).equals(p.opt("version")))
            throw new IllegalArgumentException("请使用病程监测页生成的手机配对包，不能使用智能体连接包");
        if (!DravetPolicy.BUSINESS.equals(p.optString("url"))) throw new IllegalArgumentException("配对包业务入口不在当前配置范围");
        String patient = p.getString("patientId"), device = p.getString("deviceId");
        DravetPolicy.uuid(patient); DravetPolicy.uuid(device); DravetPolicy.uuid(localId);
        String code = p.getString("pairingCode");
        if (!code.matches("dp_[A-Za-z0-9_-]{43}")) throw new IllegalArgumentException("手机配对码格式无效，请重新生成");
        String scope = patient + ":" + device;
        DravetPolicy.sameBinding(scope(), localId(), scope, localId);
        store.checkBinding(scope, localId);
        JSONObject result = call("/api/dravet/pair", new JSONObject().put("pairingCode", code), null);
        if (!patient.equals(result.optString("patientId")) || !device.equals(result.optString("deviceId")) || !result.optString("token").matches("dd_[A-Za-z0-9_-]{43}"))
            throw new IllegalStateException("服务端返回的设备或患者与配对包不一致，未保存授权");
        if (!Instant.parse(result.getString("expiresAt")).isAfter(Instant.now())) throw new IllegalStateException("服务端返回的上传授权已过期");
        result.put("scope", scope).put("localId", localId);
        settings.saveDravet(result); binding = result;
        return status();
    }
    public JSONObject request(String path, JSONObject body) throws Exception {
        if (!"/api/dravet/batches".equals(path) && !"/api/dravet/events".equals(path)) throw new IllegalArgumentException("无效设备上传路径");
        if (!configurationError.isEmpty()) throw new IllegalStateException(configurationError);
        JSONObject current = binding;
        if (current == null) throw new IllegalStateException("请先完成病程手机配对");
        if (!Instant.parse(current.getString("expiresAt")).isAfter(Instant.now())) throw new IllegalStateException("手机上传授权已到期，请在病程网页为原设备生成续期包；待传记录保留");
        return call(path, body, current.getString("token"));
    }
    private JSONObject call(String path, JSONObject body, String token) throws Exception {
        byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
        if (payload.length > 512 * 1024) throw new IllegalArgumentException("上传批次超过服务端限制");
        HttpURLConnection c = (HttpURLConnection) URI.create(DravetPolicy.BUSINESS + path).toURL().openConnection();
        c.setConnectTimeout(8000); c.setReadTimeout(12000); c.setInstanceFollowRedirects(false); c.setRequestMethod("POST");
        c.setRequestProperty("Content-Type", "application/json");
        if (token != null) c.setRequestProperty("Authorization", "Bearer " + token);
        try {
            c.setDoOutput(true);
            try (var out = c.getOutputStream()) { out.write(payload); }
            int status = c.getResponseCode();
            if (status < 200 || status >= 300) {
                String reason = status == 401 ? "上传授权或配对码无效、过期或已撤销，请在病程网页核对" : status == 409 ? "记录冲突，批次保留，请核对服务端" : "请检查网络与病程服务";
                throw new IllegalStateException("HTTP " + status + " · " + reason);
            }
            try (var in = c.getInputStream()) {
                byte[] bytes = in.readNBytes(1048577);
                if (bytes.length > 1048576) throw new IllegalStateException("服务端响应过大");
                return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
            }
        } finally { c.disconnect(); }
    }
    public JSONObject status() throws org.json.JSONException {
        JSONObject s = new JSONObject().put("paired", paired()).put("configurationError", configurationError);
        if (binding != null) s.put("patientId", binding.getString("patientId")).put("serverDeviceId", binding.getString("deviceId")).put("expiresAt", binding.getString("expiresAt"));
        return s;
    }
    public boolean paired() { return binding != null && configurationError.isEmpty(); }
    public String scope() { return binding == null ? "" : binding.optString("scope"); }
    public String localId() { return binding == null ? "" : binding.optString("localId"); }
    String error() { return configurationError; }
    String url() { return paired() ? DravetPolicy.BUSINESS : ""; }
}
