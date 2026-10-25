@echo off
rem Baixa o codigo do GitHub por cima desta pasta (sem mexer em node_modules, bin e models) e reinicia o motor.
rem Uso: atualizar.bat [commit]   (sem argumento usa a main)
set SHA=%1
if "%SHA%"=="" set SHA=main
set T=%TEMP%\autoedit-update
rmdir /s /q "%T%" 2>nul
mkdir "%T%"
curl -sfL -o "%T%\src.zip" https://codeload.github.com/ronaldofcordeiro-ship-it/autoedit/zip/%SHA% || (echo Falha ao baixar & exit /b 1)
tar -xf "%T%\src.zip" -C "%T%"
for /d %%d in ("%T%\autoedit-*") do robocopy "%%d" "%~dp0." /E /NFL /NDL /NJH /NJS /XD node_modules bin models >nul
echo %SHA%> "%~dp0versao.txt"
call "%~dp0reiniciar-motor.bat"
