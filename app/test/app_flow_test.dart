import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:rareguard/design.dart';
import 'package:rareguard/home.dart';
import 'package:rareguard/main.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  Map<String, dynamic> state = {};
  final calls = <MethodCall>[];
  Future<dynamic> Function(Map<dynamic, dynamic>)? api;
  setUp(() {
    state = {'state': '服务未启动'};
    calls.clear();
    api = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('rareguard/native'), (
          call,
        ) async {
          calls.add(call);
          if (call.method == 'api') {
            if (api == null) {
              throw PlatformException(code: 'unpaired', message: '请先配对');
            }
            return api!(call.arguments as Map);
          }
          return state;
        });
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('rareguard/events'),
          (call) async => null,
        );
  });
  Future<void> mount(WidgetTester tester) async {
    tester.view.physicalSize = const Size(800, 1300);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(const RareGuardApp());
    await tester.pumpAndSettle();
  }

  Finder vertical() => find
      .byWidgetPredicate(
        (w) => w is Scrollable && w.axisDirection == AxisDirection.down,
      )
      .first;
  Future<void> reach(WidgetTester tester, Finder target) async {
    await tester.scrollUntilVisible(target, 300, scrollable: vertical());
    await tester.pumpAndSettle();
  }

  Future<void> settings(WidgetTester tester) async {
    await tester.tap(find.text('我的'));
    await tester.pumpAndSettle();
    await reach(tester, find.text('服务与隐私'));
    await tester.tap(find.text('服务与隐私'));
    await tester.pumpAndSettle();
  }

  Future<void> experiment(WidgetTester tester) async {
    await settings(tester);
    await reach(tester, find.text('实验变化提醒'));
    await tester.tap(find.text('实验变化提醒'));
    await tester.pumpAndSettle();
  }

  testWidgets(
    'Public endpoint and authenticated web entries remain reachable',
    (tester) async {
      state['serverUrl'] = 'https://rareguard.tongyimoheai.top/api';
      await mount(tester);
      await settings(tester);
      expect(
        tester
            .widget<TextField>(find.widgetWithText(TextField, 'HTTPS 业务入口'))
            .controller!
            .text,
        'https://rareguard.tongyimoheai.top/api',
      );
      await reach(tester, find.text('智能体与远程提醒'));
      await tester.tap(find.text('智能体与远程提醒'));
      await tester.pumpAndSettle();
      await reach(tester, find.text('智能体设置'));
      expect(find.text('智能体设置'), findsOneWidget);
    },
  );
  testWidgets('Saved endpoint takes priority over public default', (
    tester,
  ) async {
    state['serverUrl'] = 'https://family.example/api';
    await mount(tester);
    await settings(tester);
    expect(
      tester
          .widget<TextField>(find.widgetWithText(TextField, 'HTTPS 业务入口'))
          .controller!
          .text,
      'https://family.example/api',
    );
  });
  testWidgets('Connected scan list stays collapsed', (tester) async {
    state = {
      'state': '已连接',
      'devices': List.generate(
        20,
        (i) => {'name': 'device-$i', 'address': '$i', 'rssi': -60},
      ),
    };
    await mount(tester);
    await tester.tap(find.text('我的'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('连接与测量'));
    await tester.pumpAndSettle();
    expect(find.text('device-19'), findsNothing);
    expect(find.text('单次测量与历史'), findsOneWidget);
  });
  testWidgets('Connected device page can reopen after scrolling', (tester) async {
    state = {
      'state': '已连接',
      'devices': [
        {'name': 'test-ring', 'address': 'test-address', 'rssi': -60},
      ],
    };
    await mount(tester);
    await tester.tap(find.text('我的'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('连接与测量'));
    await tester.pumpAndSettle();
    await reach(tester, find.text('最近收到的设备记录'));
    await tester.tap(find.text('我的'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('连接与测量'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await reach(tester, find.text('附近设备（1）'));
    expect(find.text('附近设备（1）'), findsOneWidget);
  });
  testWidgets('Experiment can be disabled with blank numeric fields', (
    tester,
  ) async {
    await mount(tester);
    await experiment(tester);
    await reach(tester, find.text('立即关闭本机实验提醒'));
    await tester.tap(find.text('立即关闭本机实验提醒'));
    await tester.pumpAndSettle();
    expect(calls.map((c) => c.method), contains('disableExperiment'));
    expect(find.textContaining('FormatException'), findsNothing);
  });
  testWidgets('Persisted experiment parameters are shown', (tester) async {
    state['experiment'] = {
      'enabled': true,
      'hr_high': 110,
      'duration_seconds': 90,
      'max_gap_seconds': 80,
      'required_signals': 1,
      'allow_unknown_quality': true,
    };
    await mount(tester);
    await experiment(tester);
    await reach(tester, find.text('启用实验规则'));
    expect(
      tester
          .widget<SwitchListTile>(find.widgetWithText(SwitchListTile, '启用实验规则'))
          .value,
      isTrue,
    );
    await reach(tester, find.widgetWithText(TextField, '心率高于（bpm，可空）'));
    expect(
      tester
          .widget<TextField>(find.widgetWithText(TextField, '心率高于（bpm，可空）'))
          .controller!
          .text,
      '110',
    );
  });
  testWidgets('Empty night never becomes a safety conclusion', (tester) async {
    await mount(tester);
    expect(find.text('还没有即时数据。先连接戒指，再选择一项测量。'), findsOneWidget);
    await reach(tester, find.textContaining('不能作为安全结论'));
    expect(find.textContaining('不能作为安全结论'), findsOneWidget);
    expect(find.text('整夜平稳'), findsNothing);
  });
  testWidgets('Medical thresholds start blank and experiment disabled', (
    tester,
  ) async {
    await mount(tester);
    await experiment(tester);
    await reach(tester, find.text('启用实验规则'));
    expect(
      tester
          .widget<SwitchListTile>(find.widgetWithText(SwitchListTile, '启用实验规则'))
          .value,
      isFalse,
    );
    await reach(tester, find.widgetWithText(TextField, '心率低于（bpm，可空）'));
    expect(
      tester
          .widget<TextField>(find.widgetWithText(TextField, '心率低于（bpm，可空）'))
          .controller!
          .text,
      isEmpty,
    );
  });
  Map<String, dynamic> sample(
    String metric,
    num value, {
    String source = 'live_device',
    String quality = 'unknown',
  }) => {
    'metric': metric,
    'value': value,
    'unit': metric == 'hr' ? 'bpm' : '%',
    'quality': quality,
    'source': source,
    'receivedMs': DateTime.now().millisecondsSinceEpoch,
  };
  testWidgets('History cannot overwrite latest live home reading', (
    tester,
  ) async {
    state['latest'] = [sample('hr', 199, source: 'device_history')];
    state['latestLive'] = [
      sample('hr', 72),
      sample('spo2', 98, source: 'device_history'),
    ];
    await mount(tester);
    expect(find.text('72'), findsOneWidget);
    expect(find.text('199'), findsNothing);
    expect(find.text('98'), findsNothing);
    expect(find.text('信号质量未知'), findsOneWidget);
  });
  testWidgets('Invalid measurement is not presented as a numeric reading', (
    tester,
  ) async {
    state['latestLive'] = [sample('hr', 199, quality: 'invalid')];
    await mount(tester);
    expect(find.text('199'), findsNothing);
    expect(find.text('质量无效'), findsOneWidget);
  });
  testWidgets(
    'Disconnected and night collection disable competing measurements',
    (tester) async {
      await mount(tester);
      expect(
        tester
            .widget<OutlinedButton>(find.widgetWithText(OutlinedButton, '测心率'))
            .onPressed,
        isNull,
      );
      await tester.pumpWidget(const SizedBox());
      state = {'state': '已连接', 'night': true};
      await mount(tester);
      expect(
        tester
            .widget<OutlinedButton>(find.widgetWithText(OutlinedButton, '测心率'))
            .onPressed,
        isNull,
      );
    },
  );
  testWidgets('Home measurement calls native contract with bounded duration', (
    tester,
  ) async {
    state['state'] = '已连接';
    await mount(tester);
    await tester.tap(find.text('测心率'));
    await tester.pumpAndSettle();
    final measure = calls.singleWhere((c) => c.method == 'measure');
    expect(measure.arguments, {'metric': 'hr', 'seconds': 60});
  });
  testWidgets('Observation filtering excludes device events', (tester) async {
    state['events'] = [
      {
        'kind': 'observation',
        'text': 'test observation',
        'occurredMs': 1000,
        'recordedMs': 2000,
      },
      {
        'kind': 'connection',
        'text': 'test connection',
        'occurredMs': 3000,
        'recordedMs': 3000,
      },
    ];
    await mount(tester);
    await tester.tap(find.text('记录'));
    await tester.pumpAndSettle();
    expect(find.text('test connection'), findsOneWidget);
    await tester.tap(find.widgetWithText(FilterChip, '家长观察'));
    await tester.pumpAndSettle();
    expect(find.text('test observation'), findsOneWidget);
    expect(find.text('test connection'), findsNothing);
  });
  testWidgets('Saving factual observation retains native timestamp contract', (
    tester,
  ) async {
    state['deviceId'] = 'test-device';
    await mount(tester);
    await tester.tap(find.text('记录'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('添加观察'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, '观察 / 处置备注'),
      'test observation',
    );
    await reach(tester, find.text('保存观察'));
    await tester.tap(find.text('保存观察'));
    await tester.pumpAndSettle();
    final observe = calls.singleWhere((c) => c.method == 'observe');
    expect(observe.arguments['text'], 'test observation');
    expect(observe.arguments['when'], isA<int>());
    expect(calls.map((c) => c.method), contains('sync'));
    expect(find.widgetWithText(TextField, '观察 / 处置备注'), findsNothing);
  });
  testWidgets('Window changes clear previous server summary', (tester) async {
    api = (args) async {
      final path = args['path'] as String;
      if (path == '/v1/me') {
        return {
          'devices': [
            {'id': 'test-device'},
          ],
        };
      }
      if (path.startsWith('/v1/summaries/night')) {
        return {'status': 'no_data', 'metrics': {}};
      }
      if (path.startsWith('/v1/measurements')) {
        return {'data': [], 'next_cursor': null};
      }
      throw StateError('Unexpected API path');
    };
    await mount(tester);
    await reach(tester, find.text('查看夜间报告'));
    await tester.tap(find.text('查看夜间报告'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('生成数据摘要'));
    await tester.pumpAndSettle();
    expect(find.text('该窗口无数据'), findsOneWidget);
    await tester.tap(find.text('最近 12 小时'));
    await tester.pumpAndSettle();
    expect(find.text('该窗口无数据'), findsNothing);
    expect(find.text('尚未生成摘要'), findsOneWidget);
  });
  testWidgets('Window change during AI poll ignores stale result', (
    tester,
  ) async {
    final pending = Completer<Map<String, dynamic>>();
    api = (args) async {
      final path = args['path'] as String;
      if (path == '/v1/me') {
        return {
          'devices': [
            {'id': 'test-device'},
          ],
          'consents': {'ai_analysis': true},
        };
      }
      if (path == '/v1/conversations') return {'id': 'test-conversation'};
      if (path.endsWith('/messages')) {
        return {'request_id': 'test-request', 'status': 'running'};
      }
      if (path.startsWith('/v1/ai-requests/')) return pending.future;
      throw StateError('Unexpected API path');
    };
    await mount(tester);
    await tester.tap(find.text('助手'));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextField, '你的问题'),
      'test question',
    );
    await tester.tap(find.text('提交问答'));
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 3));
    await tester.tap(find.text('最近 12 小时'));
    await tester.pumpAndSettle();
    pending.complete({'status': 'completed', 'answer': 'stale test answer'});
    await tester.pumpAndSettle();
    expect(find.text('stale test answer'), findsNothing);
    expect(find.text('本次问答'), findsNothing);
  });
  for (final width in [320.0, 800.0]) {
    testWidgets('All destinations render at width $width with large text', (
      tester,
    ) async {
      tester.view.physicalSize = Size(width, 1300);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          theme: rareGuardTheme(),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(1.3)),
            child: child!,
          ),
          home: const Home(),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        width < 720 ? find.byType(NavigationBar) : find.byType(NavigationRail),
        findsOneWidget,
      );
      for (final label in ['记录', '助手', '我的', '今夜']) {
        await tester.tap(find.text(label));
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
      }
    });
  }
}
