package org.rareguard.core;

/** Experimental boundaries only. Missing/invalid/history data breaks evidence, never implies recovery. */
public final class ChangeRule {
    public Double hrLow,hrHigh,spo2Low;
    public int durationSeconds,maxGapSeconds,requiredSignals;
    public boolean enabled,allowUnknown;
    private Long hrAt,spo2At,since;
    private boolean hrOut,spo2Out,emitted;
    public void reset(){hrAt=spo2At=since=null;hrOut=spo2Out=emitted=false;}
    public boolean feed(String metric,double value,String source,String quality,long monotonicMs){
        if(!enabled)return false;
        if(!metric.equals("hr") && !metric.equals("spo2"))return false;
        if(!Double.isFinite(value) || !source.equals("live_device") || !(quality.equals("good") || (quality.equals("unknown")&&allowUnknown))){
            if(metric.equals("hr")){hrAt=null;hrOut=false;}else{spo2At=null;spo2Out=false;}
            since=null;emitted=false;return false;
        }
        tick(monotonicMs);
        if(metric.equals("hr")){hrAt=monotonicMs;hrOut=(hrLow!=null&&value<hrLow)||(hrHigh!=null&&value>hrHigh);}
        else {spo2At=monotonicMs;spo2Out=spo2Low!=null&&value<spo2Low;}
        int out=(fresh(hrAt,monotonicMs)&&hrOut?1:0)+(fresh(spo2At,monotonicMs)&&spo2Out?1:0);
        if(out<requiredSignals){since=null;emitted=false;return false;}
        if(since==null)since=monotonicMs;
        if(!emitted&&monotonicMs-since>=durationSeconds*1000L){emitted=true;return true;}return false;
    }
    private boolean fresh(Long at,long now){return at!=null&&now>=at&&now-at<=maxGapSeconds*1000L;}
    public void tick(long now){
        boolean hrStale=hrAt!=null&&!fresh(hrAt,now),spoStale=spo2At!=null&&!fresh(spo2At,now);
        if((hrOut&&hrStale)||(spo2Out&&spoStale)){since=null;emitted=false;}
        if(hrStale){hrAt=null;hrOut=false;}if(spoStale){spo2At=null;spo2Out=false;}
    }
}
