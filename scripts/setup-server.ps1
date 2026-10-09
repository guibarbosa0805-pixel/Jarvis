# Roda no SERVIDOR (Windows), em um PowerShell como Administrador.
# Instala Node/Git, baixa o projeto, restaura a sessão e deixa o Jarvis
# subindo sozinho junto com o Windows (sem precisar de login).
#
# Uso: .\setup-server.ps1 -StateZip C:\caminho\jarvis-state.zip
param(
  [string]$StateZip,
  [string]$InstallDir = 'C:\jarvis',
  [string]$RepoUrl = 'https://github.com/guibarbosa0805-pixel/Jarvis.git'
)
$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Abra o PowerShell como Administrador e rode de novo.' }

function Update-SessionPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
  Update-SessionPath
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements
  Update-SessionPath
}

if (Test-Path "$InstallDir\.git") {
  git -C $InstallDir pull
} else {
  git clone $RepoUrl $InstallDir
}

Push-Location $InstallDir
npm install
Pop-Location

if ($StateZip) {
  if (-not (Test-Path $StateZip)) { throw "Zip não encontrado: $StateZip" }
  Expand-Archive -Path $StateZip -DestinationPath $InstallDir -Force
} else {
  Write-Warning 'Sem -StateZip: o Jarvis vai pedir QR code novo e começar sem pessoas cadastradas.'
}

$tz = (Get-TimeZone).Id
if ($tz -ne 'E. South America Standard Time') {
  Write-Warning "Fuso horário é '$tz'. Os lembretes usam o horário local; ajuste com: Set-TimeZone -Id 'E. South America Standard Time'"
}

powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$InstallDir\scripts\run-forever.cmd`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Jarvis' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

Start-ScheduledTask -TaskName 'Jarvis'
Start-Sleep -Seconds 15
try {
  $status = Invoke-RestMethod http://localhost:4545/api/jarvis/status
  Write-Host "Status do Jarvis: $($status.status.state)"
} catch {
  Write-Warning "Painel ainda não respondeu; veja $InstallDir\logs\panel.log"
}
Write-Host 'Pronto. O Jarvis agora sobe sozinho quando esta máquina ligar.'
