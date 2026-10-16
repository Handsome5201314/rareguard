package org.rareguard.rareguard;

import android.Manifest;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.*;
import io.flutter.embedding.android.FlutterActivity;
import io.flutter.embedding.engine.FlutterEngine;
import io.flutter.plugin.common.*;
import org.rareguard.app.RingService;
import org.json.JSONObject;
import java.util.*;
import java.util.concurrent.*;

public class MainActivity extends FlutterActivity {
    private final Handler main=new Handler(Looper.getMainLooper());
    private final ExecutorService io=Executors.newSingleThreadExecutor();
    private EventChannel.EventSink events;
    private MethodChannel.Result permissionResult;
    private MethodChannel.Result exportResult;
    private String exportContent;
    private void exportDocument(String content,MethodChannel.Result result){
        if(exportResult!=null){result.error("export_pending","请先完成当前保存操作",null);return;}
        exportContent=content;exportResult=result;
        try{startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType("application/json").putExtra(Intent.EXTRA_TITLE,"RareGuard-records-"+System.currentTimeMillis()+".json"),402);}
        catch(Exception e){exportContent=null;exportResult=null;result.error("export_failed","无法打开系统文件保存器",null);}
    }
    @Override public void onActivityResult(int request,int code,Intent data){
        super.onActivityResult(request,code,data);
        if(request!=402||exportResult==null)return;
        MethodChannel.Result result=exportResult;String content=exportContent;exportResult=null;exportContent=null;
        if(code!=RESULT_OK||data==null||data.getData()==null){result.success(false);return;}
        android.net.Uri target=data.getData();
        io.execute(()->{try(java.io.OutputStream out=getContentResolver().openOutputStream(target,"wt")){
            if(out==null)throw new java.io.IOException("文件不可写");out.write(content.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            main.post(()->result.success(true));
        }catch(Exception e){main.post(()->result.error("export_failed","记录未保存，请换一个可写位置",null));}});
    }
    private boolean permissionGranted(){
        if(Build.VERSION.SDK_INT>=31)return checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN)==PackageManager.PERMISSION_GRANTED&&checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)==PackageManager.PERMISSION_GRANTED;
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED;
    }
    private List<String> missing(){List<String> p=new ArrayList<>();
        if(Build.VERSION.SDK_INT>=31){p.add(Manifest.permission.BLUETOOTH_SCAN);p.add(Manifest.permission.BLUETOOTH_CONNECT);}else p.add(Manifest.permission.ACCESS_FINE_LOCATION);
        if(Build.VERSION.SDK_INT>=33)p.add(Manifest.permission.POST_NOTIFICATIONS);p.removeIf(x->checkSelfPermission(x)==PackageManager.PERMISSION_GRANTED);return p;}
    @Override public void configureFlutterEngine(FlutterEngine engine){
        super.configureFlutterEngine(engine);
        new EventChannel(engine.getDartExecutor().getBinaryMessenger(),"rareguard/events").setStreamHandler(new EventChannel.StreamHandler(){
            public void onListen(Object args,EventChannel.EventSink sink){events=sink;RingService.changed=()->main.post(()->{if(events!=null&&RingService.instance!=null)events.success(RingService.instance.snapshot());});if(RingService.instance!=null)events.success(RingService.instance.snapshot());}
            public void onCancel(Object args){events=null;RingService.changed=null;}
        });
        new MethodChannel(engine.getDartExecutor().getBinaryMessenger(),"rareguard/native").setMethodCallHandler((call,result)->{
            try {
                if(call.method.equals("openUrl")){
                    String raw=call.argument("url");
                    if(raw==null)throw new IllegalArgumentException("网页地址尚未配置");
                    if(!org.rareguard.core.DravetPolicy.allowedWeb(raw)) throw new IllegalArgumentException("请使用已配置的公网 HTTPS 页面");
                    startActivity(new Intent(this,ServiceWebActivity.class).putExtra("url",raw));
                    result.success(true);return;
                }
                if(call.method.equals("permissions")){
                    List<String> p=missing();if(p.isEmpty()){result.success(true);return;}
                    if(permissionResult!=null)throw new IllegalStateException("权限请求仍在进行");permissionResult=result;requestPermissions(p.toArray(new String[0]),401);return;
                }
                if(call.method.equals("startService")){
                    if(!permissionGranted())throw new IllegalStateException("蓝牙权限尚未授予");
                    startForegroundService(new Intent(this,RingService.class));main.postDelayed(()->result.success(RingService.instance==null?null:RingService.instance.snapshot()),500);return;
                }
                if(call.method.equals("state")){result.success(RingService.instance==null?Map.of("state","服务未启动"):RingService.instance.snapshot());return;}
                RingService s=RingService.instance;if(s==null)throw new IllegalStateException("请先授权并启动采集服务");
                switch(call.method){
                    case "scan":s.scan();break;
                    case "connect":s.connect(call.argument("address"),call.argument("name"));break;
                    case "disconnect":s.disconnect(true);break;
                    case "measure":s.startMeasure(call.argument("metric"),call.argument("seconds"));break;
                    case "stop":s.stopMeasurement();break;
                    case "history":s.query(call.argument("metric"));break;
                    case "battery":s.battery();break;
                    case "night":s.night(Boolean.TRUE.equals(call.argument("enabled")));break;
                    case "samples":result.success(s.samples(call.argument("metric"),Boolean.TRUE.equals(call.argument("liveOnly"))));return;
                    case "observe":s.observe(call.argument("text"),((Number)call.argument("when")).longValue());break;
                    case "experiment":s.configure(new JSONObject((Map<?,?>)call.arguments));break;
                    case "disableExperiment":s.disableExperiment();break;
                    case "clearLocal":s.clearLocal();break;
                    case "exportLocal":exportDocument(s.exportLocal(),result);return;
                    case "stopService":s.shutdown();main.postDelayed(()->result.success(Map.of("state","服务已停止")),900);return;
                    case "sync":s.sync();break;
                    case "pair":{String localId=s.beginPairing();String raw=call.argument("package");io.execute(()->{try{Object j=RingService.jsonValue(s.pair(raw,localId));main.post(()->result.success(j));}catch(Exception e){main.post(()->result.error("pair_failed",e instanceof org.json.JSONException?"配对包字段缺失或无效":e.getMessage(),null));}finally{main.post(s::endDataMaintenance);}});return;}
                    default:result.notImplemented();return;
                }result.success(s.snapshot());
            }catch(Exception e){result.error("native_error",e.getMessage(),null);}
        });
    }
    @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] grants){super.onRequestPermissionsResult(code,permissions,grants);if(code==401&&permissionResult!=null){permissionResult.success(permissionGranted());permissionResult=null;}}
    @Override public void onDestroy(){events=null;RingService.changed=null;io.shutdown();super.onDestroy();}
}
