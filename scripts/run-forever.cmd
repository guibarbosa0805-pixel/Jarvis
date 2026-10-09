@echo off
rem Mantém o painel/Jarvis de pé: se o processo cair, sobe de novo em 5s.
cd /d "%~dp0\.."
if not exist logs mkdir logs

:loop
echo [%date% %time%] iniciando painel >> logs\panel.log
node src\panel.js >> logs\panel.log 2>&1
echo [%date% %time%] painel encerrou (code %errorlevel%), reiniciando em 5s >> logs\panel.log
ping -n 6 127.0.0.1 >nul
goto loop
