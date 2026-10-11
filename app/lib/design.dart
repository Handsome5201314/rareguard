import 'package:flutter/material.dart';

const teal = Color(0xff8cddc6);
const navy = Color(0xff142e38);
const nightBackground = Color(0xff081e28);
const nightInk = Color(0xffedf7f5);
const mutedInk = Color(0xffa9c3c8);
const amber = Color(0xffffce7a);

ThemeData rareGuardTheme({bool light = false}) {
  final scheme =
      ColorScheme.fromSeed(
        seedColor: const Color(0xff28796f),
        brightness: light ? Brightness.light : Brightness.dark,
      ).copyWith(
        primary: light ? const Color(0xff256e64) : teal,
        onPrimary: light ? Colors.white : nightBackground,
        primaryContainer: light
            ? const Color(0xffdfefe9)
            : const Color(0xff214a49),
        onPrimaryContainer: light ? const Color(0xff17544b) : teal,
        surface: light ? const Color(0xfff6f9f7) : nightBackground,
        surfaceContainerLow: light ? Colors.white : navy,
        surfaceContainer: light
            ? const Color(0xffeaf2ef)
            : const Color(0xff193942),
        onSurface: light ? const Color(0xff1c4546) : nightInk,
        onSurfaceVariant: light ? const Color(0xff50696b) : mutedInk,
        outline: light ? const Color(0xff6b8581) : const Color(0xff658a90),
        outlineVariant: light
            ? const Color(0xffd4e3de)
            : const Color(0xff2a4852),
        error: light ? const Color(0xffa63039) : const Color(0xffffb4ba),
        errorContainer: light
            ? const Color(0xffffe9e8)
            : const Color(0xff402b31),
      );
  final base = ThemeData(useMaterial3: true, colorScheme: scheme);
  final text = base.textTheme.copyWith(
    headlineLarge: TextStyle(
      fontSize: 30,
      height: 1.25,
      fontWeight: FontWeight.w700,
      color: scheme.onSurface,
    ),
    headlineSmall: TextStyle(
      fontSize: 24,
      height: 1.3,
      fontWeight: FontWeight.w700,
      color: scheme.onSurface,
    ),
    titleLarge: TextStyle(
      fontSize: 20,
      height: 1.4,
      fontWeight: FontWeight.w600,
      color: scheme.onSurface,
    ),
    titleMedium: TextStyle(
      fontSize: 16,
      height: 1.4,
      fontWeight: FontWeight.w600,
      color: scheme.onSurface,
    ),
    bodyLarge: TextStyle(fontSize: 16, height: 1.55, color: scheme.onSurface),
    bodyMedium: TextStyle(fontSize: 14, height: 1.55, color: scheme.onSurface),
    bodySmall: TextStyle(
      fontSize: 12,
      height: 1.5,
      color: scheme.onSurfaceVariant,
    ),
    displaySmall: TextStyle(
      fontSize: 36,
      height: 1.15,
      fontWeight: FontWeight.w600,
      color: scheme.onSurface,
      fontFeatures: const [FontFeature.tabularFigures()],
    ),
  );
  return base.copyWith(
    textTheme: text,
    scaffoldBackgroundColor: scheme.surface,
    appBarTheme: AppBarTheme(
      backgroundColor: scheme.surface,
      foregroundColor: scheme.onSurface,
      surfaceTintColor: Colors.transparent,
      titleTextStyle: text.titleMedium,
      elevation: 0,
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: scheme.surfaceContainerLow,
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12)),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: BorderSide(color: scheme.outlineVariant),
      ),
      contentPadding: const EdgeInsets.all(16),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size(48, 48),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size(48, 48),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: scheme.surface,
      indicatorColor: scheme.primaryContainer,
      height: 76,
      labelTextStyle: WidgetStatePropertyAll(text.labelMedium),
    ),
    navigationRailTheme: NavigationRailThemeData(
      backgroundColor: scheme.surface,
      indicatorColor: scheme.primaryContainer,
      selectedIconTheme: IconThemeData(color: scheme.primary),
      selectedLabelTextStyle: TextStyle(color: scheme.primary),
    ),
    dividerTheme: DividerThemeData(
      color: scheme.outlineVariant,
      space: 24,
      thickness: 1,
    ),
    chipTheme: base.chipTheme.copyWith(
      side: BorderSide(color: scheme.outlineVariant),
    ),
  );
}

class SurfacePanel extends StatelessWidget {
  const SurfacePanel({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(20),
  });
  final Widget child;
  final EdgeInsets padding;
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: padding,
    decoration: BoxDecoration(
      color: Theme.of(context).colorScheme.surfaceContainerLow,
      borderRadius: BorderRadius.circular(14),
    ),
    child: child,
  );
}

