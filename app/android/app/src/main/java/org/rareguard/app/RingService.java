package org.rareguard.app;

import android.app.*;
import android.bluetooth.*;
import android.bluetooth.le.*;
import android.content.*;
import android.os.*;
import org.rareguard.core.*;
import org.json.*;
import java.util.*;
import java.util.concurrent.*;

/** One GATT operation at a time; notifications enabled before reviewed writes. */
public final class RingService extends Service {
    public static RingService instance;
    public static Runnable changed;
    private final Handler main=new Handler(Looper.getMainLooper());
    private final ExecutorService network=Executors.newSingleThreadExecutor();
    private LocalStore store;
    private RemoteApi api;
    private BluetoothAdapter adapter;
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic writer;
    private final ArrayDeque<byte[]> writes=new ArrayDeque<>();
    private final LinkedHashMap<String,Map<String,Object>> found=new LinkedHashMap<>();
    private final MeasurementWindow measurement=new MeasurementWindow();
    private final ChangeRule rule=new ChangeRule();
    private boolean writing,scanning,night,networkBusy,dataMaintenance;
    private int generation,writeSerial,battery=-1,retries;
    private long lastLive,sessionStarted;
    private String state="未连接",error="",deviceId,address,name="",firmware="",operation="",syncState="未配对",remoteError="";
    private JSONArray remoteAlerts=new JSONArray();

