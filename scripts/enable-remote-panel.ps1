# Roda no SERVIDOR, em um PowerShell como Administrador (depois de "git pull" em C:\jarvis).
# Libera o painel pela rede local, protegido por senha, e reinicia o Jarvis.
param([string]$InstallDir = 'C:\jarvis', [int]$Port = 4545)
$ErrorActionPreference = 'Stop'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Abra o PowerShell como Administrador e rode de novo.' }

$secure = Read-Host 'Escolha uma senha pro painel (8+ caracteres: letras, números e ! @ % ^ * _ + = . , -)' -AsSecureString
$password = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if ($password -notmatch '^[A-Za-z0-9!@%^*_+=.,-]{8,}$') { throw 'Senha inválida: use 8+ caracteres, só os permitidos acima.' }

Set-Content -Path "$InstallDir\panel.env" -Value "PANEL_HOST=0.0.0.0`r`nPANEL_PASSWORD=$password`r`nPANEL_PORT=$Port" -Encoding ASCII

Remove-NetFirewallRule -DisplayName 'Jarvis painel' -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName 'Jarvis painel' -Direction Inbound -Protocol TCP -LocalPort $Port `
  -Action Allow -RemoteAddress LocalSubnet -Profile Any | Out-Null

Stop-ScheduledTask -TaskName 'Jarvis' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'src.panel' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 3
Start-ScheduledTask -TaskName 'Jarvis'
Start-Sleep -Seconds 12

$ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^(127|169\.254)\.' } | Select-Object -First 1).IPAddress
Write-Host "Pronto. Abra no navegador de outro computador da rede: http://${ip}:$Port"
Write-Host 'Usuário: qualquer um (ex: admin). Senha: a que você acabou de escolher.'
