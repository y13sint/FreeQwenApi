@echo off
setlocal EnableDelayedExpansion
:: Остановим все процессы VSCode
echo Останавливаю Visual Studio Code...
taskkill /im "Code.exe" /f >nul 2>&1

:: Путь к файлу extension.js — автоматически определяем из профиля пользователя
set USERPROFILE=%USERPROFILE%
set EXT_PATH=%USERPROFILE%\.vscode\extensions\saoudrizwan.claude-dev-3.17.8\dist\extension.js

:: Проверяем, существует ли файл
if not exist "%EXT_PATH%" (
    echo Файл не найден: "%EXT_PATH%"
    echo Введите полный путь к файлу extension.js:
    set /p EXT_PATH=
    if not exist "!EXT_PATH!" (
        echo Файл не найден: "!EXT_PATH!"
        pause
        exit /b 1
    )
)

:: Делаем бэкап, если его ещё нет
if not exist "%EXT_PATH%-" (
    echo Делаю резервную копию...
    copy "%EXT_PATH%" "%EXT_PATH%-" >nul
) else (
    echo Восстанавливаю из резервной копии...
    copy /Y "%EXT_PATH%-" "%EXT_PATH%" >nul
)

:: Замена строки в файле
echo Меняю URL API на http://localhost:3264/api
powershell -Command "(Get-Content '%EXT_PATH%') -replace 'https://dashscope.aliyuncs.com/compatible-mode/v1',  'http://localhost:3264/api' | Set-Content '%EXT_PATH%'"

:: Определение пути к VS Code
set VSCODE_PATH=C:\Users\%USERNAME%\AppData\Local\Programs\Microsoft VS Code\Code.exe
if not exist "%VSCODE_PATH%" (
    set VSCODE_PATH=C:\Program Files\Microsoft VS Code\Code.exe
    if not exist "%VSCODE_PATH%" (
        set VSCODE_PATH=C:\Program Files (x86)\Microsoft VS Code\Code.exe
        if not exist "%VSCODE_PATH%" (
            echo VS Code не найден по стандартным путям.
            echo Введите полный путь к Code.exe:
            set /p VSCODE_PATH=
        )
    )
)

:: Перезапускаем VSCode
echo Перезапускаю Visual Studio Code...
start "" "%VSCODE_PATH%"

echo Готово!
pause