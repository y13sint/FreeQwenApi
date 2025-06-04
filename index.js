import express from 'express';
import bodyParser from 'body-parser';
import { fileURLToPath } from 'url';
import path from 'path';
import readline from 'readline';


import { initBrowser, shutdownBrowser } from './src/browser/browser.js';
import apiRoutes from './src/api/routes.js';
import { getAvailableModelsFromFile } from './src/api/chat.js';
import { initHistoryDirectory } from './src/api/chatHistory.js';
import { hasSession } from './src/browser/session.js';
import { logHttpRequest, logInfo, logError, logWarn } from './src/logger/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app = express();
const port = 3264;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Middleware для логирования HTTP-запросов
app.use(logHttpRequest);

app.use(bodyParser.json({ limit: '150mb' }));
app.use(bodyParser.urlencoded({ limit: '150mb', extended: true }));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }

    next();
});

app.use('/api', apiRoutes);

// Обработчик 404
app.use((req, res) => {
    logWarn(`404 Not Found: ${req.method} ${req.originalUrl}`);
    res.status(404).json({ error: 'Эндпоинт не найден' });
});

// Обработчик ошибок
app.use((err, req, res, next) => {
    logError('Внутренняя ошибка сервера', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
});

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
process.on('SIGHUP', handleShutdown);

process.on('uncaughtException', async (error) => {
    logError('Необработанное исключение', error);
    await handleShutdown();
});

async function handleShutdown() {
    logInfo('\nПолучен сигнал завершения. Закрываем браузер...');
    await shutdownBrowser();
    logInfo('Завершение работы.');

    if (rl) {
        rl.close();
    }

    process.exit(0);
}

function promptLaunchMode() {
    return new Promise((resolve) => {
        if (hasSession()) {
            console.log('\n[НАЙДЕНА СОХРАНЕННАЯ СЕССИЯ]');
            console.log('\nВыберите режим запуска:');
            console.log('1 - Использовать сохраненную сессию (без повторной авторизации)');
            console.log('2 - Запустить с новой авторизацией');

            rl.question('\nВаш выбор (1/2, по умолчанию 1): ', (answer) => {
                const useSavedSession = answer !== '2';

                if (useSavedSession) {
                    logInfo('\nЗапуск сервера с сохраненной сессией...\n');
                } else {
                    logInfo('\nЗапуск сервера с новой авторизацией...\n');
                }

                resolve(!useSavedSession);
            });
        } else {
            logInfo('\nСохраненная сессия не найдена, выполняется запуск с новой авторизацией...\n');
            resolve(true);
        }
    });
}

async function startServer() {
    logInfo('Запуск сервера...');

    initHistoryDirectory();

    const visibleMode = await promptLaunchMode();

    rl.close();

    const browserInitialized = await initBrowser(visibleMode);
    if (!browserInitialized) {
        logError('Не удалось инициализировать браузер. Завершение работы.');
        process.exit(1);
    }

    try {
        app.listen(port, () => {
            logInfo(`Сервер запущен на порту ${port}`);
            logInfo(`API доступен по адресу: http://localhost:${port}/api`);
            logInfo('Для проверки статуса авторизации: GET /api/status');
            logInfo('Для отправки сообщения: POST /api/chat');
            logInfo('Для получения списка моделей: GET /api/models');
            logInfo('======================================================');
            logInfo('Управление чатами:');
            logInfo('Создать новый чат: POST /api/chats');
            logInfo('Получить список чатов: GET /api/chats');
            logInfo('Получить историю чата: GET /api/chats/:chatId');
            logInfo('Удалить чат: DELETE /api/chats/:chatId');
            logInfo('Переименовать чат: PUT /api/chats/:chatId/rename');
            logInfo('Автоудаление чатов: POST /api/chats/cleanup');
            logInfo('======================================================');
            logInfo('Формат JSON запроса на чат:');
            logInfo('{ "message": "текст сообщения", "model": "название модели (опционально)", "chatId": "ID чата (опционально)" }');
            logInfo('Пример запроса: { "message": "Привет, как дела?" }');
            logInfo('Пример запроса с сохранением контекста: { "message": "Привет, как дела?", "chatId": "полученный_id_чата" }');
            logInfo('======================================================');

            getAvailableModelsFromFile();
        });
    } catch (err) {
        if (err.code === 'EADDRINUSE') {
            logError(`Порт ${port} уже используется. Возможно, сервер уже запущен.`);
            logError('Завершите работу существующего сервера или используйте другой порт.');
            await shutdownBrowser();
            process.exit(1);
        } else {
            throw err;
        }
    }
}

startServer().catch(async error => {
    logError('Ошибка при запуске сервера:', error);
    await shutdownBrowser();

    if (rl) {
        rl.close();
    }

    process.exit(1);
});
