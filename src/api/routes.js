// routes.js - Модуль с маршрутами для API
import express from 'express';
import { sendMessage, getAllModels } from './chat.js';
import { getAuthenticationStatus } from '../browser/browser.js';
import { checkAuthentication } from '../browser/auth.js';
import { getBrowserContext } from '../browser/browser.js';
import { getAllChats, loadHistory, createChat, deleteChat, chatExists, renameChat, deleteChatsAutomatically } from './chatHistory.js';
import { logInfo, logError, logDebug } from '../logger/index.js';

const router = express.Router();

// Маршрут для автоудаления чатов 
// (должен быть определен до маршрутов с параметрами, чтобы избежать конфликта с /:chatId)
router.post('/chats/cleanup', (req, res) => {
    try {
        logInfo(`Запрос на автоматическое удаление чатов: ${JSON.stringify(req.body)}`);
        const criteria = req.body || {};

        // Валидация входных параметров
        if (criteria.olderThan && (typeof criteria.olderThan !== 'number' || criteria.olderThan <= 0)) {
            logError(`Некорректное значение olderThan: ${criteria.olderThan}`);
            return res.status(400).json({ error: 'Некорректное значение olderThan' });
        }

        if (criteria.userMessageCountLessThan !== undefined &&
            (typeof criteria.userMessageCountLessThan !== 'number' || criteria.userMessageCountLessThan < 0)) {
            logError(`Некорректное значение userMessageCountLessThan: ${criteria.userMessageCountLessThan}`);
            return res.status(400).json({ error: 'Некорректное значение userMessageCountLessThan' });
        }

        if (criteria.messageCountLessThan !== undefined &&
            (typeof criteria.messageCountLessThan !== 'number' || criteria.messageCountLessThan < 0)) {
            logError(`Некорректное значение messageCountLessThan: ${criteria.messageCountLessThan}`);
            return res.status(400).json({ error: 'Некорректное значение messageCountLessThan' });
        }

        if (criteria.maxChats !== undefined &&
            (typeof criteria.maxChats !== 'number' || criteria.maxChats <= 0)) {
            logError(`Некорректное значение maxChats: ${criteria.maxChats}`);
            return res.status(400).json({ error: 'Некорректное значение maxChats' });
        }

        const result = deleteChatsAutomatically(criteria);
        logInfo(`Результат автоудаления: ${result.deletedCount} чатов удалено`);
        res.json(result);
    } catch (error) {
        logError('Ошибка при автоматическом удалении чатов', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.post('/chat', async (req, res) => {
    try {
        const { message, model, chatId } = req.body;

        if (!message) {
            logError('Запрос без сообщения');
            return res.status(400).json({ error: 'Сообщение не указано' });
        }

        logInfo(`Получен запрос: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);
        if (chatId) {
            logInfo(`Используется chatId: ${chatId}`);
        }
        if (model) {
            logInfo(`Используется модель: ${model}`);
        }

        const result = await sendMessage(message, model, chatId);

        // Проверяем наличие ответа и корректно логируем его
        if (result.choices && result.choices[0] && result.choices[0].message) {
            const responseLength = result.choices[0].message.content ? result.choices[0].message.content.length : 0;
            logInfo(`Ответ успешно сформирован для запроса, длина ответа: ${responseLength}`);
        } else if (result.error) {
            logInfo(`Получена ошибка в ответе: ${result.error}`);
        }

        res.json(result);
    } catch (error) {
        logError('Ошибка при обработке запроса', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/models', async (req, res) => {
    try {
        logInfo('Запрос на получение списка моделей');
        const models = getAllModels();
        logInfo(`Возвращено ${models.models.length} моделей`);
        res.json(models);
    } catch (error) {
        logError('Ошибка при получении списка моделей', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/status', async (req, res) => {
    try {
        logInfo('Запрос статуса авторизации');
        const browserContext = getBrowserContext();
        if (!browserContext) {
            logError('Браузер не инициализирован');
            return res.json({ authenticated: false, message: 'Браузер не инициализирован' });
        }

        if (getAuthenticationStatus()) {
            logInfo('Статус авторизации: активна (сохраненная сессия)');
            return res.json({
                authenticated: true,
                message: 'Авторизация активна (используется сохраненная сессия)'
            });
        }

        await checkAuthentication(browserContext);
        const isAuthenticated = getAuthenticationStatus();
        logInfo(`Статус авторизации: ${isAuthenticated ? 'активна' : 'требуется авторизация'}`);

        res.json({
            authenticated: isAuthenticated,
            message: isAuthenticated ? 'Авторизация активна' : 'Требуется авторизация'
        });
    } catch (error) {
        logError('Ошибка при проверке статуса авторизации', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.post('/chats', (req, res) => {
    try {
        const { name } = req.body;
        logInfo(`Создание нового чата${name ? ` с именем: ${name}` : ''}`);
        const chatId = createChat(name);
        logInfo(`Создан новый чат с ID: ${chatId}`);
        res.json({ chatId });
    } catch (error) {
        logError('Ошибка при создании чата', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/chats', (req, res) => {
    try {
        logInfo('Запрос списка чатов');
        const chats = getAllChats();
        logInfo(`Возвращено ${chats.length} чатов`);
        res.json({ chats });
    } catch (error) {
        logError('Ошибка при получении списка чатов', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.get('/chats/:chatId', (req, res) => {
    try {
        const { chatId } = req.params;
        logInfo(`Запрос истории чата: ${chatId}`);

        if (!chatId || !chatExists(chatId)) {
            logError(`Чат не найден: ${chatId}`);
            return res.status(404).json({ error: 'Чат не найден' });
        }

        const history = loadHistory(chatId);
        logInfo(`Возвращена история чата ${chatId}, ${history.messages?.length || 0} сообщений`);
        res.json({ chatId, history });
    } catch (error) {
        logError(`Ошибка при получении истории чата: ${req.params.chatId}`, error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.delete('/chats/:chatId', (req, res) => {
    try {
        const { chatId } = req.params;
        logInfo(`Запрос на удаление чата: ${chatId}`);

        if (!chatId || !chatExists(chatId)) {
            logError(`Чат не найден при попытке удаления: ${chatId}`);
            return res.status(404).json({ error: 'Чат не найден' });
        }

        const success = deleteChat(chatId);
        logInfo(`Чат ${chatId} ${success ? 'успешно удален' : 'не удален'}`);
        res.json({ success });
    } catch (error) {
        logError(`Ошибка при удалении чата: ${req.params.chatId}`, error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

router.put('/chats/:chatId/rename', (req, res) => {
    try {
        const { chatId } = req.params;
        const { name } = req.body;
        logInfo(`Запрос на переименование чата ${chatId} на "${name}"`);

        if (!chatId || !chatExists(chatId)) {
            logError(`Чат не найден при попытке переименования: ${chatId}`);
            return res.status(404).json({ error: 'Чат не найден' });
        }

        if (!name || typeof name !== 'string' || name.trim() === '') {
            logError(`Некорректное имя чата: "${name}"`);
            return res.status(400).json({ error: 'Имя чата не указано или некорректно' });
        }

        const success = renameChat(chatId, name.trim());
        logInfo(`Чат ${chatId} ${success ? 'успешно переименован' : 'не переименован'}`);
        res.json({ success, chatId, name: name.trim() });
    } catch (error) {
        logError(`Ошибка при переименовании чата: ${req.params.chatId}`, error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

export default router; 