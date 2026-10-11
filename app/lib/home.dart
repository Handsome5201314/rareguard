import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import 'design.dart';
import 'native_controller.dart';
part 'collection_pages.dart';
part 'service_pages.dart';

const publicBusinessUrl = 'https://rareguard.tongyimoheai.top/api';
const publicHermesUrl =
    'https://rareguard.tongyimoheai.top/hermes/?profile=dravet-night';
const publicConsoleUrl = 'https://rareguard.tongyimoheai.top/console';
const names = {
  'hr': '心率',
  'spo2': '血氧',
  'bp': '血压',
  'bp_sys': '收缩压',
  'bp_dia': '舒张压',
  'temp': '皮温',
  'glu': '血糖',
  'stress': '厂商压力值',
  'hrv': '厂商 HRV 值',
};

class Home extends StatefulWidget {
  const Home({super.key});
  @override
  State<Home> createState() => _HomeState();
}

class _HomeState extends State<Home> with _CollectionPages, _ServicePages {
  final c = NativeController();
  int page = 0;
  String? detailPage;
  String eventFilter = 'all';
  bool observationOpen = false;
  String metric = 'hr';
  List<Map<String, dynamic>> trend = [];
  List<Map<String, dynamic>> reportPoints = [];
  bool reportTruncated = false;
  Map<String, dynamic>? me, summary, ai;
  DateTime from = DateTime.now().subtract(const Duration(hours: 12)),
      to = DateTime.now(),
      occurred = DateTime.now();
  final url = TextEditingController(text: publicBusinessUrl),
      code = TextEditingController(),
      note = TextEditingController(),
      question = TextEditingController();
  final low = TextEditingController(),
      high = TextEditingController(),
      oxygen = TextEditingController(),
      duration = TextEditingController(),
      gap = TextEditingController();
  bool unknown = false,
      experiment = false,
      experimentLoaded = false,
      serverUrlLoaded = false;
  int signals = 1;
  Timer? aiPoll;
  String? aiQuestion;
  int windowRevision = 0;
  @override
  void initState() {
    super.initState();
    c.addListener(refresh);
    unawaited(c.listen());
  }

  void refresh() {
    final savedUrl = c.state['serverUrl'] as String?;
    if (!serverUrlLoaded && savedUrl != null && savedUrl.isNotEmpty) {
      serverUrlLoaded = true;
      if (url.text == publicBusinessUrl) url.text = savedUrl;
    }
    final p = c.state['experiment'] as Map?;
    if (!experimentLoaded && p != null) {
      experimentLoaded = true;
      experiment = p['enabled'] == true;
      unknown = p['allow_unknown_quality'] == true;
      signals = (p['required_signals'] as num?)?.toInt() ?? 1;
      low.text = p['hr_low']?.toString() ?? '';
      high.text = p['hr_high']?.toString() ?? '';
      oxygen.text = p['spo2_low']?.toString() ?? '';
      duration.text = p['duration_seconds']?.toString() ?? '';
      gap.text = p['max_gap_seconds']?.toString() ?? '';
    }
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    aiPoll?.cancel();
    c.removeListener(refresh);
    c.dispose();
    for (final t in [
      url,
      code,
      note,
      question,
      low,
      high,
      oxygen,
      duration,
      gap,
    ]) {
      t.dispose();
    }
    super.dispose();
  }

  void run(Future<void> Function() f) {
    unawaited(c.action(f));
  }

  Future<void> loadMe() async {
    me = await c.api('/v1/me');
    if (mounted) setState(() {});
  }

  String? get serverDevice {
    final d = me?['devices'] as List?;
    final local = c.state['serverDeviceId'] as String?;
    if (d == null || d.isEmpty) return null;
    if (local != null && d.any((r) => r['id'] == local)) return local;
    return (d.first as Map)['id'] as String?;
  }

  String stamp(dynamic ms) {
    if (ms == null || ms == 0) return '暂无';
    final d = DateTime.fromMillisecondsSinceEpoch((ms as num).toInt());
    return '${d.month}/${d.day} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}:${d.second.toString().padLeft(2, '0')}';
  }

  String isoStamp(String s) {
    final d = DateTime.tryParse(s)?.toLocal();
    return d == null ? s : stamp(d.millisecondsSinceEpoch);
  }

