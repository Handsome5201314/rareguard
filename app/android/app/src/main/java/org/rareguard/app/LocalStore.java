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
    private final String sessionId=UUID.randomUUID().toString();
    private long sequence;
    public LocalStore(Context context) { super(context,"rareguard.db",null,3); }
    @Override public void onConfigure(SQLiteDatabase db) { db.setForeignKeyConstraintsEnabled(true); }
    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE devices (id TEXT PRIMARY KEY,address TEXT NOT NULL UNIQUE,name TEXT NOT NULL,firmware TEXT,server_id TEXT)");
        db.execSQL("CREATE TABLE samples (id TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id),metric TEXT NOT NULL,value REAL NOT NULL,unit TEXT NOT NULL,source TEXT NOT NULL,quality TEXT NOT NULL,observed_at TEXT,received_at TEXT NOT NULL,received_ms INTEGER NOT NULL,device_local_time TEXT,vendor_sequence INTEGER,decoder_version TEXT NOT NULL,raw_hex TEXT NOT NULL,sync_state TEXT NOT NULL DEFAULT 'pending',batch_id TEXT)");
        db.execSQL("CREATE INDEX sample_time ON samples(device_id,metric,received_ms)");
        db.execSQL("CREATE TABLE events (id TEXT PRIMARY KEY,device_id TEXT,kind TEXT NOT NULL,text TEXT NOT NULL,occurred_ms INTEGER NOT NULL,recorded_ms INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE outbox (id TEXT PRIMARY KEY,device_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',error TEXT,created_ms INTEGER NOT NULL)");
        db.execSQL("CREATE TABLE alert_outbox (id TEXT PRIMARY KEY,payload TEXT NOT NULL)");
        db.execSQL("ALTER TABLE events ADD COLUMN uploaded INTEGER NOT NULL DEFAULT 0");
        migrateDravet(db);
    }
    @Override public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion) {
        if(oldVersion<1 || newVersion!=3)throw new IllegalStateException("No migration registered for this database version");
        if(oldVersion<2){db.execSQL("CREATE TABLE alert_outbox (id TEXT PRIMARY KEY,payload TEXT NOT NULL)");db.execSQL("ALTER TABLE events ADD COLUMN uploaded INTEGER NOT NULL DEFAULT 0");}
        if(oldVersion<3)migrateDravet(db);
    }
    private void migrateDravet(SQLiteDatabase db) {
        // No backfill: previous records and old outboxes retain their original ownership.
        db.execSQL("ALTER TABLE samples ADD COLUMN upload_scope TEXT");
        db.execSQL("ALTER TABLE samples ADD COLUMN session_id TEXT");
        db.execSQL("ALTER TABLE samples ADD COLUMN sample_sequence INTEGER");
        db.execSQL("ALTER TABLE events ADD COLUMN upload_scope TEXT");
        db.execSQL("ALTER TABLE events ADD COLUMN session_id TEXT");
        db.execSQL("CREATE TABLE dravet_binding (id INTEGER PRIMARY KEY CHECK(id=1),scope TEXT NOT NULL,local_id TEXT NOT NULL)");
        db.execSQL("CREATE TABLE dravet_outbox (id TEXT PRIMARY KEY,scope TEXT NOT NULL,local_id TEXT NOT NULL,payload TEXT NOT NULL,created_ms INTEGER NOT NULL)");
    }
    public synchronized void bindDravet(String scope,String localId) {
        SQLiteDatabase db=getWritableDatabase();
        checkBinding(scope,localId);
        ContentValues v=new ContentValues();v.put("id",1);v.put("scope",scope);v.put("local_id",localId);
        db.insertWithOnConflict("dravet_binding",null,v,SQLiteDatabase.CONFLICT_REPLACE);
    }
    public synchronized void checkBinding(String scope,String localId) {
        SQLiteDatabase db=getWritableDatabase();
        try(Cursor c=db.rawQuery("SELECT scope,local_id FROM dravet_binding WHERE id=1",null)) {
            if(c.moveToFirst())org.rareguard.core.DravetPolicy.sameBinding(c.getString(0),c.getString(1),scope,localId);
        }
    }
    private String captureScope(String localId) {
        if(localId==null)return null;
        try(Cursor c=getReadableDatabase().rawQuery("SELECT scope FROM dravet_binding WHERE id=1 AND local_id=?",new String[]{localId})) {return c.moveToFirst()?c.getString(0):null;}
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
                String scope=captureScope(deviceId);
                v.put("session_id",sessionId);v.put("sample_sequence",sequence++);
                if(scope!=null && org.rareguard.core.DravetPolicy.uploadable(frame.live,value.metric,value.value))v.put("upload_scope",scope);
                else v.put("sync_state","local_only");
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
        v.put("upload_scope",captureScope(deviceId));v.put("session_id",sessionId);
        getWritableDatabase().insertOrThrow("events",null,v);
    }
    public static final class Sample {
        public String id,deviceId,metric,unit,source,quality,observedAt,receivedAt,deviceLocalTime,syncState,rawHex,sessionId,uploadScope;
        public long sampleSequence;
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
        s.sequence=c.getInt(c.getColumnIndexOrThrow("vendor_sequence"));
        s.sessionId=c.getString(c.getColumnIndexOrThrow("session_id"));s.uploadScope=c.getString(c.getColumnIndexOrThrow("upload_scope"));s.sampleSequence=c.getLong(c.getColumnIndexOrThrow("sample_sequence"));return s;
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
        try(Cursor c=getReadableDatabase().rawQuery("SELECT count(*) FROM samples WHERE upload_scope IS NOT NULL AND sync_state IN ('pending','sending')",null)){c.moveToFirst();return c.getInt(0);}
    }
    public synchronized int legacyPending() {
        try(Cursor c=getReadableDatabase().rawQuery("SELECT count(*) FROM samples WHERE upload_scope IS NULL AND sync_state IN ('pending','sending')",null)){c.moveToFirst();return c.getInt(0);}
    }
    public synchronized List<Sample> allSamples() {
        List<Sample> result=new ArrayList<>();try(Cursor c=getReadableDatabase().rawQuery("SELECT * FROM samples ORDER BY received_ms,id",null)) {while(c.moveToNext()) result.add(sample(c));}return result;
    }
    public synchronized void clearHealthData() {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {db.delete("dravet_outbox",null,null);db.delete("outbox",null,null);db.delete("alert_outbox",null,null);db.delete("samples",null,null);db.delete("events",null,null);db.setTransactionSuccessful();}
        finally {db.endTransaction();}
    }
    public synchronized String createBatch(String localId,String scope) throws org.json.JSONException {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {
            try(Cursor c=db.rawQuery("SELECT payload FROM dravet_outbox WHERE local_id=? AND scope=? ORDER BY created_ms,id LIMIT 1",new String[]{localId,scope})) {
                if(c.moveToFirst()){db.setTransactionSuccessful();return c.getString(0);}
            }
            org.json.JSONArray points=new org.json.JSONArray();String id=UUID.randomUUID().toString();
            try(Cursor c=db.rawQuery("SELECT * FROM samples WHERE device_id=? AND upload_scope=? AND sync_state='pending' ORDER BY received_ms,id LIMIT 200",new String[]{localId,scope})) {
                while(c.moveToNext()) {
                    Sample v=sample(c);
                    org.json.JSONObject j=new org.json.JSONObject().put("id",v.id).put("sessionId",v.sessionId).put("sequence",v.sampleSequence)
                        .put("sampledAt",v.receivedAt).put("receivedAt",v.receivedAt).put("timeSource","phone_received")
                        .put("rawTimestamp",v.deviceLocalTime==null?org.json.JSONObject.NULL:v.deviceLocalTime)
                        .put("source","measured").put("quality",v.quality).put("kind",v.metric).put("value",v.value).put("unit",v.unit);
                    points.put(j);
                    ContentValues update=new ContentValues();update.put("sync_state","sending");update.put("batch_id",id);db.update("samples",update,"id=? AND upload_scope=?",new String[]{v.id,scope});
                }
            }
            if(points.length()==0){db.setTransactionSuccessful();return null;}
            String payload=new org.json.JSONObject().put("batchId",id).put("samples",points).toString();
            ContentValues v=new ContentValues();v.put("id",id);v.put("scope",scope);v.put("local_id",localId);v.put("payload",payload);v.put("created_ms",System.currentTimeMillis());
            db.insertOrThrow("dravet_outbox",null,v);db.setTransactionSuccessful();return payload;
        } finally {db.endTransaction();}
    }
    public synchronized void batchCommitted(String id,String scope) {
        SQLiteDatabase db=getWritableDatabase();db.beginTransaction();
        try {ContentValues v=new ContentValues();v.put("sync_state","uploaded");db.update("samples",v,"batch_id=? AND upload_scope=?",new String[]{id,scope});db.delete("dravet_outbox","id=? AND scope=?",new String[]{id,scope});db.setTransactionSuccessful();}
        finally {db.endTransaction();}
    }
    public synchronized List<org.json.JSONObject> pendingEvents(String scope) throws org.json.JSONException {
        List<org.json.JSONObject> result=new ArrayList<>();
        try(Cursor c=getReadableDatabase().rawQuery("SELECT id,session_id,kind,text,occurred_ms FROM events WHERE upload_scope=? AND uploaded=0 AND kind IN ('observation','alarm_requested','collection_error','connected','disconnected') ORDER BY recorded_ms,id LIMIT 100",new String[]{scope})) {
            while(c.moveToNext())result.add(new org.json.JSONObject().put("id",c.getString(0)).put("sessionId",c.getString(1)).put("kind",c.getString(2))
                .put("occurredAt",Instant.ofEpochMilli(c.getLong(4)).toString()).put("source","measured").put("relatedEventId",org.json.JSONObject.NULL)
                .put("ruleVersion",org.json.JSONObject.NULL).put("note",c.getString(3)));
        }return result;
    }
    public synchronized void eventCommitted(String id,String scope){ContentValues v=new ContentValues();v.put("uploaded",1);getWritableDatabase().update("events",v,"id=? AND upload_scope=?",new String[]{id,scope});}
}
