// routes.js - Модуль с маршрутами для API
import express from 'express';
import { sendMessage, getAllModels } from './chat.js';
import { getAuthenticationStatus } from '../browser/browser.js';
import { checkAuthentication } from '../browser/auth.js';
import { getBrowserContext } from '../browser/browser.js';
import { getAllChats, loadHistory, createChat, deleteChat, chatExists, renameChat, deleteChatsAutomatically } from './chatHistory.js';

const router = express.Router();

router.post('/chat', async (req, res) => {
    try {
        const { message, model, chatId } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Сообщение не указано' });
        }

        console.log(`Получен запрос: ${message}`);
        if (chatId) {
            console.log(`Используется chatId: ${chatId}`);
        }

        const result = await sendMessage(message, model, chatId);
        res.json(result);
    } catch (error) {
        console.error('Ошибка при обработке запроса:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

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

        if (getAuthenticationStatus()) {
            return res.json({
                authenticated: true,
                message: 'Авторизация активна (используется сохраненная сессия)'
            });
        }

        await checkAuthentication(browserContext);

        res.json({
            authenticated: getAuthenticationStatus(),
            message: getAuthenticationStatus() ? 'Авторизация активна' : 'Требуется авторизация'
        });
    } catch (error) {
        console.error('Ошибка при проверке статуса:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});


router.post('/chats', (req, res) => {
    try {
        const { name } = req.body;
        const chatId = createChat(name);
        res.json({ chatId });
    } catch (error) {
        console.error('Ошибка при создании чата:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/chats', (req, res) => {
    try {
        const chats = getAllChats();
        res.json({ chats });
    } catch (error) {
        console.error('Ошибка при получении списка чатов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/chats/:chatId', (req, res) => {
    try {
        const { chatId } = req.params;

        if (!chatId || !chatExists(chatId)) {
            return res.status(404).json({ error: 'Чат не найден' });
        }

        const history = loadHistory(chatId);
        res.json({ chatId, history });
    } catch (error) {
        console.error('Ошибка при получении истории чата:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.delete('/chats/:chatId', (req, res) => {
    try {
        const { chatId } = req.params;

        if (!chatId || !chatExists(chatId)) {
            return res.status(404).json({ error: 'Чат не найден' });
        }

        const success = deleteChat(chatId);
        res.json({ success });
    } catch (error) {
        console.error('Ошибка при удалении чата:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Новый маршрут для переименования чата
router.put('/chats/:chatId/rename', (req, res) => {
    try {
        const { chatId } = req.params;
        const { name } = req.body;

        if (!chatId || !chatExists(chatId)) {
            return res.status(404).json({ error: 'Чат не найден' });
        }

        if (!name || typeof name !== 'string' || name.trim() === '') {
            return res.status(400).json({ error: 'Имя чата не указано или некорректно' });
        }

        const success = renameChat(chatId, name.trim());
        res.json({ success, chatId, name: name.trim() });
    } catch (error) {
        console.error('Ошибка при переименовании чата:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Новый маршрут для автоудаления чатов
router.post('/chats/cleanup', (req, res) => {
    try {
        const criteria = req.body || {};

        // Валидация входных параметров
        if (criteria.olderThan && (typeof criteria.olderThan !== 'number' || criteria.olderThan <= 0)) {
            return res.status(400).json({ error: 'Некорректное значение olderThan' });
        }

        if (criteria.userMessageCountLessThan !== undefined &&
            (typeof criteria.userMessageCountLessThan !== 'number' || criteria.userMessageCountLessThan < 0)) {
            return res.status(400).json({ error: 'Некорректное значение userMessageCountLessThan' });
        }

        if (criteria.messageCountLessThan !== undefined &&
            (typeof criteria.messageCountLessThan !== 'number' || criteria.messageCountLessThan < 0)) {
            return res.status(400).json({ error: 'Некорректное значение messageCountLessThan' });
        }

        if (criteria.maxChats !== undefined &&
            (typeof criteria.maxChats !== 'number' || criteria.maxChats <= 0)) {
            return res.status(400).json({ error: 'Некорректное значение maxChats' });
        }

        const result = deleteChatsAutomatically(criteria);
        res.json(result);
    } catch (error) {
        console.error('Ошибка при автоматическом удалении чатов:', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

export default router; 