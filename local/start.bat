@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Не найден Node.js. Установите его с https://nodejs.org и запустите файл снова. & pause & exit /b)
start "" http://localhost:8787
node server.js
pause
