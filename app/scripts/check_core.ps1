$ErrorActionPreference='Stop'
function Resolve-RareGuardJavaTool([string]$Tool) {
    if (-not [string]::IsNullOrWhiteSpace($env:JAVA_HOME)) {
        $rgSuffix = if ([System.IO.Path]::DirectorySeparatorChar -eq '\') { '.exe' } else { '' }
        $rgCandidate = Join-Path $env:JAVA_HOME "bin/$Tool$rgSuffix"
        if (-not (Test-Path -LiteralPath $rgCandidate -PathType Leaf)) {
            throw "JAVA_HOME does not contain $Tool; point JAVA_HOME to a JDK installation."
        }
        return $rgCandidate
    }
    $rgCommand = Get-Command -Name $Tool -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $rgCommand) {
        throw "$Tool not found; set JAVA_HOME to a JDK or add its bin directory to PATH."
    }
    return $rgCommand.Source
}
$rgJavac = Resolve-RareGuardJavaTool 'javac'
$rgJava = Resolve-RareGuardJavaTool 'java'
$rgRoot=Split-Path -Parent $PSScriptRoot
$rgMain=Join-Path $rgRoot 'android/app/src/main/java/org/rareguard/core'
$rgTest=Join-Path $rgRoot 'android/app/src/test/java/org/rareguard/core'
$rgOutput=Join-Path $rgRoot 'build/core-checks'
New-Item -ItemType Directory -Force $rgOutput | Out-Null
& $rgJavac -encoding UTF-8 -d $rgOutput "$rgMain/EfeProtocol.java" "$rgMain/MeasurementWindow.java" "$rgMain/ChangeRule.java" "$rgTest/CoreChecks.java" "$rgTest/RuleChecks.java"
if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
foreach($rgClass in @('CoreChecks','RuleChecks')) {
    & $rgJava -ea -cp $rgOutput "org.rareguard.core.$rgClass"
    if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}
}
