package org.rareguard.core;

import java.time.DateTimeException;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** MR11 EFE mapping reviewed against ECTRI Java and smali. No vendor SDK required. */
public final class EfeProtocol {
    public static final String SERVICE = "f000efe0-0451-4000-0000-00000000b000";
    public static final String WRITE = "f000efe1-0451-4000-0000-00000000b000";
    public static final String NOTIFY = "f000efe3-0451-4000-0000-00000000b000";
    public static final String VERSION = "efe-mr11-reviewed-1";

    public enum Metric {
        HR(0x0a, 2, "hr", "心率", "bpm"),
        SPO2(0x12, 6, "spo2", "血氧", "%"),
        BP(0x11, 5, "bp", "血压", "mmHg"),
        TEMP(0x40, 7, "temp", "皮温", "°C"),
        GLU(0x0b, 8, "glu", "血糖", "mmol/L"),
        STRESS(0x5d, 9, "stress", "厂商压力值", "vendor_scalar"),
        HRV(0x64, 11, "hrv", "厂商 HRV 值", "vendor_scalar");
        public final int opcode, measureType;
        public final String key, label, unit;
        Metric(int opcode, int type, String key, String label, String unit) {
            this.opcode = opcode; this.measureType = type;
            this.key = key; this.label = label; this.unit = unit;
        }
        public static Metric fromOpcode(int opcode) {
            for (Metric m : values()) if (m.opcode == opcode) return m;
            return null;
        }
    }

    public static final class Value {
        public final String metric, unit;
        public final double value;
        Value(String metric, double value, String unit) {
            this.metric = metric; this.value = value; this.unit = unit;
        }
    }
    public static final class Frame {
        public String kind = "unparsed", source = "unknown", deviceLocalTime;
        public Metric metric;
        public int subtype = -1, count, index, battery = -1, status = -1;
        public Integer stopType, stopError;
        public String firmware;
        public boolean live, error, stopIndication;
        public final List<Value> values = new ArrayList<>();
    }

    public static byte[] command(int opcode, int subtype) {
        if (Metric.fromOpcode(opcode) == null || subtype < 0 || subtype > 2)
            throw new IllegalArgumentException("Only reviewed read queries are allowed");
        return padded(0xfc, opcode, subtype);
    }
    public static byte[] measure(Metric metric) { return padded(0xfc, 9, metric.measureType); }
    public static byte[] stop() { return padded(0xfc, 9, 0); }
    public static byte[] battery() { return padded(0xfc, 15, 6); }
    public static byte[] info() { return padded(0xfc, 15, 5); }
    /** Official ECTRI ManHealthTestErrorType mapping; describes the device's judgement. */
    public static String measurementStopMessage(int type, int error) {
        if (error == 0) return null;
        String label = "测量";
        for (Metric m : Metric.values()) if (m.measureType == type) label = m.label + "测量";
        if (error == 1) return label + "停止：戒指判定未正确佩戴（错误码 1）；请检查内侧传感器贴合皮肤，调整佩戴后重试。";
        if (error == 2) return label + "停止：戒指未检测到有效心率（错误码 2）；请保持静止、检查佩戴后重试。";
        return label + "停止：戒指返回错误码 " + error + "，具体原因尚未确认。";
    }
    private static byte[] padded(int... bytes) {
        byte[] result = new byte[20];
        for (int i = 0; i < bytes.length; i++) result[i] = (byte) bytes[i];
        return result;
    }
    private static int u(byte[] b, int i) { return b[i] & 0xff; }
    private static int be(byte[] b, int i) { return (u(b,i) << 8) | u(b,i+1); }

    public static Frame decode(byte[] b) {
        Frame f = new Frame();
        if (b == null || b.length != 20) return f;
        int op = u(b,0), sub = u(b,1);
        if (op == 0x89 || op == 0x8a || op == 0x8b || op == 0x8c || op == 0x91 ||
                op == 0x92 || op == 0xc0 || op == 0xdd) {
            f.kind = "device_status"; f.stopIndication = op == 0x89; f.error = op != 0x89;
            f.status = op; return f;
        }
        if (op == 0xfc && sub == 9) {
            f.kind = "measurement_status"; f.status = u(b,3);
            if (f.status == 0 && u(b,9) == 0xaa) f.status = u(b,10);
            if (u(b,6) == 0xaa) { f.stopType = u(b,7); f.stopError = u(b,8); }
            return f;
        }
        if (op == 15 && sub == 6) {
            f.kind = "battery"; if (u(b,8) <= 100) f.battery = u(b,8); return f;
        }
        if (op == 15 && sub == 5) {
            f.kind = "device_info";
            f.firmware = u(b,7) + "." + u(b,8) + "." + u(b,9); return f;
        }
        f.metric = Metric.fromOpcode(op);
        if (f.metric == null) return f;
        f.kind = "health"; f.subtype = sub;
        f.count = be(b,2); f.index = be(b,4);
        f.source = sub == 3 || sub == 4 ? "live_device" :
                sub == 0 || sub == 1 ? "device_history" : "unknown";
        f.live = sub == 3 || sub == 4;
        f.error = sub == 5;
        f.deviceLocalTime = decodeLocalDate(b);
        if (sub == 2 || (sub == 1 && f.count == 0) || !(sub == 0 || sub == 1 || sub == 3 || sub == 4)) return f;
        switch (f.metric) {
            case HR: f.values.add(new Value("hr",u(b,12),"bpm")); break;
            case SPO2:
                int digit = u(b,13); while (digit >= 10) digit /= 10;
                f.values.add(new Value("spo2",u(b,12) + digit/10.0,"%"));
                f.values.add(new Value("pi",u(b,14)/1000.0,"vendor_pi")); break;
            case BP:
                f.values.add(new Value("bp_sys",u(b,12),"mmHg"));
                f.values.add(new Value("bp_dia",u(b,13),"mmHg"));
                f.values.add(new Value("bp_hr",u(b,14),"bpm")); break;
            case TEMP: f.values.add(new Value("temp",be(b,12)/10.0*(u(b,14)==0?1:-1),"°C")); break;
            case GLU: f.values.add(new Value("glu",u(b,12)+u(b,13)/10.0,"mmol/L")); break;
            case STRESS: case HRV: f.values.add(new Value(f.metric.key,u(b,12),"vendor_scalar")); break;
        }
        return f;
    }
    private static String decodeLocalDate(byte[] b) {
        int[] parts = new int[6];
        for (int i=0; i<6; i++) {
            int v=u(b,6+i);
            if ((v & 15) > 9 || (v >> 4) > 9) return null;
            parts[i]=(v >> 4)*10+(v & 15);
        }
        try {
            return LocalDateTime.of(2000+parts[0],parts[1],parts[2],parts[3],parts[4],parts[5]).toString();
        } catch (DateTimeException invalid) { return null; }
    }
    public static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte b : bytes) result.append(String.format(Locale.ROOT,"%02x",b & 255));
        return result.toString();
    }
}
