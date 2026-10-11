part of 'home.dart';

mixin _CollectionPages on State<Home> {
  _HomeState get h => this as _HomeState;

  List<Widget> overview() {
    final c = h.c;
    final connected = c.state['state'] == '已连接';
    final active = c.state['measuring'] == true;
    final night = c.state['night'] == true;
    final canMeasure = connected && !active && !night;
    final live = c
        .rows('latestLive')
        .where((r) => r['source'] == 'live_device')
        .toList();
    Map<String, dynamic>? recent(String key) {
      final rows = live.where((r) => r['metric'] == key).toList();
      return rows.isEmpty ? null : rows.first;
    }

    final last = c.state['lastLive'] as num? ?? 0;
    final gap =
        night &&
        (last == 0 || DateTime.now().millisecondsSinceEpoch - last > 120000);
    return [
      NightScene(title: '今夜，一起守候', detail: night ? '正在交替采集心率与血氧' : '从一次真实测量开始'),
      const SizedBox(height: 16),
      SurfacePanel(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(
                  connected
                      ? Icons.bluetooth_connected
                      : Icons.bluetooth_disabled,
                  color: connected ? teal : mutedInk,
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    '${c.state['name'] ?? '戒指'} · ${c.state['state']}',
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                IconButton(
                  tooltip: '连接与测量',
                  onPressed: () => h.openDetail('device'),
                  icon: const Icon(Icons.chevron_right),
                ),
              ],
            ),
            Text(
              '电量 ${(c.state['battery'] as num? ?? -1) < 0 ? '待查询' : '${c.state['battery']}%'} · 即时数据 ${h.age(last)}',
              style: const TextStyle(color: mutedInk),
            ),
            if (active || night) ...[
              const SizedBox(height: 10),
              Text('${c.state['operation'] ?? '等待设备返回'}'),
            ],
          ],
        ),
      ),
      h.heading('最近采样', detail: '展示最近一次即时读数，时间与质量始终保留。'),
      if (live.isEmpty) const Text('还没有即时数据。先连接戒指，再选择一项测量。'),
      const SizedBox(height: 12),
      LayoutBuilder(
        builder: (context, size) {
          final columns =
              size.maxWidth >= 360 &&
                  MediaQuery.textScalerOf(context).scale(16) <= 22
              ? 2
              : 1;
          final width = (size.maxWidth - (columns - 1) * 12) / columns;
          return Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              for (final key in ['hr', 'spo2'])
                SizedBox(
                  width: width,
                  child: RecentMetric(
                    title: names[key]!,
                    icon: key == 'hr'
                        ? Icons.favorite_border
                        : Icons.water_drop_outlined,
                    row: recent(key),
                    received: recent(key) == null
                        ? '尚未收到'
                        : h.stamp(recent(key)!['receivedMs']),
                    measureLabel: key == 'hr' ? '测心率' : '测血氧',
                    onMeasure: canMeasure && !c.busy
                        ? () => h.run(
                            () => c.call('measure', {
                              'metric': key,
                              'seconds': 60,
                            }),
                          )
                        : null,
                  ),
                ),
            ],
          );
        },
      ),
      const SizedBox(height: 12),
      RecentMetric(
        title: '皮温',
        icon: Icons.thermostat_outlined,
        row: recent('temp'),
        received: recent('temp') == null
            ? '尚未收到'
            : h.stamp(recent('temp')!['receivedMs']),
        measureLabel: '测皮温',
        compact: true,
        onMeasure: canMeasure && !c.busy
            ? () => h.run(
                () => c.call('measure', {'metric': 'temp', 'seconds': 60}),
              )
            : null,
      ),
      if (active) ...[
        const SizedBox(height: 12),
        h.button('停止测量', () => h.run(() => c.call('stop')), icon: Icons.stop),
      ],
      h.heading('夜间采集'),
      h.button(
        night ? '结束夜间采集' : '开始实验夜间采集',
        (connected && (!active || night))
            ? () => h.run(() => c.call('night', {'enabled': !night}))
            : null,
        icon: night ? Icons.stop_circle_outlined : Icons.nights_stay_outlined,
      ),
      const SizedBox(height: 10),
      const Text('心率、血氧各测 60 秒并交替进行。单次测量时请贴合佩戴、尽量静止。'),
      if (gap) h.message('采样空窗：超过两分钟未收到即时数据。请检查佩戴、蓝牙与采集状态。', warning: true),
      h.message('连续覆盖尚未证实；采样空窗或没有提醒，不能作为安全结论。皮温不等同于核心体温。'),
      EntryRow(
        title: '查看夜间报告',
        detail: '明确时间窗口，核对有效记录与采样空窗',
        icon: Icons.analytics_outlined,
        onTap: () => h.openDetail('report'),
      ),
      h.heading('发作观察', detail: '生理指标和家长记录共同用于观察与复盘。'),
      EntryRow(
        title: '记录发作观察',
        detail: '记录看到的动作、持续时间、反应和处置',
        icon: Icons.edit_note,
        onTap: h.openObservation,
      ),
      const SizedBox(height: 12),
      EntryRow(
        title: '三轴运动数据',
        detail: '戒指连续读取已实测 · 本 App 尚未接入',
        icon: Icons.motion_photos_on_outlined,
        onTap: () => h.openDetail('motion'),
      ),
      h.heading('远程提醒'),
      Text(
        '${c.state['syncState'] ?? '未配对'} · ${c.state['pending'] ?? 0} 条待同步记录',
      ),
      if (c.state['remoteError']?.toString().isNotEmpty == true)
        h.message('${c.state['remoteError']}', warning: true),
      ...h.alertWidgets(),
      if (c.rows('alerts').isEmpty)
        h.empty('暂未收到提醒', '查看设置中的配对与远程提醒授权。收到与查看确认会分别记录。'),
      h.button('检查远程提醒', () => h.run(() => c.call('sync')), icon: Icons.sync),
    ];
  }

  List<Widget> device() {
    final c = h.c,
        ready = c.state['state'] == '已连接',
        active = c.state['measuring'] == true;
    final night = c.state['night'] == true;
    return [
      const PageTitle('戒指与采集', '连接实际广播的设备，保留每条数据的来源。'),
      const DeviceImage(),
      Text(
        '${c.state['name'] ?? '尚未选择戒指'} · ${c.state['state']}',
        style: Theme.of(context).textTheme.titleLarge,
      ),
      Text(
        '固件 ${c.state['firmware']?.toString().isNotEmpty == true ? c.state['firmware'] : '未读取'} · 电量 ${(c.state['battery'] as num? ?? -1) < 0 ? '待查询' : '${c.state['battery']}%'}',
      ),
      const SizedBox(height: 20),
      Wrap(
        spacing: 12,
        runSpacing: 12,
        children: [
          h.button('授权并启动服务', () => h.run(c.start), icon: Icons.security),
          h.button(
            c.state['scanning'] == true ? '正在扫描…' : '扫描附近设备',
            c.state['scanning'] == true
                ? null
                : () => h.run(() => c.call('scan')),
            icon: Icons.bluetooth_searching,
          ),
        ],
      ),
      if (c.rows('devices').isNotEmpty)
        ExpansionTile(
          key: PageStorageKey('scan-$ready'),
          initiallyExpanded: !ready,
          tilePadding: EdgeInsets.zero,
          title: Text('附近设备（${c.rows('devices').length}）'),
          subtitle: Text(ready ? '已连接，展开可切换设备' : '选择 MR11；连接后列表自动收起'),
          children: [
            for (final d in c.rows('devices'))
              ListTile(
                contentPadding: EdgeInsets.zero,
                title: Text(d['name']),
                subtitle: Text('${d['address']} · ${d['rssi']} dBm'),
                trailing: OutlinedButton(
                  onPressed: c.busy || night || active
                      ? null
                      : () => h.run(
                          () => c.call('connect', {
                            'address': d['address'],
                            'name': d['name'],
                          }),
                        ),
                  child: const Text('连接'),
                ),
              ),
          ],
        ),
      if (!ready && c.rows('devices').isEmpty)
        h.empty('尚无扫描结果', '把戒指放在附近并唤醒，退出其他设备上的戒指 App，再扫描。'),
      const SizedBox(height: 12),
      Wrap(
        spacing: 12,
        runSpacing: 12,
        children: [
          h.button(
            '查询电量',
            ready ? () => h.run(() => c.call('battery')) : null,
            icon: Icons.battery_std,
          ),
          OutlinedButton(
            onPressed: ready && !c.busy
                ? () => h.run(() => c.call('disconnect'))
                : null,
            child: const Text('断开'),
          ),
        ],
      ),
      h.heading('单次测量与历史'),
      DropdownButtonFormField<String>(
        initialValue: h.metric,
        decoration: const InputDecoration(labelText: '指标'),
        items: ['hr', 'spo2', 'bp', 'temp', 'glu', 'stress', 'hrv']
            .map((k) => DropdownMenuItem(value: k, child: Text(names[k]!)))
            .toList(),
        onChanged: active || night
            ? null
            : (v) => setState(() {
                h.metric = v!;
                h.trend = [];
              }),
      ),
      const SizedBox(height: 16),
      Wrap(
        spacing: 12,
        runSpacing: 12,
        children: [
          h.button(
            '测量 60 秒',
            ready && !active && !night
                ? () => h.run(
                    () =>
                        c.call('measure', {'metric': h.metric, 'seconds': 60}),
                  )
                : null,
            icon: Icons.play_arrow,
          ),
          h.button(
            '停止测量',
            active ? () => h.run(() => c.call('stop')) : null,
            icon: Icons.stop,
          ),
          OutlinedButton(
            onPressed: ready && !active && !night && !c.busy
                ? () => h.run(() => c.call('history', {'metric': h.metric}))
                : null,
            child: const Text('读历史'),
          ),
        ],
      ),
      const SizedBox(height: 12),
      Text('${c.state['operation'] ?? '尚未开始测量'}'),
      if (night) h.message('正在夜间交替采集。请回到今夜结束采集，再进行单项测量或读取历史。'),
      h.message(
        '血糖、血压、压力和 HRV 为厂商返回值，测量方法与医学准确性尚未核验。ECG、原始 PPG、RRI 尚无已验证读取协议。',
      ),
      h.heading('最近收到的设备记录', detail: '即时与历史分别标识；历史不会填入首页最近采样。'),
      if (c.rows('latest').isEmpty)
        h.empty('还没有设备记录', '有命令应答但没有读数，也会显示为未取得数据。'),
      for (final r in c.rows('latest'))
        ListTile(
          contentPadding: EdgeInsets.zero,
          title: Text(
            '${names[r['metric']] ?? r['metric']} · ${h.numText(r['value'])} ${r['unit']}',
          ),
          subtitle: Text(
            '${r['source'] == 'live_device' ? '即时 · 手机接收时间' : '历史 · 设备时间 ${r['deviceLocalTime'] ?? '无有效时间'}'}\n${h.stamp(r['receivedMs'])} · 质量 ${r['quality'] == 'invalid' ? '无效' : '未知'}',
          ),
        ),
      h.heading('最近 24 小时即时记录', detail: '只绘制实际收到的离散点，不连接成连续波形。'),
      h.button(
        '读取本机即时记录',
        () => h.run(() async {
          final rows = await c.call('samples', {
            'metric': h.metric == 'bp' ? 'bp_sys' : h.metric,
            'liveOnly': true,
          });
          h.trend =
              (rows as List)
                  .map((r) => Map<String, dynamic>.from(r as Map))
                  .toList()
                ..sort(
                  (a, b) => (a['receivedMs'] as num).compareTo(
                    b['receivedMs'] as num,
                  ),
                );
          if (mounted) setState(() {});
        }),
        icon: Icons.scatter_plot_outlined,
      ),
      if (h.trend.isEmpty)
        h.empty('该指标没有即时点', '历史记录不用于填补即时数据的采样空窗。')
      else ...[
        const SizedBox(height: 16),
        Semantics(
          label:
              '${names[h.metric] ?? h.metric}离散采样图，共 ${h.trend.length} 条记录。详细数值在下方。',
          child: SizedBox(
            height: 180,
            child: CustomPaint(
              painter: TrendPainter(h.trend),
              child: const SizedBox.expand(),
            ),
          ),
        ),
        Text(
          '${h.stamp(h.trend.first['receivedMs'])} — ${h.stamp(h.trend.last['receivedMs'])} · ${h.trend.length} 条',
        ),
        for (final r in h.trend.reversed.take(12))
          ListTile(
            contentPadding: EdgeInsets.zero,
            title: Text('${h.numText(r['value'])} ${r['unit']}'),
            subtitle: Text(
              '${h.stamp(r['receivedMs'])} · 质量 ${r['quality'] == 'invalid' ? '无效' : '未知'}',
            ),
          ),
      ],
    ];
  }

  List<Widget> timeline() {
    final events =
        h.c
            .rows('events')
            .where(
              (e) =>
                  h.eventFilter == 'all' ||
                  (h.eventFilter == 'observation'
                      ? e['kind'] == 'observation'
                      : e['kind'] != 'observation'),
            )
            .toList()
          ..sort(
            (a, b) =>
                (b['occurredMs'] as num).compareTo(a['occurredMs'] as num),
          );
    return [
      const PageTitle('夜间记录', '设备事件与家长观察，按发生时间排列。'),
      h.button(
        h.observationOpen ? '收起观察表单' : '添加观察',
        () => setState(() => h.observationOpen = !h.observationOpen),
        icon: Icons.edit_note,
      ),
      if (h.observationOpen) ...[
        const SizedBox(height: 16),
        SurfacePanel(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('记录看到的事实', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 8),
              const Text('动作、持续时间、呼吸/反应与处置可一起记录。发生时间与记录时间分别保存。'),
              const SizedBox(height: 16),
              TextField(
                key: const PageStorageKey('field-observation'),
                controller: h.note,
                maxLines: 5,
                minLines: 3,
                maxLength: 2000,
                onChanged: (_) => setState(() {}),
                decoration: const InputDecoration(labelText: '观察 / 处置备注'),
              ),
              TextButton.icon(
                onPressed: () => h.run(() async {
                  final d = await h.pick(h.occurred);
                  if (d != null) setState(() => h.occurred = d);
                }),
                icon: const Icon(Icons.schedule),
                label: Text(
                  '发生时间 ${h.stamp(h.occurred.millisecondsSinceEpoch)}',
                ),
              ),
              h.button(
                '保存观察',
                h.c.state['deviceId'] == null || h.note.text.trim().isEmpty
                    ? null
                    : () => h.run(() async {
                        await h.c.call('observe', {
                          'text': h.note.text.trim(),
                          'when': h.occurred.millisecondsSinceEpoch,
                        });
                        h.note.clear();
                        if (mounted) {
                          setState(() {
                            h.observationOpen = false;
                            h.eventFilter = 'all';
                          });
                        }
                        await h.c.call('sync');
                      }),
                icon: Icons.check,
              ),
              if (h.c.state['deviceId'] == null)
                const Text('请先连接戒指，为观察记录关联设备。'),
            ],
          ),
        ),
      ],
      h.heading('时间轴'),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final entry in {
            'all': '全部',
            'device': '设备事件',
            'observation': '家长观察',
          }.entries)
            FilterChip(
              label: Text(entry.value),
              selected: h.eventFilter == entry.key,
              onSelected: (_) => setState(() => h.eventFilter = entry.key),
            ),
        ],
      ),
      const SizedBox(height: 16),
      if (events.isEmpty) h.empty('当前分类还没有记录', '设备采集、连接变化和保存的观察，会显示在相应分类中。'),
      for (final e in events)
        TimelineEntry(
          title: '${e['text']}',
          type: e['kind'] == 'observation' ? '家长观察' : '设备事件',
          time: h.stamp(e['occurredMs']),
          recorded: h.stamp(e['recordedMs']),
          observation: e['kind'] == 'observation',
        ),
    ];
  }

  List<Widget> account() {
    final c = h.c;
    return [
      const PageTitle('我的', '照看设备，也照看每一份数据。'),
      const DeviceImage(),
      Text(
        c.state['name'] ?? '还未连接戒指',
        style: Theme.of(context).textTheme.headlineSmall,
      ),
      const SizedBox(height: 8),
      Text(
        '${c.state['state']} · ${(c.state['battery'] as num? ?? -1) < 0 ? '电量待查询' : '电量 ${c.state['battery']}%'}',
      ),
      const SizedBox(height: 24),
      EntryRow(
        title: '连接与测量',
        detail: '蓝牙、单次测量、历史与本机记录',
        icon: Icons.sensors,
        onTap: () => h.openDetail('device'),
      ),
      const SizedBox(height: 12),
      EntryRow(
        title: '服务与隐私',
        detail: '公网配对、独立授权、实验规则与数据管理',
        icon: Icons.tune,
        onTap: () => h.openDetail('settings'),
      ),
      const SizedBox(height: 12),
      EntryRow(
        title: '夜间报告',
        detail: '按明确窗口核对同步数据和空窗',
        icon: Icons.analytics_outlined,
        onTap: () => h.openDetail('report'),
      ),
      h.heading('当前服务'),
      Text(
        '${c.state['syncState'] ?? '未配对'} · ${c.state['pending'] ?? 0} 条待同步',
      ),
      Text('实验变化提醒：${c.state['experimentEnabled'] == true ? '已启用' : '关闭'}'),
      h.message('上传、AI 分析和远程提醒分别授权。默认不设医学阈值，不把观察工具当作发作诊断。'),
    ];
  }

  List<Widget> motionInfo() => [
    const PageTitle('三轴运动数据', '连续数值流，可用于研究动作的节律和持续时间。'),
    h.message('当前戒指的连续三轴读取已在电脑端短时实测；本 App 尚未接入该采集通道。'),
    h.heading('与双击操作的区别'),
    const Text('翻页、拍照由戒指识别动作后触发预设操作。连续三轴读取提供随时间变化的运动数值，适合进一步分析动作过程。'),
    h.heading('当前验证边界'),
    const Text('静置和活动对照已取得不同的数值变化。物理单位、坐标标定、持续采集覆盖和发作识别效果仍需验证；手动抖动不能代替真实发作验证。'),
    h.heading('观察可以先记录'),
    const Text('实际看到的抽动节律、持续时间、反应与处置，可保存为家长观察，后续与运动片段核对。'),
    const SizedBox(height: 16),
    h.button('记录发作观察', h.openObservation, icon: Icons.edit_note),
  ];
}
