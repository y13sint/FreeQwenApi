import express from 'express';
import bodyParser from 'body-parser';
import { fileURLToPath } from 'url';
import path from 'path';
import readline from 'readline';


import { initBrowser, shutdownBrowser } from './src/browser/browser.js';
import apiRoutes from './src/api/routes.js';
import { getAvailableModelsFromFile } from './src/api/chat.js';
import { initHistoryDirectory } from './src/api/chatHistory.js';
import { loadTokens } from './src/api/tokenManager.js';
import { interactiveAccountMenu, addAccountInteractive } from './src/utils/accountSetup.js';
import { logHttpRequest, logInfo, logError, logWarn } from './src/logger/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app = express();
const port = 3264;

function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(res => rl.question(question, ans => { rl.close(); res(ans.trim()); }));
}

let rl = null;

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

    process.exit(0);
}

async function startServer() {
    console.log(`
███████ ██████  ███████ ███████  ██████  ██     ██ ███████ ███    ██  █████  ██████  ██ 
██      ██   ██ ██      ██      ██    ██ ██     ██ ██      ████   ██ ██   ██ ██   ██ ██ 
█████   ██████  █████   █████   ██    ██ ██  █  ██ █████   ██ ██  ██ ███████ ██████  ██ 
██      ██   ██ ██      ██      ██ ▄▄ ██ ██ ███ ██ ██      ██  ██ ██ ██   ██ ██      ██ 
██      ██   ██ ███████ ███████  ██████   ███ ███  ███████ ██   ████ ██   ██ ██      ██ 
                                    ▀▀                                                    
   API-прокси для Qwen 
`);

    logInfo('Запуск сервера...');

    initHistoryDirectory();

    // Меню управления аккаунтами перед запуском прокси
    while (true) {
        const tokens = loadTokens();
        console.log('\nСписок аккаунтов:');
        if (!tokens.length) {
            console.log('  (пусто)');
        } else {
            tokens.forEach((t, i) => {
                let status = '✅ OK';
                const now = Date.now();
                if (t.invalid) status = '❌ INVALID';
                else if (t.resetAt && new Date(t.resetAt).getTime() > now) status = '⏳ WAIT';
                console.log(`${String(i + 1).padStart(2, ' ')} | ${t.id} | ${status}`);
            });
        }
        console.log('\n=== Меню ===');
        console.log('1 - Добавить новый аккаунт');
        console.log('2 - Перелогинить аккаунт с истекшим токеном');
        console.log('3 - Запустить прокси (по умолчанию)');
        console.log('4 - Удалить аккаунт');
        let choice = await prompt('Ваш выбор (Enter = 3): ');
        if (!choice) choice = '3';
        if (choice === '1') {
            await addAccountInteractive();
        } else if (choice === '2') {
            const { reloginAccountInteractive } = await import('./src/utils/accountSetup.js');
            await reloginAccountInteractive();
        } else if (choice === '3') {
            if (!tokens.length || !loadTokens().some(t => !t.invalid)) {
                console.log('Нужен хотя бы один валидный аккаунт для запуска.');
                continue;
            }
            break;
        } else if (choice === '4') {
            const { removeAccountInteractive } = await import('./src/utils/accountSetup.js');
            await removeAccountInteractive();
        }
    }

    //=====================================================================================================
    //const sim = await prompt('Смоделировать ошибку RateLimited для первого запроса? (y/N): ');
    //if (sim.toLowerCase() === 'y') {
    //    global.simulateRateLimit = true;
    // }
    //=====================================================================================================

    const browserInitialized = await initBrowser(false);
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
            logInfo('Доступно 18 моделей Qwen (через систему маппинга):');
            logInfo('- Стандартные: qwen-max, qwen-plus, qwen-turbo и их latest-версии');
            logInfo('- Coder: qwen-coder-plus, qwen2.5-coder-*b-instruct (0.5b - 32b)');
            logInfo('- Визуальные: qwen-vl-max, qwen-vl-plus и их latest-версии');
            logInfo('- Qwen 3: qwen3, qwen3-max, qwen3-plus');
            logInfo('======================================================');
            logInfo('Формат JSON запроса на чат:');
            logInfo('{ "message": "текст сообщения", "model": "название модели (опционально)", "chatId": "ID чата (опционально)" }');
            logInfo('Пример запроса: { "message": "Привет, как дела?" }');
            logInfo('Пример запроса с моделью: { "message": "Привет, как дела?", "model": "qwen-max" }');
            logInfo('Пример запроса с сохранением контекста: { "message": "Привет, как дела?", "chatId": "полученный_id_чата" }');
            logInfo('======================================================');
            logInfo('Поддержка OpenAI совместимого API: POST /api/chat/completions');
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

    process.exit(1);
});
