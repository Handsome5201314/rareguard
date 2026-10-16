#!/usr/bin/env bash
set -euo pipefail

rg_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
rg_main="$rg_root/android/app/src/main/java/org/rareguard/core"
rg_test="$rg_root/android/app/src/test/java/org/rareguard/core"
rg_output="$rg_root/build/core-checks"

if [[ -n "${JAVA_HOME:-}" ]]; then
    rg_javac="$JAVA_HOME/bin/javac"
    rg_java="$JAVA_HOME/bin/java"
    if [[ ! -x "$rg_javac" || ! -x "$rg_java" ]]; then
        printf '%s\n' 'JAVA_HOME must point to a JDK containing javac and java.' >&2
        exit 1
    fi
else
    rg_javac="$(command -v javac)" || { printf '%s\n' 'javac not found; set JAVA_HOME or add a JDK to PATH.' >&2; exit 1; }
    rg_java="$(command -v java)" || { printf '%s\n' 'java not found; set JAVA_HOME or add a JDK to PATH.' >&2; exit 1; }
fi

mkdir -p -- "$rg_output"
"$rg_javac" -encoding UTF-8 -d "$rg_output" \
    "$rg_main/EfeProtocol.java" \
    "$rg_main/MeasurementWindow.java" \
    "$rg_main/ChangeRule.java" \
    "$rg_main/DravetPolicy.java" \
    "$rg_test/CoreChecks.java" \
    "$rg_test/RuleChecks.java" \
    "$rg_test/DravetChecks.java"
for rg_class in CoreChecks RuleChecks DravetChecks; do
    "$rg_java" -ea -cp "$rg_output" "org.rareguard.core.$rg_class"
done