  String numText(dynamic v) => (v as num).toDouble().toStringAsFixed(
    (v.toDouble() % 1).abs() < 0.001 ? 0 : 1,
  );
  void openDetail(String route) => setState(() => detailPage = route);
  void selectPage(int index) => setState(() {
    page = index;
    detailPage = null;
  });
  void openObservation() => setState(() {
    page = 1;
    detailPage = null;
    observationOpen = true;
    occurred = DateTime.now();
  });
  void updateWindow(DateTime start, DateTime end) => setState(() {
    windowRevision++;
    from = start;
    to = end;
    summary = null;
    reportPoints = [];
    reportTruncated = false;
    ai = null;
    aiQuestion = null;
    aiPoll?.cancel();
  });
  String age(dynamic ms) {
    if (ms == null || ms == 0) return '尚未收到';
    final seconds = math.max(
      0,
      (DateTime.now().millisecondsSinceEpoch - (ms as num)) ~/ 1000,
    );
    if (seconds < 60) return '$seconds 秒前';
    if (seconds < 3600) return '${seconds ~/ 60} 分钟前';
    if (seconds < 86400) return '${seconds ~/ 3600} 小时前';
    return '${seconds ~/ 86400} 天前';
  }

  Widget heading(String text, {String? detail}) => Builder(
    builder: (context) => Padding(
      padding: const EdgeInsets.only(top: 28, bottom: 14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(text, style: Theme.of(context).textTheme.headlineSmall),
          if (detail != null)
            Padding(
              padding: const EdgeInsets.only(top: 8),
              child: Text(detail),
            ),
        ],
      ),
    ),
  );
  Widget empty(String title, String text, {Widget? action}) => Builder(
    builder: (context) => Padding(
      padding: const EdgeInsets.symmetric(vertical: 28),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 10),
          Text(text),
          if (action != null)
            Padding(padding: const EdgeInsets.only(top: 16), child: action),
        ],
      ),
    ),
  );
  Widget button(String label, VoidCallback? onPressed, {IconData? icon}) =>
      FilledButton.tonalIcon(
        onPressed: c.busy ? null : onPressed,
        icon: Icon(icon ?? Icons.arrow_forward),
        label: Text(label),
      );
  Widget message(String text, {bool warning = false}) => Builder(
    builder: (context) => Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      margin: const EdgeInsets.symmetric(vertical: 10),
      decoration: BoxDecoration(
        color: warning
            ? Theme.of(context).colorScheme.errorContainer
            : Theme.of(context).colorScheme.surfaceContainer,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: warning
              ? Theme.of(context).colorScheme.onErrorContainer
              : Theme.of(context).colorScheme.onSurface,
        ),
      ),
    ),
  );
  Future<DateTime?> pick(DateTime value) async {
    final day = await showDatePicker(
      context: context,
      initialDate: value,
      firstDate: DateTime(2020),
      lastDate: DateTime.now(),
    );
    if (day == null || !mounted) return null;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(value),
    );
    if (time == null) return null;
    return DateTime(day.year, day.month, day.day, time.hour, time.minute);
  }

  @override
  Widget build(BuildContext context) {
    final labels = ['今夜', '记录', '助手', '我的'];
    final icons = [
      Icons.nights_stay_outlined,
      Icons.edit_note,
      Icons.chat_bubble_outline,
      Icons.person_outline,
    ];
    final theme = rareGuardTheme(light: detailPage == 'report');
    return Theme(
      data: theme,
      child: Builder(
        builder: (context) => LayoutBuilder(
          builder: (context, size) {
            final wide = size.maxWidth >= 720;
            final children = switch (detailPage) {
              'device' => device(),
              'settings' => settings(),
              'report' => report(),
              'motion' => motionInfo(),
              _ => switch (page) {
                0 => overview(),
                1 => timeline(),
                2 => assistant(),
                _ => account(),
              },
            };
            final title = switch (detailPage) {
              'device' => '戒指与采集',
              'settings' => '服务与隐私',
              'report' => '夜间报告',
              'motion' => '运动数据',
              _ => 'RareGuard',
            };
            final body = SafeArea(
              top: false,
              child: Align(
                alignment: Alignment.topCenter,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 900),
                  child: ListView(
                    key: PageStorageKey('page-$page-$detailPage'),
                    padding: EdgeInsets.fromLTRB(
                      wide ? 32 : 20,
                      8,
                      wide ? 32 : 20,
                      36,
                    ),
                    children: [
                      if (c.busy)
                        const LinearProgressIndicator(semanticsLabel: '正在处理'),
                      if (c.error != null)
                        MaterialBanner(
                          content: Text(c.error!),
                          actions: [
                            TextButton(
                              onPressed: () => setState(() => c.error = null),
                              child: const Text('关闭'),
                            ),
                          ],
                        ),
                      if (c.state['error']?.toString().isNotEmpty == true)
                        message('${c.state['error']}', warning: true),
                      ...children,
                    ],
                  ),
                ),
              ),
            );
            return PopScope(
              canPop: detailPage == null && page == 0,
              onPopInvokedWithResult: (didPop, result) {
                if (!didPop) {
                  setState(() {
                    if (detailPage != null) {
                      detailPage = null;
                    } else {
                      page = 0;
                    }
                  });
                }
              },
              child: Scaffold(
                appBar: AppBar(
                  leading: detailPage == null
                      ? null
                      : IconButton(
                          tooltip: '返回',
                          icon: const Icon(Icons.arrow_back),
                          onPressed: () => setState(() => detailPage = null),
                        ),
                  title: Text(title),
                  actions: [
                    Padding(
                      padding: const EdgeInsets.only(right: 16),
                      child: Center(
                        child: Text(
                          c.state['night'] == true ? '采集中' : '家庭夜间观察',
                          style: TextStyle(
                            color: Theme.of(context).colorScheme.primary,
                            fontSize: 12,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
                body: wide
                    ? Row(
                        children: [
                          NavigationRail(
                            selectedIndex: page,
                            labelType: NavigationRailLabelType.all,
                            onDestinationSelected: selectPage,
                            destinations: List.generate(
                              4,
                              (i) => NavigationRailDestination(
                                icon: Icon(icons[i]),
                                label: Text(labels[i]),
                              ),
                            ),
                          ),
                          const VerticalDivider(width: 1),
                          Expanded(child: body),
                        ],
                      )
                    : body,
                bottomNavigationBar: wide || detailPage != null
                    ? null
                    : NavigationBar(
                        selectedIndex: page,
                        onDestinationSelected: selectPage,
                        destinations: List.generate(
                          4,
                          (i) => NavigationDestination(
                            icon: Icon(icons[i]),
                            label: labels[i],
                          ),
                        ),
                      ),
              ),
            );
          },
        ),
      ),
    );
  }
}

class TrendPainter extends CustomPainter {
  final List<Map<String, dynamic>> points;
  final Color color, ink;
  final int? windowStart, windowEnd;
  TrendPainter(
    this.points, {
    this.color = teal,
    this.ink = mutedInk,
    this.windowStart,
    this.windowEnd,
  });
  @override
  void paint(Canvas canvas, Size size) {
    if (points.isEmpty) return;
    final ordered = [...points]
      ..sort(
        (a, b) => (a['receivedMs'] as num).compareTo(b['receivedMs'] as num),
      );
    final usable = ordered.where((p) => p['quality'] != 'invalid').toList();
    if (usable.isEmpty) return;
    final first =
            windowStart?.toDouble() ??
            (ordered.first['receivedMs'] as num).toDouble(),
        last =
            windowEnd?.toDouble() ??
            (ordered.last['receivedMs'] as num).toDouble();
    final values = usable.map((p) => (p['value'] as num).toDouble());
    final min = values.reduce(math.min), max = values.reduce(math.max);
    final range = math.max(1.0, max - min);
    Offset position(Map<String, dynamic> p) => Offset(
      12 +
          ((p['receivedMs'] as num) - first) /
              math.max(1, last - first) *
              (size.width - 24),
      12 + (max - (p['value'] as num)) / range * (size.height - 44),
    );
    final paint = Paint()
      ..color = color
      ..strokeWidth = 2;
    for (final p in ordered) {
      if (p['quality'] == 'invalid') {
        continue;
      }
      final at = position(p);
      canvas.drawCircle(at, 3, paint);
    }
    final text = TextPainter(
      text: TextSpan(
        text:
            '${min.toStringAsFixed(1)} — ${max.toStringAsFixed(1)} ${points.first['unit']}',
        style: TextStyle(color: ink, fontSize: 13),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    text.paint(canvas, Offset(12, size.height - 22));
  }

  @override
  bool shouldRepaint(TrendPainter old) =>
      old.points != points ||
      old.color != color ||
      old.ink != ink ||
      old.windowStart != windowStart ||
      old.windowEnd != windowEnd;
}
