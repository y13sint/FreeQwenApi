// routes.js - Модуль с маршрутами для API
import express from 'express';
import { sendMessage, listModels } from './chat.js';
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
        const browserContext = getBrowserContext();
        if (!browserContext) {
            return res.status(500).json({ error: 'Браузер не инициализирован' });
        }

        const models = await listModels(browserContext);
        if (models) {
            res.json(models);
        } else {
            res.status(404).json({ error: 'Не удалось получить список моделей' });
        }
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