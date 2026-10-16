import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

class NativeController extends ChangeNotifier {
  static const channel = MethodChannel('rareguard/native');
  static const events = EventChannel('rareguard/events');
  Map<String, dynamic> state = {'state': '服务未启动'};
  String? error;
  bool busy = false;
  StreamSubscription<dynamic>? subscription;
  Future<void> listen() async {
    subscription = events.receiveBroadcastStream().listen(
      (data) {
        state = Map<String, dynamic>.from(data as Map);
        notifyListeners();
      },
      onError: (Object e) {
        error = e.toString();
        notifyListeners();
      },
    );
    await call('state');
  }

  Future<dynamic> call(String method, [Map<String, dynamic>? args]) async {
    try {
      final value = await channel.invokeMethod<dynamic>(method, args);
      if (value is Map && value.containsKey('state')) {
        state = Map<String, dynamic>.from(value);
      }
      notifyListeners();
      return value;
    } on PlatformException catch (e) {
      error = e.message ?? e.code;
      notifyListeners();
      rethrow;
    }
  }

  Future<void> start() async {
    if (await call('permissions') != true) {
      error = '蓝牙权限未授予，请在系统设置中允许后重试';
      notifyListeners();
      return;
    }
    await call('startService');
  }

  Future<void> action(Future<void> Function() run) async {
    if (busy) return;
    busy = true;
    error = null;
    notifyListeners();
    try {
      await run();
    } catch (e) {
      error ??= e.toString();
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  List<Map<String, dynamic>> rows(String key) => (state[key] as List? ?? [])
      .map((e) => Map<String, dynamic>.from(e as Map))
      .toList();
  @override
  void dispose() {
    subscription?.cancel();
    super.dispose();
  }
}
