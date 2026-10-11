import 'package:flutter/material.dart';

import 'home.dart';
import 'design.dart';

void main() => runApp(const RareGuardApp());

class RareGuardApp extends StatelessWidget {
  const RareGuardApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'RareGuard 夜间观察',
    debugShowCheckedModeBanner: false,
    theme: rareGuardTheme(),
    home: const Home(),
  );
}
