package org.rareguard.core;

/** Synthetic evidence only; this test directory is excluded from the APK. */
public final class RuleChecks {
    private static int checks;
    private static void expect(boolean actual, boolean expected) { checks++; if(actual!=expected)throw new AssertionError("Rule check "+checks+" failed"); }
    private static ChangeRule rule(int signals) {
        ChangeRule r=new ChangeRule();r.enabled=true;r.allowUnknown=true;r.hrHigh=100.0;r.spo2Low=95.0;
        r.durationSeconds=30;r.maxGapSeconds=10;r.requiredSignals=signals;return r;
    }
    private static boolean hr(ChangeRule r,long at) {return r.feed("hr",110,"live_device","unknown",at);}
    private static boolean spo(ChangeRule r,long at) {return r.feed("spo2",90,"live_device","unknown",at);}
    public static void main(String[] args) {
        ChangeRule r=rule(2);
        expect(hr(r,0),false);expect(spo(r,1),false);
        for(long t=5000;t<=25000;t+=5000){expect(hr(r,t),false);expect(spo(r,t+1),false);}
        // Invalid HR removes its freshness. A subsequent SpO2 point cannot reuse old HR evidence.
        expect(r.feed("hr",0,"live_device","invalid",27000),false);
        expect(spo(r,28000),false);
        expect(hr(r,30000),false);
        for(long t=35000;t<60000;t+=5000){expect(hr(r,t),false);expect(spo(r,t+1),false);}
        expect(hr(r,58000),false);
        expect(spo(r,60000),true);
        expect(hr(r,60001),false); // Receipt acknowledgement is separate and never resets the rule.
        r=rule(1);r.allowUnknown=false;expect(hr(r,0),false);expect(hr(r,30000),false);
        r=rule(1);expect(hr(r,0),false);expect(hr(r,5000),false);r.tick(16000);
        expect(hr(r,17000),false);expect(hr(r,22000),false);expect(hr(r,27000),false);expect(hr(r,32000),false);expect(hr(r,37000),false);expect(hr(r,42000),false);expect(hr(r,47000),true);
        r=rule(1);expect(hr(r,0),false);expect(hr(r,5000),false);
        expect(r.feed("hr",110,"device_history","unknown",6000),false);
        expect(hr(r,7000),false);
        r=rule(1);r.enabled=false;expect(hr(r,0),false);expect(hr(r,30000),false);
        r=rule(1);expect(r.feed("hr",Double.NaN,"live_device","good",0),false);expect(hr(r,1),false);
        System.out.println("Experimental rule checks passed: "+checks);
    }
}
