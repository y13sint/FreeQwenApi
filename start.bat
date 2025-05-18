@echo off
chcp 65001 >nul
title Запуск Qwen API сервера

echo Проверка наличия Node.js...
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ОШИБКА] Node.js не установлен!
    echo Пожалуйста, установите Node.js с сайта https://nodejs.org/
    pause
    exit /b 1
)

echo Проверка наличия npm...
where npm >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ОШИБКА] npm не установлен!
    echo Пожалуйста, переустановите Node.js с сайта https://nodejs.org/
    pause
    exit /b 1
)

echo Установка зависимостей...
call npm install

if %ERRORLEVEL% neq 0 (
    echo [ОШИБКА] Не удалось установить зависимости!
    pause
    exit /b 1
)

echo.
echo Запуск приложения...
echo.

:: Запуск Node.js приложения
node index.js

pause 