$ErrorActionPreference='Stop'
$rgRoot=Split-Path -Parent $PSScriptRoot
$rgMain=Join-Path $rgRoot 'android/app/src/main/java/org/rareguard/core'
$rgTest=Join-Path $rgRoot 'android/app/src/test/java/org/rareguard/core'
$rgOutput=Join-Path $rgRoot 'build/core-checks'
$rgJavac = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin/javac.exe' } else { (Get-Command javac -ErrorAction Stop).Source }
$rgJava = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin/java.exe' } else { (Get-Command java -ErrorAction Stop).Source }
if (!(Test-Path -LiteralPath $rgJavac) -or !(Test-Path -LiteralPath $rgJava)) { throw 'JAVA_HOME must point to a JDK containing javac and java.' }
New-Item -ItemType Directory -Force $rgOutput | Out-Null
& $rgJavac -encoding UTF-8 -d $rgOutput "$rgMain/EfeProtocol.java" "$rgMain/MeasurementWindow.java" "$rgMain/ChangeRule.java" "$rgMain/DravetPolicy.java" "$rgTest/CoreChecks.java" "$rgTest/RuleChecks.java" "$rgTest/DravetChecks.java"
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
foreach($rgClass in @('CoreChecks','RuleChecks','DravetChecks')) {
    & $rgJava -ea -cp $rgOutput "org.rareguard.core.$rgClass"
    if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
}
