part of 'home.dart';

mixin _ServicePages on State<Home> {
  _HomeState get h => this as _HomeState;
  List<Widget> alertWidgets() => [
    h.message('本机实验提醒仍可用。病程服务目前记录事件，不提供跨手机推送或远程确认送达。'),
  ];

  Future<void> openWeb(String url) => h.c.call('openUrl', {'url': url});

  List<Widget> report() {
    final rows = h.reportRows;
    final valid = rows.where((r) => r['quality'] != 'invalid').toList();
    final events = h.c.rows('events').where((e) {
      final kind = e['kind'];
      return kind == 'alarm_requested' || kind == 'collection_error';
    }).toList();
    final now = DateTime.now().millisecondsSinceEpoch;
    final gaps = <int>[];
    for (var i = 1; i < valid.length; i++) {
      gaps.add(
        ((valid[i]['receivedMs'] as num).toInt() -
                (valid[i - 1]['receivedMs'] as num).toInt()) ~/
            60000,
      );
    }
    gaps.sort();
    final largestGap = gaps.isEmpty ? null : gaps.last;
    final unit = rows.isEmpty ? '' : '${rows.first['unit']}';
    final keys = const ['hr', 'spo2', 'temp', 'bp_sys', 'glu', 'stress', 'hrv'];
    return [
      PageTitle(
        '夜间数据',
        '先看窗口和摘要，再展开明细。只显示本机实际收到的即时记录。',
        trailing: IconButton(
          tooltip: '刷新当前窗口',
          onPressed: h.reportLoading ? null : () => h.run(h.loadReport),
          icon: const Icon(Icons.refresh),
        ),
      ),
      h.message('空窗、断线和没有提醒都不会被解释为整夜平稳；本页用于观察与复盘。'),
      SurfacePanel(
        child: Builder(
          builder: (context) => Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
            Text('浏览条件', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 12),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final key in keys)
                  ChoiceChip(
                    label: Text(names[key] ?? key),
                    selected: h.reportMetric == key,
                    onSelected: (_) => h.changeReportFilter(metric: key),
                  ),
              ],
            ),
            const SizedBox(height: 12),
            DropdownButtonFormField<int>(
              initialValue: h.reportWindowHours,
              decoration: const InputDecoration(labelText: '时间窗口'),
              items: const [
                DropdownMenuItem(value: 6, child: Text('最近 6 小时')),
                DropdownMenuItem(value: 12, child: Text('最近 12 小时')),
                DropdownMenuItem(value: 24, child: Text('最近 24 小时')),
              ],
              onChanged: (value) {
                if (value != null) h.changeReportFilter(hours: value);
              },
            ),
            const SizedBox(height: 12),
            Text(
              '窗口：${h.stamp(now - h.reportWindowHours * 60 * 60 * 1000)} 至今 · ${names[h.reportMetric] ?? h.reportMetric}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            ],
          ),
        ),
      ),
      if (h.reportError != null)
        h.message('读取本机夜间记录失败：${h.reportError}', warning: true),
      if (h.reportLoading)
        const Padding(
          padding: EdgeInsets.symmetric(vertical: 20),
          child: LinearProgressIndicator(semanticsLabel: '正在读取夜间记录'),
        ),
      SurfacePanel(
        child: Wrap(
          spacing: 24,
          runSpacing: 18,
          children: [
            _reportStat('有效采样', '${valid.length} 条'),
            _reportStat('最近读数', valid.isEmpty ? '暂无' : '${h.numText(valid.last['value'])} $unit'),
            _reportStat('最大空窗', largestGap == null ? '暂无' : '$largestGap 分钟'),
            _reportStat('提醒/错误', '${events.length} 条'),
          ],
        ),
      ),
      if (rows.isEmpty && !h.reportLoading)
        h.empty(
          '这个窗口还没有即时点',
          '请确认戒指已连接并开始采集；历史记录不会被填入夜间即时图。',
          action: h.button('重新读取', () => h.run(h.loadReport), icon: Icons.refresh),
        )
      else if (rows.isNotEmpty) ...[
        h.heading('趋势', detail: '点之间按实际接收时间绘制；空窗不会被连成连续曲线。'),
        SurfacePanel(
          padding: const EdgeInsets.fromLTRB(8, 18, 8, 8),
          child: SizedBox(
            height: 240,
            child: Semantics(
              label: '${names[h.reportMetric] ?? h.reportMetric}夜间趋势图，共 ${rows.length} 条记录',
              child: CustomPaint(
                painter: TrendPainter(
                  rows,
                  windowStart: now - h.reportWindowHours * 60 * 60 * 1000,
                  windowEnd: now,
                ),
                child: const SizedBox.expand(),
              ),
            ),
          ),
        ),
        ExpansionTile(
          tilePadding: EdgeInsets.zero,
          title: Text('查看明细（${rows.length} 条）'),
          subtitle: Text('最近一条：${h.reportAge(rows.last['receivedMs'])}'),
          children: [
            for (final row in rows.reversed)
              Builder(
                builder: (context) => ListTile(
                  contentPadding: EdgeInsets.zero,
                  leading: Icon(
                    row['quality'] == 'invalid'
                        ? Icons.error_outline
                        : Icons.radio_button_checked,
                    color: row['quality'] == 'invalid'
                        ? Theme.of(context).colorScheme.error
                        : Theme.of(context).colorScheme.primary,
                  ),
                  title: Text('${h.numText(row['value'])} ${row['unit']}'),
                  subtitle: Text(
                    '${h.stamp(row['receivedMs'])} · ${row['quality'] == 'invalid' ? '无效' : '质量未知'} · ${row['source'] == 'live_device' ? '即时' : '非即时'}',
                  ),
                ),
              ),
          ],
        ),
      ],
      const SizedBox(height: 18),
      h.button(
        '打开病程监测报告',
        () => h.run(() => openWeb(publicConsoleUrl)),
        icon: Icons.open_in_browser,
      ),
      h.message('网页版用于核对已上传数据和患者时间窗；本页用于快速查看手机本地采集。'),
    ];
  }

  Widget _reportStat(String label, String value) => SizedBox(
    width: 142,
    child: Builder(
      builder: (context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: Theme.of(context).textTheme.bodySmall),
          const SizedBox(height: 4),
          Text(value, style: Theme.of(context).textTheme.titleLarge),
        ],
      ),
    ),
  );

  List<Widget> assistant() => [
    const PageTitle('家庭助手', '使用 Octop 管理 Dravet 项目助手与会话。'),
    h.button(
      '打开 Octop 助手',
      () => h.run(() => openWeb(publicOctopUrl)),
      icon: Icons.smart_toy_outlined,
    ),
    h.heading('首次连接'),
    const Text(
      '在病程监测页选择患者并创建独立的智能体只读授权，将智能体连接包交给 Octop 的 Dravet 项目助手。手机上传配对包不能用于智能体。',
    ),
    const SizedBox(height: 16),
    h.button(
      '打开病程授权管理',
      () => h.run(() => openWeb(publicConsoleUrl)),
      icon: Icons.manage_accounts_outlined,
    ),
    h.message('网页在应用内分别登录，不传递手机上传凭据。AI 回答用于整理记录，不自动发布诊断或实验规则。'),
  ];

  List<Widget> settings() {
    final c = h.c;
    return [
      const PageTitle('服务与隐私', '本机采集保留；手机上传和智能体只读授权分别管理。'),
      settingsGroup('公网配对与授权', '病程监测页生成的 5 分钟一次性手机配对包', [
        h.button(
          '打开病程设备管理',
          () => h.run(() => openWeb(publicConsoleUrl)),
          icon: Icons.manage_accounts_outlined,
        ),
        const SizedBox(height: 16),
        TextField(
          key: const PageStorageKey('field-pair-package'),
          controller: h.pairingPackage,
          obscureText: !h.showPairingPackage,
          minLines: h.showPairingPackage ? 4 : 1,
          maxLines: h.showPairingPackage ? 8 : 1,
          enableSuggestions: false,
          autocorrect: false,
          decoration: const InputDecoration(
            labelText: '粘贴手机配对包 JSON',
            helperText: '必须是病程页生成的 6 字段 JSON；尾逗号、智能体连接包和截图文字都会被拒绝。',
          ),
        ),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton.icon(
            onPressed: () => setState(() => h.showPairingPackage = !h.showPairingPackage),
            icon: Icon(h.showPairingPackage ? Icons.visibility_off : Icons.visibility),
            label: Text(h.showPairingPackage ? '隐藏配对包' : '显示配对包'),
          ),
        ),
        const SizedBox(height: 16),
        h.button(
          '配对或续期手机上传',
          () => h.run(() async {
            final raw = h.pairingPackage.text.trim();
            if (raw.isEmpty) throw const FormatException('请先粘贴病程页生成的手机配对包');
            try {
              final decoded = jsonDecode(raw);
              if (decoded is! Map<String, dynamic>) {
                throw const FormatException('配对包必须是 JSON 对象');
              }
            } on FormatException catch (e) {
              throw FormatException('配对包 JSON 格式错误：${e.message}');
            }
            final pairedResult = await c.call('pair', {'package': raw});
            await c.call('state');
            final paired = c.state['paired'] == true ||
                (pairedResult is Map && pairedResult['paired'] == true);
            if (!paired) {
              throw StateError('服务端未确认手机上传配对，请检查授权是否过期或已使用');
            }
            h.pairingPackage.clear();
          }),
          icon: Icons.link,
        ),
        Text('病程手机上传：${c.state['paired'] == true ? '已配对' : '未配对'}'),
        h.message('病程手机上传授权与 Octop 智能体只读授权是两套独立凭据；完成其中一项不会替另一项授权。'),
        if (c.state['paired'] == true) ...[
          SelectableText('患者 ID：${c.state['patientId']}'),
          SelectableText('设备 ID：${c.state['serverDeviceId']}'),
          Text('授权到期：${c.state['expiresAt']}'),
          h.button('立即同步', () => h.run(() => c.call('sync')), icon: Icons.sync),
        ],
        if ((c.state['legacyPending'] as num? ?? 0) > 0)
          h.message('旧版待传记录保留在本机，不会自动归入新患者。可导出核对。'),
        h.message(
          '配对后仅上传绑定戒指产生的有效即时指标和观察、提醒事件；当前 EFE 已解析的血压、皮温、血糖、压力、HRV 与 PI 也会按原始单位上传。历史、无效值和未核对的三轴帧留在本机。同一患者及设备可续期；换绑需先导出记录、在网页撤销旧授权，再清除应用数据。',
        ),
      ], expanded: true),
      settingsGroup('智能体与病程管理', '应用内网页 · Octop 与家长账号分别登录', [
        h.button(
          '打开 Octop 助手',
          () => h.run(() => openWeb(publicOctopUrl)),
          icon: Icons.smart_toy_outlined,
        ),
        h.button(
          '打开病程授权管理',
          () => h.run(() => openWeb(publicConsoleUrl)),
          icon: Icons.manage_accounts_outlined,
        ),
        h.message('Android Keystore 加密保存手机配对凭据。Octop 的智能体只读凭据单独在其配置中管理。'),
        h.message(
          '本机提醒依赖采集服务与系统通知权限。服务器记录事件不表示其他手机收到提醒；当前没有远程推送验收结果。',
          warning: true,
        ),
      ]),
      settingsGroup('实验变化提醒', '默认关闭 · 不预填医学数值 · 质量未知', [
        OutlinedButton.icon(
          onPressed: () => h.run(() async {
            await c.call('disableExperiment');
            setState(() => h.experiment = false);
          }),
          icon: const Icon(Icons.stop_circle_outlined),
          label: const Text('立即关闭本机实验提醒'),
        ),
        SwitchListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('启用实验规则'),
          value: h.experiment,
          onChanged: (v) => setState(() => h.experiment = v),
        ),
        Wrap(
          spacing: 16,
          runSpacing: 16,
          children: [
            numeric(h.low, '心率低于（bpm，可空）'),
            numeric(h.high, '心率高于（bpm，可空）'),
            numeric(h.oxygen, '血氧低于（%，可空）'),
            numeric(h.duration, '持续时长（30–3600 秒）'),
            numeric(h.gap, '允许间隔（1–300 秒）'),
          ],
        ),
        const SizedBox(height: 16),
        DropdownButtonFormField<int>(
          initialValue: h.signals,
          decoration: const InputDecoration(labelText: '同时满足的信号数量'),
          items: const [
            DropdownMenuItem(value: 1, child: Text('1 个信号')),
            DropdownMenuItem(value: 2, child: Text('2 个信号')),
          ],
          onChanged: (v) => setState(() => h.signals = v!),
        ),
        CheckboxListTile(
          contentPadding: EdgeInsets.zero,
          title: const Text('我理解质量未知，同意其仅用于实验提醒'),
          value: h.unknown,
          onChanged: (v) => setState(() => h.unknown = v!),
        ),
        h.button(
          '确认并应用实验规则',
          () => h.run(saveExperiment),
          icon: Icons.check_circle_outline,
        ),
        Text(
          '当前设备规则：${c.state['experimentEnabled'] == true ? '实验模式启用' : '关闭'}',
        ),
        h.message(
          '缺失、无效或历史数据中断持续计时；查看确认不终止变化证据。两个信号的最大间隔需要覆盖实际交替采样间隔，否则不会形成连续证据。',
        ),
      ]),
      settingsGroup('权限与数据管理', '通知状态、导出、删除与停止服务', [
        Text(
          '通知权限：${c.state['notificationsEnabled'] == true ? '已允许' : '未允许，请到系统设置开启'}',
        ),
        Text(
          '观察提醒通知通道：${c.state['alertChannelEnabled'] == true ? '已允许' : '未允许，请到系统设置开启'}',
        ),
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [
            h.button(
              '导出本机记录',
              () => h.run(() async {
                await c.call('exportLocal');
              }),
              icon: Icons.download,
            ),
            OutlinedButton(
              onPressed: () => h.run(() async {
                if (!await confirmDelete(
                  '删除本机记录',
                  '将删除本机样本、观察与待上传队列，服务器副本仍保留。请先停止测量、断开戒指，并按需要导出。',
                )) {
                  return;
                }
                await c.call('clearLocal');
                h.trend = [];
              }),
              child: const Text('删除本机记录'),
            ),
            h.button(
              '服务器数据与授权管理',
              () => h.run(() => openWeb(publicConsoleUrl)),
              icon: Icons.manage_accounts_outlined,
            ),
            OutlinedButton(
              onPressed: () => h.run(() async {
                await c.call('stopService');
              }),
              child: const Text('停止服务与连接'),
            ),
          ],
        ),
      ]),
      settingsGroup('兼容性与版本', 'RareGuard 0.3.0 · Flutter 安卓 APK', [
        const Text(
          'Flutter 安卓 APK · MR11 EFE 协议\n华为 Mate 70 Pro+ / 卓易通：官方 App 已能连接戒指；RareGuard 的权限、锁屏采集与提醒仍待该手机实测。',
        ),
      ]),
    ];
  }

  Widget settingsGroup(
    String title,
    String detail,
    List<Widget> children, {
    bool expanded = false,
  }) => ExpansionTile(
    key: PageStorageKey('settings-$title'),
    initiallyExpanded: expanded,
    tilePadding: const EdgeInsets.symmetric(vertical: 8),
    childrenPadding: const EdgeInsets.only(top: 12, bottom: 24),
    title: Text(title),
    subtitle: Text(detail),
    expandedCrossAxisAlignment: CrossAxisAlignment.start,
    children: children,
  );

  Widget numeric(TextEditingController t, String label) => SizedBox(
    width: 260,
    child: TextField(
      key: PageStorageKey('field-$label'),
      controller: t,
      keyboardType: const TextInputType.numberWithOptions(decimal: true),
      decoration: InputDecoration(labelText: label),
    ),
  );
  Future<void> saveExperiment() async {
    if (!h.experiment) {
      await h.c.call('disableExperiment');
      return;
    }
    double? number(TextEditingController t) {
      if (t.text.trim().isEmpty) return null;
      final v = double.tryParse(t.text);
      if (v == null || !v.isFinite) throw FormatException('请检查 ${t.text}');
      return v;
    }

    final p = {
      'enabled': h.experiment,
      'hr_low': number(h.low),
      'hr_high': number(h.high),
      'spo2_low': number(h.oxygen),
      'duration_seconds': int.parse(h.duration.text),
      'max_gap_seconds': int.parse(h.gap.text),
      'required_signals': h.signals,
      'allow_unknown_quality': h.unknown,
    };
    if (h.experiment && !h.unknown) throw const FormatException('请先确认未知质量实验边界');
    await h.c.call('experiment', p);
  }

  Future<bool> confirmDelete(String title, String text) async =>
      await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(title),
          content: Text(text),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('确认删除'),
            ),
          ],
        ),
      ) ??
      false;
}
