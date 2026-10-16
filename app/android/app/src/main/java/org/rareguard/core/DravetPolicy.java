package org.rareguard.core;

import java.net.URI;
import java.util.UUID;

/** Shared boundary for pairing and in-app navigation; contains no credentials. */
public final class DravetPolicy {
    public static final String BUSINESS = "https://bingcheng.tongyimoheai.top";
    public static final String OCTOP = "https://octop.tongyimoheai.top/";
    private DravetPolicy() {}
    public static boolean allowedWeb(String raw) {
        if (raw == null) return false;
        try {
            URI u = URI.create(raw);
            if (!"https".equals(u.getScheme()) || u.getUserInfo() != null || (u.getPort() != -1 && u.getPort() != 443)) return false;
            return "bingcheng.tongyimoheai.top".equals(u.getHost()) || "octop.tongyimoheai.top".equals(u.getHost());
        } catch (IllegalArgumentException e) { return false; }
    }
    public static void uuid(String value) {
        if (value == null || !UUID.fromString(value).toString().equalsIgnoreCase(value)) throw new IllegalArgumentException("配对包标识无效");
    }
    public static void sameBinding(String oldScope, String oldLocal, String scope, String local) {
        if (!oldScope.isEmpty() && (!oldScope.equals(scope) || !oldLocal.equals(local)))
            throw new IllegalArgumentException("本机已绑定其他患者或设备；只能续期原绑定。请先导出记录，撤销旧授权并清除应用数据后更换");
    }
    public static boolean uploadable(boolean live, String metric, double value) {
        if (!live || !Double.isFinite(value) || value <= 0) return false;
        return switch (metric) {
            case "hr", "bp_hr" -> value <= 300;
            case "spo2" -> value <= 100;
            case "bp_sys", "bp_dia" -> value <= 300;
            case "temp" -> value >= 20 && value <= 50;
            case "glu" -> value <= 100;
            case "stress" -> value <= 1000;
            case "hrv" -> value <= 10000;
            case "pi" -> value <= 100;
            default -> false;
        };
    }
}
