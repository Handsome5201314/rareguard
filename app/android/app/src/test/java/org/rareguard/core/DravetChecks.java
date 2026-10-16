package org.rareguard.core;

public final class DravetChecks {
    private static int count;
    private static void check(boolean ok) { if (!ok) throw new AssertionError("Dravet boundary " + count); count++; }
    private static boolean rejected(Runnable action) { try { action.run(); return false; } catch (IllegalArgumentException e) { return true; } }
    public static void main(String[] args) {
        check(DravetPolicy.allowedWeb(DravetPolicy.OCTOP));
        check(DravetPolicy.allowedWeb(DravetPolicy.BUSINESS + "/dravet"));
        for (String url : new String[]{null, "", "http://bingcheng.tongyimoheai.top/", "https://bingcheng.tongyimoheai.top.evil.test/", "https://evil.test@bingcheng.tongyimoheai.top/", "https://bingcheng.tongyimoheai.top:8443/", "javascript:alert(1)", "file:///etc/passwd", "intent://x", "https://octop.tongyimoheai.top\\@evil.test"}) check(!DravetPolicy.allowedWeb(url));
        check(DravetPolicy.uploadable(true, "hr", 80));
        check(DravetPolicy.uploadable(true, "spo2", 98));
        check(DravetPolicy.uploadable(true, "bp_sys", 120));
        check(DravetPolicy.uploadable(true, "bp_dia", 80));
        check(DravetPolicy.uploadable(true, "bp_hr", 72));
        check(DravetPolicy.uploadable(true, "temp", 36.5));
        check(DravetPolicy.uploadable(true, "glu", 5.2));
        check(DravetPolicy.uploadable(true, "stress", 20));
        check(DravetPolicy.uploadable(true, "hrv", 55));
        check(DravetPolicy.uploadable(true, "pi", 1.2));
        check(!DravetPolicy.uploadable(false, "hr", 80));
        check(!DravetPolicy.uploadable(true, "hr", 0));
        check(!DravetPolicy.uploadable(true, "spo2", 101));
        check(!DravetPolicy.uploadable(true, "hr", Double.NaN));
        check(!DravetPolicy.uploadable(true, "temp", 10));
        check(!DravetPolicy.uploadable(true, "unknown", 1));
        DravetPolicy.sameBinding("", "", "patient:device", "ring"); check(true);
        DravetPolicy.sameBinding("patient:device", "ring", "patient:device", "ring"); check(true);
        check(rejected(() -> DravetPolicy.sameBinding("patient:device", "ring", "other:device", "ring")));
        check(rejected(() -> DravetPolicy.sameBinding("patient:device", "ring", "patient:other", "ring")));
        check(rejected(() -> DravetPolicy.sameBinding("patient:device", "ring", "patient:device", "other")));
        check(rejected(() -> DravetPolicy.uuid("1-1-1-1-1")));
        DravetPolicy.uuid("11111111-1111-4111-8111-111111111111"); check(true);
        System.out.println("Dravet boundary checks: " + count + " passed");
    }
}
