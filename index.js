import express from 'express';
import bodyParser from 'body-parser';
import { fileURLToPath } from 'url';
import path from 'path';
import readline from 'readline';


import { initBrowser, shutdownBrowser } from './src/browser/browser.js';
import apiRoutes from './src/api/routes.js';
import { getAvailableModelsFromFile, getApiKeys } from './src/api/chat.js';
import { initHistoryDirectory } from './src/api/chatHistory.js';
import { loadTokens } from './src/api/tokenManager.js';
import { addAccountInteractive } from './src/utils/accountSetup.js';
import { logHttpRequest, logInfo, logError, logWarn } from './src/logger/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app = express();

const DEFAULT_PORT = 3264;
const port = Number.parseInt(process.env.PORT ?? DEFAULT_PORT, 10);
const host = process.env.HOST || '0.0.0.0';

if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error(`Некорректное значение переменной PORT: ${process.env.PORT}`);
}

const skipAccountMenu = toBoolean(process.env.SKIP_ACCOUNT_MENU) || toBoolean(process.env.NON_INTERACTIVE);

function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(res => rl.question(question, ans => { rl.close(); res(ans.trim()); }));
}

function toBoolean(value) {
    if (typeof value !== 'string') return false;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function ensureNonInteractiveTokens() {
    const tokens = loadTokens();
    if (!tokens.length) {
        logError('Не найдено ни одного аккаунта. Запустите скрипт авторизации перед запуском сервера.');
        process.exit(1);
    }

    const now = Date.now();
    const validTokens = tokens.filter(t => (!t.resetAt || new Date(t.resetAt).getTime() <= now) && !t.invalid);

    if (!validTokens.length) {
        logError('Все аккаунты недоступны. Перезапустите авторизацию перед запуском сервера.');
        process.exit(1);
    }

    logInfo(`Автоматический запуск: обнаружено ${tokens.length} аккаунтов, из них ${validTokens.length} активны.`);
}

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

    if (!skipAccountMenu) {
        // Меню управления аккаунтами перед запуском прокси
        while (true) {
            const tokens = loadTokens();
            console.log('\nСписок аккаунтов:');
            if (!tokens.length) {
                console.log('  (пусто)');
            } else {
                tokens.forEach((token, i) => {
                    const now = Date.now();
                    const isInvalid = token.invalid === true;
                    const isWaiting = Boolean(token.resetAt && new Date(token.resetAt).getTime() > now);
                    const statusCode = isInvalid ? 0 : isWaiting ? 1 : 2;
                    const statusLabel = isInvalid ? '❌ Недействителен' : isWaiting ? '⏳ Ожидание сброса' : '✅ OK';
                    console.log(`${String(i + 1).padStart(2, ' ')} | ${token.id} | ${statusLabel} (${statusCode})`);
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
                const hasValidToken = tokens.some(token => {
                    if (token.invalid) return false;
                    if (!token.resetAt) return true;
                    return new Date(token.resetAt).getTime() <= Date.now();
                });

                if (!tokens.length || !hasValidToken) {
                    console.log('Нужен хотя бы один валидный аккаунт для запуска.');
                    continue;
                }
                break;
            } else if (choice === '4') {
                const { removeAccountInteractive } = await import('./src/utils/accountSetup.js');
                await removeAccountInteractive();
            }
        }
    } else {
        ensureNonInteractiveTokens();
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
        app.listen(port, host, () => {
            const displayHost = host === '0.0.0.0' ? 'localhost' : host;
            logInfo(`Сервер запущен на ${host}:${port}`);
            logInfo(`API доступен по адресу: http://${displayHost}:${port}/api`);
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
            logInfo('Доступно 19 моделей Qwen (через систему маппинга):');
            logInfo('- Стандартные: qwen-max, qwen-plus, qwen-turbo и их latest-версии');
            logInfo('- Coder: qwen3-coder-plus, qwen2.5-coder-*b-instruct (0.5b - 32b)');
            logInfo('- Визуальные: qwen-vl-max, qwen-vl-plus и их latest-версии');
            logInfo('- Qwen 3: qwen3, qwen3-max, qwen3-plus, qwen3-omni-flash');
            logInfo('======================================================');
            logInfo('Формат JSON запроса на чат:');
            logInfo('{ "message": "текст сообщения", "model": "название модели (опционально)", "chatId": "ID чата (опционально)" }');
            logInfo('Пример запроса: { "message": "Привет, как дела?" }');
            logInfo('Пример запроса с моделью: { "message": "Привет, как дела?", "model": "qwen-max" }');
            logInfo('Пример запроса с сохранением контекста: { "message": "Привет, как дела?", "chatId": "полученный_id_чата" }');
            logInfo('======================================================');
            logInfo('Поддержка OpenAI совместимого API: POST /api/chat/completions');
            logInfo('======================================================');


            getApiKeys();

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
