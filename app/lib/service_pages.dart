part of 'home.dart';

mixin _ServicePages on State<Home> {
  _HomeState get h => this as _HomeState;
  List<Widget> alertWidgets() => h.c
      .rows('alerts')
      .map(
        (r) => Padding(
          padding: const EdgeInsets.symmetric(vertical: 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(r['text'], style: Theme.of(context).textTheme.titleMedium),
              Text(
                '服务端 ${h.isoStamp(r['created_at'])} · ${r['confirmed_at'] == null ? '尚未确认' : '已确认'}',
              ),
              Wrap(
                spacing: 12,
                children: [
                  h.button(
                    '我已查看',
                    r['confirmed_at'] != null
                        ? null
                        : () => h.run(() async {
                            final note = await confirmationNote();
                            if (note == null) return;
                            await h.c.api(
                              '/v1/alerts/${r['id']}/receipt',
                              method: 'POST',
                              body: {'status': 'confirmed', 'note': note},
                            );
                            await h.c.call('sync');
                          }),
                    icon: Icons.check,
                  ),
                  OutlinedButton(
                    onPressed: () => h.run(() async {
                      final data = await h.c.api(
                        '/v1/alerts/${r['id']}/deliveries',
                      );
                      if (mounted) {
                        await showDialog<void>(
                          context: context,
                          builder: (context) => AlertDialog(
                            title: const Text('各监护人回执'),
                            content: SingleChildScrollView(
                              child: Text(
                                (data['data'] as List)
                                    .map(
                                      (e) =>
                                          '${e['guardian_id']}\n收到：${e['received_at'] ?? '未收到'}\n确认：${e['confirmed_at'] ?? '未确认'}\n备注：${e['note'] ?? '无'}',
                                    )
                                    .join('\n\n'),
                              ),
                            ),
                            actions: [
                              TextButton(
                                onPressed: () => Navigator.pop(context),
                                child: const Text('关闭'),
                              ),
                            ],
                          ),
                        );
                      }
                    }),
                    child: const Text('查看回执'),
                  ),
                ],
              ),
            ],
          ),
        ),
      )
      .toList();
  String windowPath(String route) {
    if (h.serverDevice == null) throw const FormatException('请先配对并同步设备');
    if (!h.from.isBefore(h.to)) throw const FormatException('开始时间须早于结束时间');
    return '$route?device_id=${h.serverDevice}&from=${Uri.encodeComponent(h.from.toUtc().toIso8601String())}&to=${Uri.encodeComponent(h.to.toUtc().toIso8601String())}&timezone=Asia%2FShanghai';
  }

  Widget windowPicker() => SurfacePanel(
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('分析时间窗口'),
        const SizedBox(height: 12),
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [
            OutlinedButton(
              onPressed: h.c.busy
                  ? null
                  : () => h.run(() async {
                      final d = await h.pick(h.from);
                      if (d != null) h.updateWindow(d, h.to);
                    }),
              child: Text('从 ${h.stamp(h.from.millisecondsSinceEpoch)}'),
            ),
            OutlinedButton(
              onPressed: h.c.busy
                  ? null
                  : () => h.run(() async {
                      final d = await h.pick(h.to);
                      if (d != null) h.updateWindow(h.from, d);
                    }),
              child: Text('到 ${h.stamp(h.to.millisecondsSinceEpoch)}'),
            ),
            TextButton(
              onPressed: h.c.busy
                  ? null
                  : () {
                      final now = DateTime.now();
                      h.updateWindow(
                        now.subtract(const Duration(hours: 12)),
                        now,
                      );
                    },
              child: const Text('最近 12 小时'),
            ),
          ],
        ),
        const SizedBox(height: 8),
        const Text('统计时区 Asia/Shanghai · 时间选择器按手机本地时间'),
      ],
    ),
  );

  Future<void> loadSummary() async {
    await h.loadMe();
    if (!mounted) return;
    final summaryPath = windowPath('/v1/summaries/night');
    setState(() {
      h.summary = null;
      h.reportPoints = [];
      h.reportTruncated = false;
    });
    final result = await h.c.api(summaryPath);
    final records = await h.c.api(
      '${windowPath('/v1/measurements')}&limit=500',
    );
    final points = (records['data'] as List).map((r) {
      final point = Map<String, dynamic>.from(r as Map);
      final time = DateTime.tryParse(point['observed_at'] as String);
      if (time == null) throw const FormatException('服务器记录时间无法解析，请检查服务端');
      point['receivedMs'] = time.millisecondsSinceEpoch;
      return point;
    }).toList();
    if (mounted) {
      setState(() {
        h.summary = result;
        h.reportPoints = points;
        h.reportTruncated = records['next_cursor'] != null;
      });
    }
  }

  List<Widget> report() => [
    const PageTitle('夜间报告', '先看数据是否可用，再理解这段时间。'),
    windowPicker(),
    const SizedBox(height: 16),
    h.button(
      '生成数据摘要',
      () => h.run(loadSummary),
      icon: Icons.analytics_outlined,
    ),
    if (h.summary == null)
      h.empty('尚未生成摘要', '没有数据时明确显示无数据，不生成“整夜平稳”的结论。')
    else
      ...summaryWidgets(),
    const SizedBox(height: 24),
    EntryRow(
      title: '和家庭助手聊聊',
      detail: '沿用该时间窗口，向真实 Hermes 提问',
      icon: Icons.chat_bubble_outline,
      onTap: () => h.selectPage(2),
    ),
  ];

  List<Widget> summaryWidgets() {
    final s = h.summary!;
    final metrics = s['metrics'] as Map? ?? {};
    return [
      h.heading(s['status'] == 'no_data' ? '该窗口无数据' : '该窗口有设备记录'),
      h.message('连续覆盖：未证实 · 个人基线：未建立\n采样空窗不等同于未发生发作。'),
      if (metrics.isEmpty) const Text('请核对采集、上传授权和时间窗口，再重新生成。'),
      if (h.reportTruncated) h.message('图示仅展示该窗口前 500 条记录；下方统计由服务端按完整窗口计算。'),
      for (final e in metrics.entries)
        Builder(
          builder: (context) {
            final v = e.value as Map;
            final points = h.reportPoints
                .where((r) => r['metric'] == e.key)
                .toList();
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                h.heading(names[e.key] ?? e.key),
                Text(
                  '${v['usable_numeric_count']} 条可读数值 / ${v['count']} 条记录',
                  style: Theme.of(context).textTheme.titleMedium,
                ),
                if (points.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  Semantics(
                    label:
                        '${names[e.key] ?? e.key}离散采样图，图中记录 ${points.length} 条。范围与间隔见下方文字。',
                    child: SizedBox(
                      height: 160,
                      child: CustomPaint(
                        painter: TrendPainter(
                          points,
                          color: Theme.of(context).colorScheme.primary,
                          ink: Theme.of(context).colorScheme.onSurfaceVariant,
                          windowStart: h.from.millisecondsSinceEpoch,
                          windowEnd: h.to.millisecondsSinceEpoch,
                        ),
                        child: const SizedBox.expand(),
                      ),
                    ),
                  ),
                  Text(
                    '${h.stamp(h.from.millisecondsSinceEpoch)} — ${h.stamp(h.to.millisecondsSinceEpoch)}',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
                const SizedBox(height: 12),
                Text(
                  '范围 ${v['min'] ?? '无'} — ${v['max'] ?? '无'} ${v['unit']} · 中位数 ${v['median'] ?? '无'}',
                ),
                Text('最大点间隔 ${v['maximum_interval_seconds'] ?? '无法计算'} 秒'),
                Text(
                  '窗口前段 ${v['leading_empty_seconds']} 秒无点 · 后段 ${v['trailing_empty_seconds']} 秒无点',
                ),
                Text(
                  '未知质量 ${v['unknown_quality_count']} 条 · 手机接收时间 ${v['phone_time_count']} 条',
                ),
                Text(
                  '来源：${(v['sources'] as List? ?? []).map((source) => source == 'live_device'
                      ? '即时设备数据'
                      : source == 'device_history'
                      ? '设备历史'
                      : source).join('、')}',
                ),
                const Divider(),
              ],
            );
          },
        ),
    ];
  }

  List<Widget> assistant() {
    final consent = (h.me?['consents'] as Map?)?['ai_analysis'];
    final pending =
        h.ai != null && !['completed', 'failed'].contains(h.ai!['status']);
    final status = switch (h.ai?['status']) {
      'completed' => '已完成',
      'failed' => '未完成',
      'running' => '智能体处理中',
      _ => '等待服务端处理',
    };
    return [
      PageTitle(
        '家庭助手',
        '结合记录，帮助整理观察与复盘。',
        trailing: ExcludeSemantics(
          child: ClipRRect(
            borderRadius: BorderRadius.circular(16),
            child: Image.asset(
              'assets/images/assistant.png',
              width: 64,
              height: 64,
            ),
          ),
        ),
      ),
      windowPicker(),
      h.heading('基于这段时间提问', detail: '默认使用 dravet-night，提交选定窗口的摘要与观察。'),
      if (consent != true)
        h.message(
          consent == false
              ? 'AI 分析尚未授权，请到“我的 → 服务与隐私”独立开启。'
              : '提交时会核对公网配对与 AI 分析授权。',
        ),
      TextField(
        key: const PageStorageKey('field-question'),
        controller: h.question,
        minLines: 3,
        maxLines: 6,
        maxLength: 2000,
        onChanged: (_) => setState(() {}),
        decoration: const InputDecoration(
          labelText: '你的问题',
          hintText: '例如：这段记录有哪些采样空窗？还需要补充哪些观察？',
        ),
      ),
      const SizedBox(height: 12),
      h.button(
        pending ? '智能体处理中…' : '提交问答',
        h.question.text.trim().isEmpty || pending || consent == false
            ? null
            : () => h.run(ask),
        icon: Icons.chat_bubble_outline,
      ),
      if (h.ai != null) ...[
        h.heading('本次问答'),
        if (h.aiQuestion != null)
          Text(h.aiQuestion!, style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 12),
        SurfacePanel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(status, style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              SelectableText(
                '${h.ai!['answer'] ?? h.ai!['error'] ?? '等待真实智能体结果'}',
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        EntryRow(
          title: '核对输入记录',
          detail: '查看相同时间窗口的统计与采样空窗',
          icon: Icons.fact_check_outlined,
          onTap: () => h.openDetail('report'),
        ),
      ] else
        h.empty('还没有问答记录', '先明确时间窗口，再填写问题。回答来自真实智能体，不使用预设回复。'),
      h.message('个人基线与医学规则尚未建立。AI 回答用于整理记录，不自动发布诊断或实验规则。'),
    ];
  }

  Future<void> ask() async {
    if (h.question.text.trim().isEmpty) throw const FormatException('请填写问题');
    await h.loadMe();
    if (!mounted) return;
    if ((h.me?['consents'] as Map?)?['ai_analysis'] != true) {
      throw const FormatException('请先在服务与隐私中允许 AI 分析');
    }
    windowPath('/v1/summaries/night');
    final conversation = await h.c.api('/v1/conversations', method: 'POST');
    h.aiQuestion = h.question.text.trim();
    h.ai = await h.c.api(
      '/v1/conversations/${conversation['id']}/messages',
      method: 'POST',
      body: {
        'device_id': h.serverDevice,
        'question': h.question.text.trim(),
        'from': h.from.toUtc().toIso8601String(),
        'to': h.to.toUtc().toIso8601String(),
        'timezone': 'Asia/Shanghai',
      },
    );
    final id = h.ai!['request_id'];
    final revision = h.windowRevision;
    if (!mounted) return;
    setState(() {});
    h.aiPoll?.cancel();
    int count = 0;
    bool polling = false;
    h.aiPoll = Timer.periodic(const Duration(seconds: 3), (timer) async {
      if (polling) return;
      if (!mounted || revision != h.windowRevision) {
        timer.cancel();
        return;
      }
      if (++count > 65) {
        timer.cancel();
        h.c.error = '问答等待超时，请检查服务端任务状态';
        if (mounted) {
          setState(
            () => h.ai = {...h.ai!, 'status': 'failed', 'error': h.c.error},
          );
        }
        return;
      }
      polling = true;
      try {
        final data = await h.c.api('/v1/ai-requests/$id');
        if (!mounted || revision != h.windowRevision) {
          timer.cancel();
          return;
        }
        setState(() => h.ai = data);
        if (['completed', 'failed'].contains(h.ai!['status'])) timer.cancel();
      } catch (e) {
        timer.cancel();
        if (!mounted || revision != h.windowRevision) return;
        h.c.error = '无法读取问答结果：$e。请检查网络与服务端。';
        if (mounted) {
          setState(
            () => h.ai = {...h.ai!, 'status': 'failed', 'error': h.c.error},
          );
        }
      } finally {
        polling = false;
      }
    });
  }

  List<Widget> settings() {
    final c = h.c, consents = h.me?['consents'] as Map? ?? {};
    final service = h.me?['service'] as Map?;
    return [
      const PageTitle('服务与隐私', '数据先保存在本机，三项公网授权分别选择。'),
      settingsGroup('公网配对与授权', '业务入口与一次性配对码', [
        TextField(
          key: const PageStorageKey('field-server-url'),
          controller: h.url,
          keyboardType: TextInputType.url,
          decoration: const InputDecoration(
            labelText: 'HTTPS 业务入口',
            hintText: publicBusinessUrl,
          ),
        ),
        const SizedBox(height: 16),
        TextField(
          key: const PageStorageKey('field-pair-code'),
          controller: h.code,
          obscureText: true,
          enableSuggestions: false,
          autocorrect: false,
          decoration: const InputDecoration(labelText: '10 分钟内有效的一次性配对码'),
        ),
        const SizedBox(height: 16),
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [
            h.button(
              '配对服务端',
              () => h.run(() async {
                await c.call('pair', {
                  'url': h.url.text.trim(),
                  'code': h.code.text.trim(),
                });
                h.code.clear();
                await h.loadMe();
              }),
              icon: Icons.link,
            ),
            OutlinedButton(
              onPressed: () => h.run(h.loadMe),
              child: const Text('刷新授权状态'),
            ),
          ],
        ),
        if (h.me != null)
          Text(
            '监护人：${h.me!['name']} · 家庭设备 ${(h.me!['devices'] as List).length}',
          ),
        ...{
          'upload': '上传即时心率、血氧与观察记录',
          'ai_analysis': '允许该窗口摘要与观察用于 AI 分析',
          'remote_alerts': '允许远程提醒与接收回执',
        }.entries.map(
          (e) => SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(e.value),
            value: consents[e.key] == true,
            onChanged: h.me == null || c.busy
                ? null
                : (v) => h.run(() async {
                    await c.api(
                      '/v1/consents',
                      method: 'POST',
                      body: {
                        'scope': e.key,
                        'granted': v,
                        'policy_version': 'demo-1',
                      },
                    );
                    await h.loadMe();
                  }),
          ),
        ),
        Text('当前入口：${c.state['serverUrl'] ?? '未配对'}'),
      ], expanded: true),
      settingsGroup('智能体与远程提醒', '公网页面分别登录 · 默认 dravet-night', [
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: [
            h.button(
              '智能体设置',
              () => h.run(
                () => c.call('openUrl', {
                  'url': service?['hermes_web_url'] ?? publicHermesUrl,
                }),
              ),
              icon: Icons.smart_toy_outlined,
            ),
            h.button(
              '服务端控制台',
              () => h.run(
                () => c.call('openUrl', {
                  'url': service?['console_url'] ?? publicConsoleUrl,
                }),
              ),
              icon: Icons.open_in_browser,
            ),
          ],
        ),
        h.message(
          service == null
              ? '配对并刷新授权状态后，可核对服务端智能体配置。'
              : service['hermes_configured'] == true
              ? '服务端已配置 ${service['hermes_profile']}。连接结果以实际问答为准。'
              : '服务端智能体尚未配置，请检查服务端设置。',
        ),
        h.message(
          '安卓 Keystore 加密保存配对凭据。Hermes 密码与密钥只在服务端使用。AI 问答会保留业务记录和智能体会话；长期记忆已关闭。',
        ),
        h.button(
          '发送跨网络测试提醒',
          c.state['deviceId'] == null
              ? null
              : () => h.run(() => c.call('remoteTest')),
          icon: Icons.notifications_active,
        ),
        h.message(
          '提醒依赖本 App 前台服务每 15 秒联网检查。厂商推送尚未配置；应用被系统或卓易通结束后不会自动送达。另一台设备收到并确认后才算完成该次测试。',
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
              '导出服务器记录',
              h.me == null
                  ? null
                  : () => h.run(() async {
                      await c.call('exportServer', {
                        'deviceId': h.serverDevice,
                      });
                    }),
              icon: Icons.cloud_download,
            ),
            OutlinedButton(
              onPressed: h.me == null
                  ? null
                  : () => h.run(() async {
                      if (!await confirmDelete(
                        '删除服务器记录',
                        '将删除当前家庭设备的服务器健康数据，同时撤销本机上传授权。本机记录仍保留；如需彻底删除，请先断开戒指并删除本机记录。',
                      )) {
                        return;
                      }
                      await c.call('deleteServer', {
                        'deviceId': h.serverDevice,
                      });
                      await h.loadMe();
                      h.summary = null;
                      h.ai = null;
                    }),
              child: const Text('删除服务器记录'),
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
      settingsGroup('兼容性与版本', 'RareGuard 0.2.0 · Flutter 安卓 APK', [
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
    if (h.me != null && h.serverDevice != null) {
      if (h.c.state['serverDeviceId'] != h.serverDevice) {
        throw const FormatException('请先同步当前戒指，再为该戒指应用规则');
      }
      final config = await h.c.api('/v1/devices/${h.serverDevice}/config');
      final published = await h.c.api(
        '/v1/devices/${h.serverDevice}/config',
        method: 'POST',
        body: {
          'base_version': config['version'],
          'parameters': p,
          'confirmed_experimental_use': true,
        },
      );
      await h.c.call('experiment', p);
      await h.c.api(
        '/v1/devices/${h.serverDevice}/config-acks',
        method: 'POST',
        body: {'version': published['version'], 'status': 'applied'},
      );
    } else {
      await h.c.call('experiment', p);
    }
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

  Future<String?> confirmationNote() async {
    final controller = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('确认已查看'),
        content: TextField(
          controller: controller,
          maxLength: 2000,
          minLines: 2,
          maxLines: 4,
          decoration: const InputDecoration(labelText: '观察与处置备注（可空）'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, controller.text.trim()),
            child: const Text('确认已查看'),
          ),
        ],
      ),
    );
    controller.dispose();
    return result;
  }
}