class PageTitle extends StatelessWidget {
  const PageTitle(this.title, this.detail, {super.key, this.trailing});
  final String title, detail;
  final Widget? trailing;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 12, bottom: 24),
    child: Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: Theme.of(context).textTheme.headlineLarge),
              const SizedBox(height: 8),
              Text(
                detail,
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
        if (trailing != null) ...[const SizedBox(width: 16), trailing!],
      ],
    ),
  );
}

class EntryRow extends StatelessWidget {
  const EntryRow({
    super.key,
    required this.title,
    required this.detail,
    required this.icon,
    required this.onTap,
  });
  final String title, detail;
  final IconData icon;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => Material(
    color: Theme.of(context).colorScheme.surfaceContainerLow,
    borderRadius: BorderRadius.circular(14),
    clipBehavior: Clip.antiAlias,
    child: ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
      leading: Icon(icon, color: Theme.of(context).colorScheme.primary),
      title: Text(title, style: Theme.of(context).textTheme.titleMedium),
      subtitle: Text(detail),
      trailing: const Icon(Icons.chevron_right),
      onTap: onTap,
    ),
  );
}

class NightScene extends StatelessWidget {
  const NightScene({super.key, required this.title, required this.detail});
  final String title, detail;
  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, size) {
      final imageWidth = size.maxWidth < 360 ? 92.0 : 140.0;
      return Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: Theme.of(context).textTheme.headlineLarge),
                const SizedBox(height: 12),
                Text(
                  detail,
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          ExcludeSemantics(
            child: SizedBox(
              width: imageWidth,
              height: 140,
              child: Image.asset(
                'assets/images/night.png',
                fit: BoxFit.cover,
                alignment: Alignment.centerRight,
              ),
            ),
          ),
        ],
      );
    },
  );
}

class DeviceImage extends StatelessWidget {
  const DeviceImage({super.key});
  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: Padding(
      padding: const EdgeInsets.only(bottom: 20),
      child: SizedBox(
        height: 180,
        width: double.infinity,
        child: Image.asset('assets/images/ring.png', fit: BoxFit.contain),
      ),
    ),
  );
}

class RecentMetric extends StatelessWidget {
  const RecentMetric({
    super.key,
    required this.title,
    required this.icon,
    required this.row,
    required this.received,
    required this.measureLabel,
    required this.onMeasure,
    this.compact = false,
  });
  final String title, received, measureLabel;
  final IconData icon;
  final Map<String, dynamic>? row;
  final VoidCallback? onMeasure;
  final bool compact;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final valid = row != null && row!['quality'] != 'invalid';
    final number = row?['value'] as num?;
    final value = valid && number != null
        ? number.toStringAsFixed(number % 1 == 0 ? 0 : 1)
        : '—';
    final content = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Icon(icon, size: 20, color: theme.colorScheme.primary),
            const SizedBox(width: 8),
            Expanded(child: Text(title, style: theme.textTheme.titleMedium)),
          ],
        ),
        const SizedBox(height: 12),
        Wrap(
          crossAxisAlignment: WrapCrossAlignment.end,
          spacing: 8,
          children: [
            Text(value, style: theme.textTheme.displaySmall),
            if (valid)
              Padding(
                padding: const EdgeInsets.only(bottom: 4),
                child: Text(
                  '${row!['unit']}',
                  style: theme.textTheme.bodyMedium,
                ),
              ),
          ],
        ),
        const SizedBox(height: 8),
        Text(received, style: theme.textTheme.bodySmall),
        Text(
          row == null
              ? '等待测量'
              : row!['quality'] == 'invalid'
              ? '质量无效'
              : '信号质量未知',
          style: theme.textTheme.bodySmall,
        ),
      ],
    );
    return SurfacePanel(
      child: compact && MediaQuery.textScalerOf(context).scale(16) <= 22
          ? Row(
              children: [
                Expanded(child: content),
                const SizedBox(width: 12),
                OutlinedButton(onPressed: onMeasure, child: Text(measureLabel)),
              ],
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                content,
                const SizedBox(height: 16),
                SizedBox(
                  width: double.infinity,
                  child: OutlinedButton(
                    onPressed: onMeasure,
                    child: Text(measureLabel),
                  ),
                ),
              ],
            ),
    );
  }
}

class TimelineEntry extends StatelessWidget {
  const TimelineEntry({
    super.key,
    required this.title,
    required this.type,
    required this.time,
    required this.recorded,
    required this.observation,
  });
  final String title, type, time, recorded;
  final bool observation;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 24),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Icon(
            observation ? Icons.visibility_outlined : Icons.sensors,
            size: 22,
            color: Theme.of(context).colorScheme.primary,
          ),
        ),
        const SizedBox(width: 16),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                '$time · $type',
                style: Theme.of(context).textTheme.bodySmall,
              ),
              const SizedBox(height: 6),
              Text(title, style: Theme.of(context).textTheme.bodyLarge),
              const SizedBox(height: 6),
              Text(
                '记录于 $recorded',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ),
        ),
      ],
    ),
  );
}