    @Override public void onCreate(){
        super.onCreate();instance=this;store=new LocalStore(this);api=new RemoteApi(this);
        adapter=getSystemService(BluetoothManager.class).getAdapter();
        NotificationManager nm=getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("monitor","采集状态",NotificationManager.IMPORTANCE_LOW));
        nm.createNotificationChannel(new NotificationChannel("alerts","观察提醒",NotificationManager.IMPORTANCE_HIGH));
        startForeground(10,notification("服务已启动，请连接戒指","monitor"));
        String config=getSharedPreferences("state",0).getString("experiment",null);
        if(config!=null){try{configure(new JSONObject(config));}catch(JSONException|IllegalArgumentException e){error="保存的实验规则无效，请重新设置";}}
        main.postDelayed(tick,1000);
    }
    @Override public int onStartCommand(Intent intent,int flags,int startId){return START_NOT_STICKY;}
    @Override public IBinder onBind(Intent intent){return null;}
    @Override public void onDestroy(){
        night=false;main.removeCallbacksAndMessages(null);if(gatt!=null){gatt.disconnect();gatt.close();}network.shutdown();store.close();instance=null;super.onDestroy();
    }
    private Notification notification(String text,String channel){
        Intent intent=getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent p=PendingIntent.getActivity(this,0,intent,PendingIntent.FLAG_IMMUTABLE|PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this,channel).setSmallIcon(android.R.drawable.ic_menu_info_details).setContentTitle("RareGuard 夜间观察").setContentText(text).setContentIntent(p).setAutoCancel(!channel.equals("monitor")).build();
    }
    private void emit(){if(changed!=null)changed.run();}
    private void failure(String message){error=message;emit();}
    public void scan(){
        if(adapter==null||!adapter.isEnabled())throw new IllegalStateException("请先开启蓝牙");
        if(scanning)return;found.clear();scanning=true;error="";emit();
        adapter.getBluetoothLeScanner().startScan(null,new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),scanCallback);
        main.postDelayed(this::stopScan,12000);
    }
    private void stopScan(){if(scanning){if(adapter!=null&&adapter.isEnabled())adapter.getBluetoothLeScanner().stopScan(scanCallback);scanning=false;emit();}}
    private final ScanCallback scanCallback=new ScanCallback(){
        @Override public void onScanResult(int type,ScanResult result){main.post(()->{
            String n=result.getScanRecord()==null?null:result.getScanRecord().getDeviceName();
            if(n==null)n=result.getDevice().getName();if(n==null)n="未命名 BLE 设备";
            Map<String,Object> row=new HashMap<>();row.put("address",result.getDevice().getAddress());row.put("name",n);row.put("rssi",result.getRssi());
            found.put(result.getDevice().getAddress(),row);emit();
        });}
        @Override public void onScanFailed(int code){main.post(()->{scanning=false;failure("扫描失败，代码 "+code+"；请检查蓝牙权限或重开蓝牙");});}
    };
    public void connect(String target,String label){
        stopScan();disconnect(false);address=target;name=label;deviceId=store.device(target,label);
        error="";state="连接中";battery=-1;firmware="";lastLive=0;emit();
        final int gen=++generation;
        gatt=adapter.getRemoteDevice(target).connectGatt(this,false,new BluetoothGattCallback(){
            private void run(Runnable r){main.post(()->{if(gen==generation)r.run();});}
            @Override public void onConnectionStateChange(BluetoothGatt g,int status,int newState){run(()->{
                if(status==BluetoothGatt.GATT_SUCCESS&&newState==BluetoothProfile.STATE_CONNECTED){state="发现服务";emit();if(!g.discoverServices())failure("发现服务请求失败");}
                else if(newState==BluetoothProfile.STATE_DISCONNECTED||status!=0){lost("蓝牙已断开（"+status+"）");}
            });}
            @Override public void onServicesDiscovered(BluetoothGatt g,int status){run(()->{
                BluetoothGattService s=g.getService(UUID.fromString(EfeProtocol.SERVICE));
                if(status!=0||s==null){lost("设备未提供 MR11 EFE 服务，请确认所选戒指");return;}
                writer=s.getCharacteristic(UUID.fromString(EfeProtocol.WRITE));BluetoothGattCharacteristic n=s.getCharacteristic(UUID.fromString(EfeProtocol.NOTIFY));
                if(writer==null||n==null||!g.setCharacteristicNotification(n,true)){lost("启用通知失败");return;}
                BluetoothGattDescriptor d=n.getDescriptor(UUID.fromString("00002902-0000-1000-8000-00805f9b34fb"));
                if(d==null){lost("通知描述符缺失");return;}
                state="订阅数据";emit();
                if(Build.VERSION.SDK_INT>=33){if(g.writeDescriptor(d,BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)!=BluetoothStatusCodes.SUCCESS)lost("通知订阅请求失败");}
                else {d.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);if(!g.writeDescriptor(d))lost("通知订阅请求失败");}
            });}
            @Override public void onDescriptorWrite(BluetoothGatt g,BluetoothGattDescriptor d,int status){run(()->{
                if(status!=0){lost("通知订阅失败（"+status+"）");return;}
                state="已连接";error="";retries=0;enqueue(EfeProtocol.info());enqueue(EfeProtocol.battery());emit();
                if(night)main.postDelayed(()->startMeasure("hr",60),1200);
            });}
            @Override public void onCharacteristicWrite(BluetoothGatt g,BluetoothGattCharacteristic c,int status){run(()->{
                writing=false;if(status!=0){writes.clear();failure("命令写入失败（"+status+"）");return;}pump();
            });}
            @Override public void onCharacteristicChanged(BluetoothGatt g,BluetoothGattCharacteristic c,byte[] value){byte[] raw=value.clone();run(()->receive(raw));}
            @Override public void onCharacteristicChanged(BluetoothGatt g,BluetoothGattCharacteristic c){if(Build.VERSION.SDK_INT<33){byte[] raw=c.getValue().clone();run(()->receive(raw));}}
        },BluetoothDevice.TRANSPORT_LE);
        main.postDelayed(()->{if(gen==generation&&!state.equals("已连接"))lost("连接或订阅超时，请确认其他 App 已断开戒指");},20000);
    }
    private void lost(String reason){
        if(measurement.isActive())finishMeasurement(false);rule.reset();writer=null;writes.clear();writing=false;
        if(gatt!=null){gatt.close();gatt=null;}generation++;state="已断开";failure(reason);
        if(night){store.event(deviceId,"data_gap",reason,System.currentTimeMillis());alert("data_gap",reason);
            if(retries++<3){String a=address,n=name;main.postDelayed(()->{if(night&&gatt==null)connect(a,n);},10000L*retries);}
        }
    }
    public void disconnect(boolean user){
        if(user&&measurement.isActive()){night=false;stopMeasurement();main.postDelayed(()->disconnect(false),500);return;}
        if(user)night=false;
        if(gatt!=null){gatt.disconnect();gatt.close();gatt=null;}generation++;writer=null;writing=false;writes.clear();state="未连接";rule.reset();emit();
    }
    private void enqueue(byte[] command){writes.add(command);pump();}
    private void pump(){
        if(writing||writes.isEmpty()||gatt==null||writer==null)return;
        byte[] bytes=writes.poll();writing=true;int gen=generation,serial=++writeSerial;
        int type=(writer.getProperties()&BluetoothGattCharacteristic.PROPERTY_WRITE)!=0?BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT:BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE;
        boolean ok;
        if(Build.VERSION.SDK_INT>=33)ok=gatt.writeCharacteristic(writer,bytes,type)==BluetoothStatusCodes.SUCCESS;
        else{writer.setWriteType(type);writer.setValue(bytes);ok=gatt.writeCharacteristic(writer);}
        if(!ok){writing=false;failure("蓝牙忙或命令未写入");return;}
        main.postDelayed(()->{if(gen==generation&&serial==writeSerial&&writing)lost("蓝牙命令应答超时");},8000);
    }
    private EfeProtocol.Metric metric(String key){for(EfeProtocol.Metric m:EfeProtocol.Metric.values())if(m.key.equals(key))return m;throw new IllegalArgumentException("不支持该指标；ECG 尚未确认协议");}
    public void startMeasure(String key,int seconds){
        if(!state.equals("已连接"))throw new IllegalStateException("请先连接戒指");if(measurement.isActive())throw new IllegalStateException("请先停止当前测量");
        if(seconds<5||seconds>90)throw new IllegalArgumentException("测量窗口须为 5–90 秒");
        EfeProtocol.Metric m=metric(key);measurement.start(m,SystemClock.elapsedRealtime(),seconds*1000L);operation=m.label+"测量中";
        enqueue(EfeProtocol.measure(m));emit();main.postDelayed(()->{if(measurement.isActive()&&SystemClock.elapsedRealtime()>=measurement.deadline())finishMeasurement(true);},seconds*1000L);
    }
    private void finishMeasurement(boolean sendStop){
        if(!measurement.isActive())return;String key=measurement.metric().key;String label=measurement.metric().label;int n=measurement.finish();
        if(sendStop&&gatt!=null)enqueue(EfeProtocol.stop());operation=label+"："+(n==0?"本次未收到有效即时数据":n+" 条即时数据");emit();
        if(night){main.postDelayed(()->{if(night&&state.equals("已连接")&&!measurement.isActive())startMeasure(key.equals("hr")?"spo2":"hr",60);},3000);}
    }
    public void stopMeasurement(){night=false;finishMeasurement(true);emit();}
    public void shutdown(){
        if(networkBusy)throw new IllegalStateException("同步正在进行，请稍后停止服务");
        stopScan();stopMeasurement();disconnect(true);
        main.removeCallbacks(tick);main.postDelayed(this::stopSelf,700);
    }
    public void disableExperiment(){
        rule.enabled=false;rule.reset();
        try {String saved=getSharedPreferences("state",0).getString("experiment",null);
            if(saved!=null)getSharedPreferences("state",0).edit().putString("experiment",new JSONObject(saved).put("enabled",false).toString()).apply();
        }catch(JSONException e){throw new IllegalStateException("已关闭本机规则，但保存配置失败",e);}
        emit();
    }
    public void clearLocal(){
        if(networkBusy||night||measurement.isActive()||gatt!=null)throw new IllegalStateException("请先停止测量并断开戒指，等待同步结束后再删除");
        store.clearHealthData();lastLive=0;rule.reset();remoteAlerts=new JSONArray();emit();
    }
    public String exportLocal() throws JSONException {
        JSONArray rows=new JSONArray();for(LocalStore.Sample row:store.allSamples())rows.put(new JSONObject(sampleMap(row)));
        JSONArray observations=new JSONArray();for(LocalStore.Event e:store.allEvents())observations.put(new JSONObject().put("id",e.id).put("kind",e.kind).put("text",e.text).put("occurredMs",e.occurredMs).put("recordedMs",e.recordedMs));
        return new JSONObject().put("schema_version",1).put("exported_at",java.time.Instant.now().toString()).put("samples",rows).put("events",observations).toString(2);
    }
    public void query(String key){if(!state.equals("已连接"))throw new IllegalStateException("请先连接戒指");if(measurement.isActive())throw new IllegalStateException("请先停止测量再读历史");enqueue(EfeProtocol.command(metric(key).opcode,1));operation="读取"+metric(key).label+"历史；设备本地时间未校准";emit();}
    public void battery(){if(!state.equals("已连接"))throw new IllegalStateException("请先连接戒指");enqueue(EfeProtocol.battery());}
    public void night(boolean enabled){
        if(enabled){if(!state.equals("已连接"))throw new IllegalStateException("请先连接戒指");if(measurement.isActive())throw new IllegalStateException("请先停止单次测量");
            sessionStarted=System.currentTimeMillis();night=true;store.event(deviceId,"session","开始实验采集：心率与血氧交替，各 60 秒",sessionStarted);startMeasure("hr",60);
        }else{night=false;finishMeasurement(true);if(deviceId!=null)store.event(deviceId,"session","结束采集",System.currentTimeMillis());}emit();
    }
    private void receive(byte[] raw){
        EfeProtocol.Frame f=EfeProtocol.decode(raw);
        if(f.battery>=0)battery=f.battery;if(f.firmware!=null){firmware=f.firmware;store.firmware(deviceId,firmware);}
        if(f.kind.equals("health")&&!f.values.isEmpty()){
            store.save(deviceId,f,raw,System.currentTimeMillis());measurement.accept(f,SystemClock.elapsedRealtime());
            for(EfeProtocol.Value v:f.values){
                if(f.live&&v.value!=0)lastLive=System.currentTimeMillis();
                if(rule.feed(v.metric,v.value,f.source,v.value==0?"invalid":"unknown",SystemClock.elapsedRealtime()))alert("experimental_change","已达到你设置的实验边界与持续时间；请结合实际状态观察");
            }
        }
        if(f.error)failure("戒指返回状态 "+f.status+"；未确认测量成功");
        if(f.stopType!=null&&f.stopError!=null&&f.stopError!=0)failure(EfeProtocol.measurementStopMessage(f.stopType,f.stopError));
        emit();
    }
    public void configure(JSONObject p) throws JSONException {
        double low=p.optDouble("hr_low",Double.NaN),high=p.optDouble("hr_high",Double.NaN),spo=p.optDouble("spo2_low",Double.NaN);
        int duration=p.getInt("duration_seconds"),gap=p.getInt("max_gap_seconds"),required=p.getInt("required_signals");
        boolean enabled=p.getBoolean("enabled"),unknown=p.getBoolean("allow_unknown_quality");
        if(duration<30||duration>3600||gap<1||gap>300||(required!=1&&required!=2))throw new IllegalArgumentException("时长、数据间隔或信号数量不符合实验边界");
        if((!Double.isNaN(low)&&(low<1||low>255))||(!Double.isNaN(high)&&(high<1||high>255))||(!Double.isNaN(spo)&&(spo<1||spo>100))||(!Double.isNaN(low)&&!Double.isNaN(high)&&low>=high))throw new IllegalArgumentException("请检查填写的边界");
        int count=(!Double.isNaN(low)||!Double.isNaN(high)?1:0)+(!Double.isNaN(spo)?1:0);
        if(enabled&&(!unknown||count<required))throw new IllegalArgumentException("须明确同意未知质量，并填写足够信号边界");
        rule.hrLow=Double.isNaN(low)?null:low;rule.hrHigh=Double.isNaN(high)?null:high;rule.spo2Low=Double.isNaN(spo)?null:spo;
        rule.durationSeconds=duration;rule.maxGapSeconds=gap;rule.requiredSignals=required;rule.allowUnknown=unknown;rule.enabled=enabled;rule.reset();
        getSharedPreferences("state",0).edit().putString("experiment",p.toString()).apply();emit();
    }
    private void alert(String kind,String text){
        getSystemService(NotificationManager.class).notify((int)(System.currentTimeMillis()%100000),notification(text,"alerts"));
        if(deviceId==null)return;
        try {String sid=store.serverId(deviceId);JSONObject j=new JSONObject().put("id",UUID.randomUUID().toString()).put("kind",kind).put("text",text).put("evidence",new JSONObject().put("quality","unknown").put("last_live_received_ms",lastLive));
            if(sid!=null)j.put("device_id",sid);store.queueAlert(j);
        }catch(JSONException e){failure("提醒记录构造失败");}
    }
    public void remoteTest(){alert("delivery_test","跨网络提醒测试；请在另一台设备确认收到");sync();}
    public void sync(){
        if(networkBusy||dataMaintenance)return;networkBusy=true;syncState="同步中";emit();
        String local=deviceId;network.execute(()->{
            try {
                JSONObject me=api.request("GET","/v1/me",null);JSONObject consents=me.getJSONObject("consents");
                if(local!=null&&consents.optBoolean("upload")){
                    String sid=store.serverId(local);
                    if(sid==null){JSONObject d=api.request("POST","/v1/devices",new JSONObject().put("local_id",local).put("model",name).put("firmware_version",firmware).put("protocol_version",EfeProtocol.VERSION));sid=d.getString("device_id");store.bindServer(local,sid);}
                    String payload=store.createBatch(local,sid);
                    if(payload!=null){JSONObject p=new JSONObject(payload),result=api.request("POST","/v1/measurement-batches",p);
                        if(!result.optString("status").equals("committed")||!result.optString("batch_id").equals(p.getString("batch_id")))throw new IllegalStateException("服务端未确认该批次持久化");store.batchCommitted(p.getString("batch_id"));}
                    for(JSONObject o:store.observations(local,sid)){api.request("POST","/v1/observations",o);store.observationCommitted(o.getString("id"));}
                }
                if(consents.optBoolean("remote_alerts")){
                    for(JSONObject j:store.pendingAlerts()){if(!j.has("device_id")&&local!=null){String sid=store.serverId(local);if(sid!=null)j.put("device_id",sid);}if(!j.has("device_id"))continue;
                        api.request("POST","/v1/alerts",j);store.alertCommitted(j.getString("id"));}
                    JSONArray rows=api.request("GET","/v1/alerts",null).getJSONArray("data");
                    for(int i=0;i<rows.length();i++){JSONObject row=rows.getJSONObject(i);if(row.isNull("received_at")){
                        getSystemService(NotificationManager.class).notify(row.getString("id").hashCode(),notification(row.getString("text"),"alerts"));
                        api.request("POST","/v1/alerts/"+row.getString("id")+"/receipt",new JSONObject().put("status","received"));}}
                    main.post(()->remoteAlerts=rows);
                }
                main.post(()->{syncState="已同步 · "+store.pendingCount()+" 条待上传";remoteError="";});
            }catch(Exception e){main.post(()->{syncState="同步未完成";remoteError=safeError(e);});}
            finally{main.post(()->{networkBusy=false;emit();});}
        });
    }
    private static String safeError(Exception e){return e.getMessage()==null?e.getClass().getSimpleName():e.getMessage();}
    private int tickCount;
    private boolean gapNotified;
    private final Runnable tick=new Runnable(){public void run(){
        rule.tick(SystemClock.elapsedRealtime());
        if(night){getSystemService(NotificationManager.class).notify(10,notification(state+" · "+operation,"monitor"));
            long reference=lastLive==0?sessionStarted:lastLive;boolean gap=System.currentTimeMillis()-reference>120000;
            if(gap&&!gapNotified){gapNotified=true;alert("data_gap","超过两分钟未收到即时数据；请检查佩戴、蓝牙与采集状态");}
            if(!gap)gapNotified=false;
        }
        if(++tickCount%15==0&&!api.url().isEmpty())sync();emit();main.postDelayed(this,1000);
    }};
    public Map<String,Object> snapshot(){
        Map<String,Object> s=new HashMap<>();s.put("state",state);s.put("error",error);s.put("deviceId",deviceId);s.put("name",name);s.put("firmware",firmware);
        s.put("battery",battery);s.put("scanning",scanning);s.put("devices",new ArrayList<>(found.values()));s.put("measuring",measurement.isActive());s.put("operation",operation);
        s.put("night",night);s.put("lastLive",lastLive);s.put("pending",store.pendingCount());s.put("syncState",syncState);s.put("remoteError",remoteError);s.put("serverUrl",api.url());
        s.put("experimentEnabled",rule.enabled);s.put("alerts",jsonValue(remoteAlerts));
        s.put("serverDeviceId",deviceId==null?null:store.serverId(deviceId));
        String saved=getSharedPreferences("state",0).getString("experiment",null);
        if(saved!=null){try{s.put("experiment",jsonValue(new JSONObject(saved)));}catch(JSONException e){s.put("error","保存的实验规则无法读取，请重新设置");}}
        NotificationManager nm=getSystemService(NotificationManager.class);
        s.put("notificationsEnabled",nm.areNotificationsEnabled());
        s.put("alertChannelEnabled",nm.getNotificationChannel("alerts").getImportance()!=NotificationManager.IMPORTANCE_NONE);
        List<Map<String,Object>> samples=new ArrayList<>(),liveSamples=new ArrayList<>();if(deviceId!=null)for(String key:new String[]{"hr","spo2","bp_sys","bp_dia","temp","glu","stress","hrv"}){
            LocalStore.Sample row=store.latest(deviceId,key,false);if(row!=null)samples.add(sampleMap(row));
            LocalStore.Sample live=store.latest(deviceId,key,true);if(live!=null)liveSamples.add(sampleMap(live));}
        s.put("latest",samples);s.put("latestLive",liveSamples);
        List<Map<String,Object>> events=new ArrayList<>();for(LocalStore.Event e:store.events(deviceId,100)){Map<String,Object> row=new HashMap<>();row.put("id",e.id);row.put("kind",e.kind);row.put("text",e.text);row.put("occurredMs",e.occurredMs);row.put("recordedMs",e.recordedMs);events.add(row);}s.put("events",events);return s;
    }
    public List<Map<String,Object>> samples(String key,boolean liveOnly){List<Map<String,Object>> result=new ArrayList<>();for(LocalStore.Sample r:store.samples(deviceId,key,System.currentTimeMillis()-24*3600000L,Long.MAX_VALUE,liveOnly,500))result.add(sampleMap(r));return result;}
    private static Map<String,Object> sampleMap(LocalStore.Sample r){Map<String,Object> v=new HashMap<>();v.put("id",r.id);v.put("metric",r.metric);v.put("value",r.value);v.put("unit",r.unit);v.put("source",r.source);v.put("quality",r.quality);v.put("receivedMs",r.receivedMs);v.put("deviceLocalTime",r.deviceLocalTime);v.put("syncState",r.syncState);return v;}
    public void observe(String text,long when){store.event(deviceId,"observation",text,when);emit();}
    public RemoteApi api(){return api;}
    public void beginDataMaintenance(){
        if(networkBusy||night||measurement.isActive()||dataMaintenance)throw new IllegalStateException("请先结束采集并等待同步完成，再删除服务器记录");
        dataMaintenance=true;
    }
    public void endDataMaintenance(){dataMaintenance=false;emit();}
    public static Object jsonValue(Object o){
        if(o==null||o==JSONObject.NULL)return null;
        if(o instanceof JSONObject){Map<String,Object> m=new HashMap<>();Iterator<String> keys=((JSONObject)o).keys();while(keys.hasNext()){String key=keys.next();m.put(key,jsonValue(((JSONObject)o).opt(key)));}return m;}
        if(o instanceof JSONArray){List<Object> list=new ArrayList<>();for(int i=0;i<((JSONArray)o).length();i++)list.add(jsonValue(((JSONArray)o).opt(i)));return list;}return o;
    }
}
