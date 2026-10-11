package org.rareguard.app;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import org.rareguard.core.EfeProtocol;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/** Private app storage. Raw device wall time is never silently converted to UTC. */
public final class LocalStore extends SQLiteOpenHelper {
    public LocalStore(Context context) { super(context,"rareguard.db",null,2); }
    @Override public void onConfigure(SQLiteDatabase db) { db.setForeignKeyConstraintsEnabled(true); }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE devices (id TEXT PRIMARY KEY,address TEXT NOT NULL UNIQUE,name TEXT NOT NULL,firmware TEXT,server_id TEXT)");
        db.execSQL("CREATE TABLE samples (id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id),metric TEXT NOT NULL,value REAL NOT NULL,unit TEXT NOT NULL,source TEXT NOT NULL,quality TEXT NOT NULL,observed_at TEXT,received_at TEXT NOT NULL,received_ms INTEGER NOT NULL,device_local_time TEXT,vendor_sequence INTEGER,decoder_version TEXT NOT NULL,raw_hex TEXT NOT NULL,sync_state TEXT NOT NULL DEFAULT 'pending',batch_id TEXT)");
        db.execSQL("CREATE INDEX sample_time ON samples(device_id,metric,received_ms)");
        db.execSQL("CREATE TABLE events (id TEXT PRIMARY KEY,device_id TEXT,kind TEXT NOT NULL,text TEXT NOT NULL,occurred_ms INTEGER NOT NULL,recorded_ms INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE outbox (id TEXT PRIMARY KEY,device_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',error TEXT,created_ms INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE alert_outbox (id TEXT PRIMARY KEY,payload TEXT NOT NULL)");
        db.execSQL("ALTER TABLE events ADD COLUMN uploaded INTEGER NOT NULL DEFAULT 0");
    }
    @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion) {
        if(oldVersion==1&&newVersion==2){db.execSQL("CREATE TABLE alert_outbox (id TEXT PRIMARY KEY,payload TEXT NOT NULL)");db.execSQL("ALTER TABLE events ADD COLUMN uploaded INTEGER NOT NULL DEFAULT 0");}
        else throw new IllegalStateException("No migration registered for this database version");
    }
    public synchronized String device(String address,String name) {
        SQLiteDatabase db=getWritableDatabase();
        try(Cursor c=db.rawQuery("SELECT id FROM devices WHERE address=?",new String[]{address})) {
            if(c.moveToFirst()) return c.getString(0);
        }
        String id=UUID.randomUUID().toString(); ContentValues v=new ContentValues();
        v.put("id",id); v.put("address",address); v.put("name",name); db.insertOrThrow("devices",null,v); return id;
    }
    public synchronized void firmware(String id,String firmware) {
        ContentValues v=new ContentValues();v.put("firmware",firmware);
        getWritableDatabase().update("devices",v,"id=?",new String[]{id});
    }
    public synchronized int save(String deviceId,EfeProtocol.Frame frame,byte[] raw,long receivedMs) {
        if(frame.values.isEmpty()) return 0;
        SQLiteDatabase db=getWritableDatabase(); int inserted=0;
        db.beginTransaction();
        try {
            for(EfeProtocol.Value value:frame.values) {
                // Preserve invalid values with visible quality; zero is not evidence of an active result.
                String quality=value.value==0?"invalid":"unknown";
                String id=frame.live?UUID.randomUUID().toString():hash(deviceId+":"+value.metric+":"+EfeProtocol.hex(raw));
                ContentValues v=new ContentValues();
                v.put("id",id);v.put("device_id",deviceId);v.put("metric",value.metric);v.put("value",value.value);
                v.put("unit",value.unit);v.put("source",frame.source);v.put("quality",quality);
                if(frame.live) v.put("observed_at",Instant.ofEpochMilli(receivedMs).toString());
                v.put("received_at",Instant.ofEpochMilli(receivedMs).toString());v.put("received_ms",receivedMs);
                v.put("device_local_time",frame.deviceLocalTime);v.put("vendor_sequence",frame.index);
                v.put("decoder_version",EfeProtocol.VERSION);v.put("raw_hex",EfeProtocol.hex(raw));
                if(!frame.live || (!value.metric.equals("hr") && !value.metric.equals("spo2"))) v.put("sync_state","local_only");
                if(db.insertWithOnConflict("samples",null,v,SQLiteDatabase.CONFLICT_IGNORE)!=-1) inserted++;
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        return inserted;
    }
    private static String hash(String value) {
        try { return EfeProtocol.hex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch(NoSuchAlgorithmException e) { throw new IllegalStateException(e); }
    }
    public synchronized void event(String deviceId,String kind,String text,long occurredMs) {
        if(text.trim().isEmpty() || text.length()>2000) throw new IllegalArgumentException("记录内容需为 1–2000 字");
        ContentValues v=new ContentValues(); v.put("id",UUID.randomUUID().toString());v.put("device_id",deviceId);
        v.put("kind",kind);v.put("text",text);v.put("occurred_ms",occurredMs);v.put("recorded_ms",System.currentTimeMillis());
        getWritableDatabase().insertOrThrow("events",null,v);
    }
    public static final class Sample {
        public String id,deviceId,metric,unit,source,quality,observedAt,receivedAt,deviceLocalTime,syncState,rawHex;
        public double value;
        public long receivedMs;
        public int sequence;
    }
    private static Sample sample(Cursor c) {
        Sample s=new Sample();s.id=c.getString(c.getColumnIndexOrThrow("id"));
        s.deviceId=c.getString(c.getColumnIndexOrThrow("device_id"));s.metric=c.getString(c.getColumnIndexOrThrow("metric"));
        s.value=c.getDouble(c.getColumnIndexOrThrow("value"));s.unit=c.getString(c.getColumnIndexOrThrow("unit"));
        s.source=c.getString(c.getColumnIndexOrThrow("source"));s.quality=c.getString(c.getColumnIndexOrThrow("quality"));
        s.observedAt=c.getString(c.getColumnIndexOrThrow("observed_at"));s.receivedAt=c.getString(c.getColumnIndexOrThrow("received_at"));
        s.receivedMs=c.getLong(c.getColumnIndexOrThrow("received_ms"));s.deviceLocalTime=c.getString(c.getColumnIndexOrThrow("device_local_time"));
        s.syncState=c.getString(c.getColumnIndexOrThrow("sync_state"));s.rawHex=c.getString(c.getColumnIndexOrThrow("raw_hex"));
        s.sequence=c.getInt(c.getColumnIndexOrThrow("vendor_sequence"));return s;
    }
    public synchronized List<Sample> samples(String deviceId,String metric,long fromMs,long toMs,boolean liveOnly,int limit) {
        List<Sample> result=new ArrayList<>(); if(deviceId==null) return result;
        String sql="SELECT * FROM samples WHERE device_id=? AND metric=? AND received_ms>=? AND received_ms<?"+
                (liveOnly?" AND source='live_device'":"")+" ORDER BY received_ms DESC,id DESC LIMIT ?";
        try(Cursor c=getReadableDatabase().rawQuery(sql,new String[]{deviceId,metric,Long.toString(fromMs),Long.toString(toMs),Integer.toString(limit)})) {
            while(c.moveToNext()) result.add(sample(c));
        }
        java.util.Collections.reverse(result);return result;
    }
    public synchronized Sample latest(String deviceId,String metric,boolean liveOnly) {
        List<Sample> values=samples(deviceId,metric,0,Long.MAX_VALUE,liveOnly,1);return values.isEmpty()?null:values.get(0);
    }
    public static final class Event { public String id,kind,text; public long occurredMs,recordedMs; }
    public synchronized List<Event> events(String deviceId,int limit) {
        List<Event> result=new ArrayList<>(); if(deviceId==null) return result;
        return readEvents("SELECT * FROM events WHERE device_id=? ORDER BY occurred_ms DESC LIMIT ?",new String[]{deviceId,Integer.toString(limit)});
    }
    public synchronized List<Event> allEvents(){return readEvents("SELECT * FROM events ORDER BY occurred_ms DESC",null);}
    private List<Event> readEvents(String sql,String[] args){
        List<Event> result=new ArrayList<>();
        try(Cursor c=getReadableDatabase().rawQuery(sql,args)) {
            while(c.moveToNext()) {Event e=new Event();e.id=c.getString(c.getColumnIndexOrThrow("id"));e.kind=c.getString(c.getColumnIndexOrThrow("kind"));
                e.text=c.getString(c.getColumnIndexOrThrow("text"));e.occurredMs=c.getLong(c.getColumnIndexOrThrow("occurred_ms"));
                e.recordedMs=c.getLong(c.getColumnIndexOrThrow("recorded_ms"));result.add(e);}
        }
        return result;
    }
    public synchronized int pendingCount() {
        try(Cursor c=getReadableDatabase().rawQuery("SELECT count(*) FROM samples WHERE sync_state IN ('pending','sending')",null)) {c.moveToFirst();return c.getInt(0);}
    }
    public synchronized List<Sample> pending(String deviceId,int limit) {
        List<Sample> result=new ArrayList<>();
        try(Cursor c=getReadableDatabase().rawQuery("SELECT * FROM samples WHERE device_id=? AND sync_state='pending' ORDER BY received_ms,id LIMIT ?",new String[]{deviceId,Integer.toString(limit)})) {while(c.moveToNext()) result.add(sample(c));}
        return result;
    }
    public synchronized String serverId(String deviceId) {
        try(Cursor c=getReadableDatabase().rawQuery("SELECT server_id FROM devices WHERE id=?",new String[]{deviceId})) {return c.moveToFirst()?c.getString(0):null;}
    }
    public synchronized void bindServer(String deviceId,String serverId) {
        ContentValues v=new ContentValues();v.put("server_id",serverId);getWritableDatabase().update("devices",v,"id=?",new String[]{deviceId});
    }
    public synchronized List<Sample> allSamples() {
        List<Sample> result=new ArrayList<>();try(Cursor c=getReadableDatabase().rawQuery("SELECT * FROM samples ORDER BY received_ms,id",null)) {while(c.moveToNext()) result.add(sample(c));}return result;
    }
    public synchronized void clearHealthData() {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {db.delete("outbox",null,null);db.delete("alert_outbox",null,null);db.delete("samples",null,null);db.delete("events",null,null);db.setTransactionSuccessful();}
        finally {db.endTransaction();}
    }
    public synchronized String createBatch(String deviceId,String serverId) throws org.json.JSONException {
        SQLiteDatabase db=getWritableDatabase(); db.beginTransaction();
        try {
            try(Cursor c=db.rawQuery("SELECT payload FROM outbox WHERE device_id=? AND status='pending' ORDER BY created_ms LIMIT 1",new String[]{deviceId})) {
                if(c.moveToFirst()) {db.setTransactionSuccessful();return c.getString(0);}
            }
            List<Sample> rows=pending(deviceId,200); if(rows.isEmpty()) {db.setTransactionSuccessful();return null;}
            String batchId=UUID.randomUUID().toString(); org.json.JSONArray samples=new org.json.JSONArray();
            for(Sample s:rows) {
                org.json.JSONObject j=new org.json.JSONObject();
                j.put("sample_id",s.id);j.put("metric",s.metric);j.put("value",s.value);j.put("unit",s.unit);
                j.put("source",s.source);j.put("quality",s.quality);j.put("observed_at",s.observedAt);j.put("phone_received_at",s.receivedAt);
                j.put("time_basis","phone_receive");j.put("vendor_sequence",s.sequence);j.put("decoder_version",EfeProtocol.VERSION);
                j.put("device_local_time",s.deviceLocalTime==null?org.json.JSONObject.NULL:s.deviceLocalTime);samples.put(j);
                ContentValues update=new ContentValues();update.put("sync_state","sending");update.put("batch_id",batchId);db.update("samples",update,"id=?",new String[]{s.id});
            }
            String payload=new org.json.JSONObject().put("schema_version",1).put("batch_id",batchId).put("device_id",serverId).put("app_version","0.1.0").put("samples",samples).toString();
            ContentValues v=new ContentValues();v.put("id",batchId);v.put("device_id",deviceId);v.put("payload",payload);v.put("created_ms",System.currentTimeMillis());
            db.insertOrThrow("outbox",null,v);db.setTransactionSuccessful();return payload;
        } finally {db.endTransaction();}
    }
    public synchronized void batchCommitted(String id) {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {ContentValues v=new ContentValues();v.put("sync_state","uploaded");db.update("samples",v,"batch_id=?",new String[]{id});db.delete("outbox","id=?",new String[]{id});db.setTransactionSuccessful();}
        finally {db.endTransaction();}
    }
    public synchronized void queueAlert(org.json.JSONObject j) throws org.json.JSONException {
        ContentValues v=new ContentValues();v.put("id",j.getString("id"));v.put("payload",j.toString());getWritableDatabase().insertOrThrow("alert_outbox",null,v);
    }
    public synchronized List<org.json.JSONObject> pendingAlerts() throws org.json.JSONException {
        List<org.json.JSONObject> result=new ArrayList<>();try(Cursor c=getReadableDatabase().rawQuery("SELECT payload FROM alert_outbox",null)){while(c.moveToNext())result.add(new org.json.JSONObject(c.getString(0)));}return result;
    }
    public synchronized void alertCommitted(String id){getWritableDatabase().delete("alert_outbox","id=?",new String[]{id});}
    public synchronized List<org.json.JSONObject> observations(String deviceId,String serverId) throws org.json.JSONException {
        List<org.json.JSONObject> result=new ArrayList<>();
        try(Cursor c=getReadableDatabase().rawQuery("SELECT id,text,occurred_ms FROM events WHERE device_id=? AND kind='observation' AND uploaded=0 LIMIT 100",new String[]{deviceId})){
            while(c.moveToNext())result.add(new org.json.JSONObject().put("id",c.getString(0)).put("device_id",serverId).put("text",c.getString(1)).put("occurred_at",Instant.ofEpochMilli(c.getLong(2)).toString()));}return result;
    }
    public synchronized void observationCommitted(String id){ContentValues v=new ContentValues();v.put("uploaded",1);getWritableDatabase().update("events",v,"id=?",new String[]{id});}
}
