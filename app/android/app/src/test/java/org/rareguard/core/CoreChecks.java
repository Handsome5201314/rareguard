package org.rareguard.core;

/** Synthetic fixtures only; run with java -ea. Never shipped in the APK. */
public final class CoreChecks {
    private static int checks;
    private static byte[] hex(String h) {
        byte[] b = new byte[h.length()/2];
        for (int i=0;i<b.length;i++) b[i]=(byte)Integer.parseInt(h.substring(i*2,i*2+2),16);
        return b;
    }
    private static void equal(Object a, Object b) {
        checks++; if (!a.equals(b)) throw new AssertionError(a+" != "+b);
    }
    public static void main(String[] args) {
        byte[] glu=hex("0b03000100012610101234560502000000000000");
        EfeProtocol.Frame f=EfeProtocol.decode(glu);
        equal(f.values.get(0).value,5.2); equal(f.deviceLocalTime,"2026-10-10T12:34:56");
        equal(f.live,true); equal(f.source,"live_device");
        for(int subtype : new int[]{0,1,2,5}) {
            byte[] b=glu.clone(); b[1]=(byte)subtype;
            EfeProtocol.Frame d=EfeProtocol.decode(b);
            equal(d.live,false);
            if(subtype==2 || subtype==5) equal(d.values.size(),0);
        }
        byte[] emptyHistory=glu.clone(); emptyHistory[1]=1; emptyHistory[2]=0; emptyHistory[3]=0;
        equal(EfeProtocol.decode(emptyHistory).values.size(),0);
        equal(EfeProtocol.decode(hex("120300010001261010123456622d070000000000")).values.get(0).value,98.4);
        equal(EfeProtocol.decode(hex("4003000100012610101234560173010000000000")).values.get(0).value,-37.1);
        EfeProtocol.Frame extended=EfeProtocol.decode(hex("fc0900000000aa0b01aa01000000000000000000"));
        equal(extended.status,1); equal(extended.stopType,11); equal(extended.stopError,1);
        equal(extended.values.size(),0);
        equal(EfeProtocol.measurementStopMessage(extended.stopType,extended.stopError),"厂商 HRV 值测量停止：戒指判定未正确佩戴（错误码 1）；请检查内侧传感器贴合皮肤，调整佩戴后重试。");
        equal(EfeProtocol.measurementStopMessage(2,2),"心率测量停止：戒指未检测到有效心率（错误码 2）；请保持静止、检查佩戴后重试。");
        equal(EfeProtocol.measurementStopMessage(6,7),"血氧测量停止：戒指返回错误码 7，具体原因尚未确认。");
        equal(EfeProtocol.measurementStopMessage(99,1),"测量停止：戒指判定未正确佩戴（错误码 1）；请检查内侧传感器贴合皮肤，调整佩戴后重试。");
        if(EfeProtocol.measurementStopMessage(2,0)!=null)throw new AssertionError("NoError shown as a failure"); checks++;
        byte[] invalidDate=glu.clone(); invalidDate[7]=0x1a;
        if(EfeProtocol.decode(invalidDate).deviceLocalTime!=null) throw new AssertionError("Invalid BCD accepted"); checks++;
        equal(EfeProtocol.decode(new byte[3]).kind,"unparsed");
        equal(EfeProtocol.decode(new byte[]{(byte)0x89,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0}).stopIndication,true);
        equal(EfeProtocol.measure(EfeProtocol.Metric.GLU).length,20);
        equal(EfeProtocol.hex(EfeProtocol.stop()),"fc09000000000000000000000000000000000000");
        MeasurementWindow window=new MeasurementWindow();
        window.start(EfeProtocol.Metric.GLU,100,45000);
        byte[] last=glu.clone(); last[1]=0;
        equal(window.accept(EfeProtocol.decode(last),200),false);
        byte[] delayed=glu.clone(); delayed[0]=0x0a;
        equal(window.accept(EfeProtocol.decode(delayed),300),false);
        equal(window.accept(f,99),false); equal(window.accept(f,45100),false);
        equal(window.accept(f,400),true); equal(window.finish(),1);
        equal(window.accept(f,500),false);
        boolean blocked=false;
        try { EfeProtocol.command(0x99,1); } catch(IllegalArgumentException e) { blocked=true; }
        equal(blocked,true);
        System.out.println("Core protocol checks passed: "+checks);
    }
}
