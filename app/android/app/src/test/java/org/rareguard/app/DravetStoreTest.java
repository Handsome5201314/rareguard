package org.rareguard.app;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.rareguard.core.EfeProtocol;
import static org.junit.Assert.*;

/** Uses a disposable Android SQLite database, never the installed app or production API. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk=28, manifest=Config.NONE)
public class DravetStoreTest {
    private Context context;
    private LocalStore store;
    private String local;
    private final String scope="11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
    @Before public void setUp(){context=RuntimeEnvironment.getApplication();context.deleteDatabase("rareguard.db");store=new LocalStore(context);local=store.device("TEST_RING","Test fixture");}
    @After public void tearDown(){store.close();context.deleteDatabase("rareguard.db");}
    private void save(int opcode,int subtype,int value){byte[] raw=new byte[20];raw[0]=(byte)opcode;raw[1]=(byte)subtype;raw[3]=1;raw[5]=1;raw[6]=0x26;raw[7]=0x10;raw[8]=0x15;raw[12]=(byte)value;store.save(local,EfeProtocol.decode(raw),raw,1792022400000L);}
    private JSONObject batch() throws Exception{return new JSONObject(store.createBatch(local,scope));}
    @Test public void historyAndInvalidRemainLocalWhileValidScalarUploads() throws Exception {
        save(10,3,72);store.bindDravet(scope,local);save(10,1,73);save(10,3,0);save(0x40,3,1);
        JSONObject batch = new JSONObject(store.createBatch(local,scope));
        assertEquals(1,batch.getJSONArray("samples").length());
        assertEquals("temp",batch.getJSONArray("samples").getJSONObject(0).getString("kind"));
        assertEquals(4,store.allSamples().size());assertEquals(1,store.pendingCount());
    }
    @Test public void sampleMappingPreservesTimeQualityAndStableSequence() throws Exception {
        store.bindDravet(scope,local);save(10,3,72);save(0x12,3,98);
        JSONArray points=batch().getJSONArray("samples");assertEquals(2,points.length());
        JSONObject hr=null;for(int i=0;i<points.length();i++)if(points.getJSONObject(i).getString("kind").equals("hr"))hr=points.getJSONObject(i);
        assertNotNull(hr);assertEquals("measured",hr.getString("source"));assertEquals("unknown",hr.getString("quality"));assertEquals("phone_received",hr.getString("timeSource"));
        assertEquals(hr.getString("receivedAt"),hr.getString("sampledAt"));assertEquals("bpm",hr.getString("unit"));assertEquals(72,hr.getInt("value"));
        assertNotEquals(points.getJSONObject(0).getLong("sequence"),points.getJSONObject(1).getLong("sequence"));
        assertEquals(points.getJSONObject(0).getString("sessionId"),points.getJSONObject(1).getString("sessionId"));
    }
    @Test public void retryAndRestartReuseIdenticalPayloadUntilCommit() throws Exception {
        store.bindDravet(scope,local);save(10,3,72);String first=store.createBatch(local,scope);save(10,3,73);
        assertEquals(first,store.createBatch(local,scope));store.close();store=new LocalStore(context);store.bindDravet(scope,local);
        assertEquals(first,store.createBatch(local,scope));String id=new JSONObject(first).getString("batchId");
        store.batchCommitted(id,scope);assertEquals(1,store.pendingCount());assertNotEquals(id,batch().getString("batchId"));
    }
    @Test public void renewedBindingKeepsQueueAndChangedPatientOrRingIsRejected() throws Exception {
        store.bindDravet(scope,local);save(10,3,72);String first=store.createBatch(local,scope);store.bindDravet(scope,local);assertEquals(first,store.createBatch(local,scope));
        try{store.bindDravet("different-patient",local);fail("changed patient accepted");}catch(IllegalArgumentException expected){}
        String other=store.device("OTHER_RING","Other fixture");try{store.bindDravet(scope,other);fail("changed ring accepted");}catch(IllegalArgumentException expected){}
        assertNull(store.createBatch(local,"different-patient"));assertEquals(first,store.createBatch(local,scope));
    }
    @Test public void anotherRingAndUnpairedObservationsCannotLeak() throws Exception {
        store.event(local,"observation","Before pairing",1792022400000L);store.bindDravet(scope,local);
        String first=local;local=store.device("OTHER_RING","Other fixture");save(10,3,90);store.event(local,"observation","Other ring",1792022400000L);
        assertNull(store.createBatch(local,scope));assertTrue(store.pendingEvents(scope).isEmpty());local=first;
        store.event(local,"observation","After pairing",1792022400000L);JSONObject e=store.pendingEvents(scope).get(0);
        assertEquals("After pairing",e.getString("note"));assertTrue(e.isNull("relatedEventId"));assertEquals("measured",e.getString("source"));
        store.eventCommitted(e.getString("id"),"wrong-scope");assertEquals(1,store.pendingEvents(scope).size());store.eventCommitted(e.getString("id"),scope);assertTrue(store.pendingEvents(scope).isEmpty());
    }
    @Test public void wrongScopeCannotCommitSamples() throws Exception {
        store.bindDravet(scope,local);save(10,3,72);JSONObject first=batch();store.batchCommitted(first.getString("batchId"),"wrong-scope");
        assertEquals(1,store.pendingCount());assertEquals(first.toString(),batch().toString());
    }
    @Test public void deletingHealthDataClearsNewQueueWithoutRemovingBinding() throws Exception {
        store.bindDravet(scope,local);save(10,3,72);batch();store.event(local,"observation","Test",1792022400000L);store.clearHealthData();
        assertNull(store.createBatch(local,scope));assertTrue(store.pendingEvents(scope).isEmpty());save(10,3,73);assertEquals(1,batch().getJSONArray("samples").length());
    }
    @Test public void migratingV2PreservesLegacyDataWithoutAssigningNewPatient() throws Exception {
        store.close();context.deleteDatabase("rareguard.db");SQLiteDatabase old=context.openOrCreateDatabase("rareguard.db",0,null);
        old.execSQL("CREATE TABLE devices (id TEXT PRIMARY KEY,address TEXT UNIQUE,name TEXT,firmware TEXT,server_id TEXT)");
        old.execSQL("CREATE TABLE samples (id TEXT PRIMARY KEY,device_id TEXT,metric TEXT,value REAL,unit TEXT,source TEXT,quality TEXT,observed_at TEXT,received_at TEXT,received_ms INTEGER,device_local_time TEXT,vendor_sequence INTEGER,decoder_version TEXT,raw_hex TEXT,sync_state TEXT,batch_id TEXT)");
        old.execSQL("CREATE TABLE events (id TEXT PRIMARY KEY,device_id TEXT,kind TEXT,text TEXT,occurred_ms INTEGER,recorded_ms INTEGER,uploaded INTEGER DEFAULT 0)");
        old.execSQL("CREATE TABLE outbox (id TEXT PRIMARY KEY,device_id TEXT,payload TEXT,status TEXT,error TEXT,created_ms INTEGER)");old.execSQL("CREATE TABLE alert_outbox (id TEXT PRIMARY KEY,payload TEXT)");
        old.execSQL("INSERT INTO devices VALUES('old-ring','OLD_MAC','Old fixture',NULL,'old-server')");
        old.execSQL("INSERT INTO samples VALUES('old-sample','old-ring','hr',72,'bpm','live_device','unknown','2026-10-15T00:00:00Z','2026-10-15T00:00:00Z',1792022400000,NULL,1,'v1','00','sending','old-batch')");
        old.execSQL("INSERT INTO outbox VALUES('old-batch','old-ring','legacy-payload','pending',NULL,1)");old.setVersion(2);old.close();
        store=new LocalStore(context);store.bindDravet(scope,"old-ring");assertEquals(1,store.legacyPending());assertEquals(0,store.pendingCount());assertNull(store.createBatch("old-ring",scope));assertEquals(1,store.allSamples().size());
        try(Cursor c=store.getReadableDatabase().rawQuery("SELECT payload FROM outbox",null)){assertTrue(c.moveToFirst());assertEquals("legacy-payload",c.getString(0));}
    }
    @Test public void wrongPackageRejectedBeforeAnyNetworkRequest() throws Exception {
        RemoteApi api=new RemoteApi(context,store);
        for(String input:new String[]{"not json","{}","{\"kind\":\"dravet-monitor-connection\",\"version\":1}"}){
            try{api.pair(input,local);fail("invalid package accepted");}catch(IllegalArgumentException expected){}
        }
        assertFalse(api.paired());assertFalse(api.status().has("token"));
    }
}
