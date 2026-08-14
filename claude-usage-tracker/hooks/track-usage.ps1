# Hook `Stop` de Claude Code — Windows (PowerShell).
#
# Equivalente de track-usage.sh. Mismas tres reglas: mudo (nada a stdout, porque el
# output de un hook Stop puede inyectarse al contexto del modelo y costarte tokens),
# siempre exit 0, y el push desacoplado para no agregar latencia al final del turno.

$ErrorActionPreference = 'SilentlyContinue'

$repo = Split-Path -Parent $PSScriptRoot
$log  = Join-Path $PSScriptRoot 'track-usage.log'

try {
    "=== $(Get-Date -Format o) ===" | Out-File -FilePath $log -Append -Encoding utf8

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        'node no esta en el PATH; se omite' | Out-File -FilePath $log -Append -Encoding utf8
        exit 0
    }

    & node (Join-Path $repo 'src\export.js') *>&1 |
        Out-File -FilePath $log -Append -Encoding utf8

    if ($env:TRACKER_PUSH -ne '0' -and (Test-Path (Join-Path $repo '.git'))) {
        # Job en segundo plano: no bloquea el final del turno.
        Start-Job -ScriptBlock {
            param($r)
            Set-Location $r
            git diff --quiet -- data/
            if ($LASTEXITCODE -ne 0) {
                git add data/ 2>&1 | Out-Null
                git commit -m "datos: $env:COMPUTERNAME $(Get-Date -Format 'yyyy-MM-ddTHH:mmZ')" 2>&1 | Out-Null
                git pull --rebase --autostash 2>&1 | Out-Null
                git push 2>&1 | Out-Null
            }
        } -ArgumentList $repo | Out-Null
    }
}
catch {
    $_ | Out-File -FilePath $log -Append -Encoding utf8
}

exit 0
