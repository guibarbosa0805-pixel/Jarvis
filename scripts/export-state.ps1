# Roda na máquina ATUAL. Para o Jarvis aqui e empacota sessão do WhatsApp + dados
# num zip na Área de Trabalho, pra levar pro servidor. (O zip contém a sessão e as
# chaves de API: trate como segredo.)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Disable-ScheduledTask -TaskName 'Jarvis' -ErrorAction SilentlyContinue | Out-Null

foreach ($pass in 1..2) {
  Get-CimInstance Win32_Process |
    Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'run-forever|src.panel' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

$stage = Join-Path $env:TEMP 'jarvis-state-stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path "$stage\auth" -Force | Out-Null

Copy-Item "$root\auth\jarvis" "$stage\auth\jarvis" -Recurse
foreach ($dir in 'data', 'instances') {
  if (Test-Path "$root\$dir") { Copy-Item "$root\$dir" "$stage\$dir" -Recurse }
}

$out = Join-Path ([Environment]::GetFolderPath('Desktop')) 'jarvis-state.zip'
if (Test-Path $out) { Remove-Item $out }
Compress-Archive -Path "$stage\*" -DestinationPath $out
Remove-Item $stage -Recurse -Force

Write-Host "Jarvis parado aqui e tarefa desativada."
Write-Host "Pacote pronto: $out"
Write-Host "Leve esse zip pro servidor e rode o setup-server.ps1 lá. Não ligue o Jarvis aqui de novo (a sessão do WhatsApp só pode rodar em um lugar)."
