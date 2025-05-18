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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app = express();
const port = 3264;

// Создаем интерфейс readline для взаимодействия с пользователем
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

app.use(bodyParser.json());


app.use('/api', apiRoutes);


process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
process.on('SIGHUP', handleShutdown);

process.on('uncaughtException', async (error) => {
    console.error('Необработанное исключение:', error);
    await handleShutdown();
});

async function handleShutdown() {
    console.log('\nПолучен сигнал завершения. Закрываем браузер...');
    await shutdownBrowser();
    console.log('Завершение работы.');

    // Закрываем readline интерфейс, если он открыт
    if (rl) {
        rl.close();
    }

    process.exit(0);
}

// Функция для запроса режима запуска у пользователя
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
                    console.log('\nЗапуск сервера с сохраненной сессией...\n');
                } else {
                    console.log('\nЗапуск сервера с новой авторизацией...\n');
                }

                // Для initBrowser: true - видимый режим (ручная авторизация), false - невидимый (использовать сессию)
                resolve(!useSavedSession);
            });
        } else {
            console.log('\nСохраненная сессия не найдена, выполняется запуск с новой авторизацией...\n');
            // Если сессии нет, запускаем в видимом режиме (для ручной авторизации)
            resolve(true);
        }
    });
}

async function startServer() {
    console.log('Запуск сервера...');

    // Инициализируем директорию для истории чатов
    initHistoryDirectory();

    // Запрашиваем режим запуска
    const visibleMode = await promptLaunchMode();

    // Закрываем readline интерфейс после выбора
    rl.close();

    const browserInitialized = await initBrowser(visibleMode);
    if (!browserInitialized) {
        console.error('Не удалось инициализировать браузер. Завершение работы.');
        process.exit(1);
    }

    try {
        app.listen(port, () => {
            console.log(`Сервер запущен на порту ${port}`);
            console.log(`API доступен по адресу: http://localhost:${port}/api`);
            console.log('Для проверки статуса авторизации: GET /api/status');
            console.log('Для отправки сообщения: POST /api/chat');
            console.log('Для получения списка моделей: GET /api/models');
            console.log('======================================================');
            console.log('Управление чатами:');
            console.log('Создать новый чат: POST /api/chats');
            console.log('Получить список чатов: GET /api/chats');
            console.log('Получить историю чата: GET /api/chats/:chatId');
            console.log('Удалить чат: DELETE /api/chats/:chatId');
            console.log('======================================================');
            console.log('Формат JSON запроса на чат:');
            console.log('{ "message": "текст сообщения", "model": "название модели (опционально)", "chatId": "ID чата (опционально)" }');
            console.log('Пример запроса: { "message": "Привет, как дела?" }');
            console.log('Пример запроса с сохранением контекста: { "message": "Привет, как дела?", "chatId": "полученный_id_чата" }');
            console.log('======================================================');

            // Загружаем и выводим список доступных моделей при запуске
            getAvailableModelsFromFile();
        });
    } catch (err) {
        if (err.code === 'EADDRINUSE') {
            console.error(`Порт ${port} уже используется. Возможно, сервер уже запущен.`);
            console.error('Завершите работу существующего сервера или используйте другой порт.');
            await shutdownBrowser();
            process.exit(1);
        } else {
            throw err;
        }
    }
}

startServer().catch(async error => {
    console.error('Ошибка при запуске сервера:', error);
    await shutdownBrowser();

    // Закрываем readline интерфейс в случае ошибки
    if (rl) {
        rl.close();
    }

    process.exit(1);
});