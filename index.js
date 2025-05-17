import express from 'express';
import bodyParser from 'body-parser';
import { fileURLToPath } from 'url';
import path from 'path';


import { initBrowser, shutdownBrowser } from './src/browser/browser.js';
import apiRoutes from './src/api/routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


const app = express();
const port = 3000;


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
    process.exit(0);
}

async function startServer() {
    console.log('Запуск сервера...');

    const browserInitialized = await initBrowser();
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
            console.log('Формат JSON запроса: { "message": "текст сообщения"}');
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
    process.exit(1);
});