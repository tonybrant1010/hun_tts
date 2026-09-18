@echo off
cd /d "%~dp0"
echo Felolvaso helyi teszt: http://localhost:3000  (ablak bezarasa = leallitas)
start "" cmd /c "timeout /t 5 >nul & start http://localhost:3000"
call npx --yes serve -l 3000 .
