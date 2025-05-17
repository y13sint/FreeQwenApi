// routes.js - Модуль с маршрутами для API
import express from 'express';
import { sendMessage, getAllModels } from './chat.js';
import { getAuthenticationStatus } from '../browser/browser.js';
import { checkAuthentication } from '../browser/auth.js';
import { getBrowserContext } from '../browser/browser.js';

const router = express.Router();

router.post('/chat', async (req, res) => {
    try {
        const { message, model } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Сообщение не указано' });
        }

        console.log(`Получен запрос: ${message}`);

        const result = await sendMessage(message, model);
        res.json(result);
    } catch (error) {
        console.error('Ошибка при обработке запроса:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Эндпоинт для получения списка доступных моделей
router.get('/models', async (req, res) => {
    try {
        const models = getAllModels();
        res.json(models);
    } catch (error) {
        console.error('Ошибка при получении списка моделей:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/status', async (req, res) => {
    try {
        const browserContext = getBrowserContext();
        if (!browserContext) {
            return res.json({ authenticated: false, message: 'Браузер не инициализирован' });
        }

        if (!getAuthenticationStatus()) {
            await checkAuthentication(browserContext);
        }

        res.json({
            authenticated: getAuthenticationStatus(),
            message: getAuthenticationStatus() ? 'Авторизация активна' : 'Требуется авторизация'
        });
    } catch (error) {
        console.error('Ошибка при проверке статуса:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

export default router; 