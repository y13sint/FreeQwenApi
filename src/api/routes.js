// routes.js - Модуль с маршрутами для API
import express from 'express';
import { sendMessage, getAllModels } from './chat.js';
import { getAuthenticationStatus } from '../browser/browser.js';
import { checkAuthentication } from '../browser/auth.js';
import { getBrowserContext } from '../browser/browser.js';
import { getAllChats, loadHistory, createChat, deleteChat, chatExists, renameChat, deleteChatsAutomatically, saveHistory } from './chatHistory.js';
import { logInfo, logError, logDebug } from '../logger/index.js';
import crypto from 'crypto';

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
        const { message, messages, model, chatId } = req.body;

        // Поддержка как message, так и messages для совместимости
        let messageContent = message;

        // Если указан параметр messages (множественное число), используем его в приоритете
        if (messages && Array.isArray(messages)) {
            // Преобразуем формат messages в формат сообщения, понятный нашему прокси
            if (messages.length > 0) {
                const lastUserMessage = messages.filter(msg => msg.role === 'user').pop();
                if (lastUserMessage) {
                    if (Array.isArray(lastUserMessage.content)) {
                        messageContent = lastUserMessage.content;
                    } else {
                        messageContent = lastUserMessage.content;
                    }
                }
            }
        }

        if (!messageContent) {
            logError('Запрос без сообщения');
            return res.status(400).json({ error: 'Сообщение не указано' });
        }

        logInfo(`Получен запрос: ${typeof messageContent === 'string' ? messageContent.substring(0, 50) + (messageContent.length > 50 ? '...' : '') : 'Составное сообщение'}`);
        if (chatId) {
            logInfo(`Используется chatId: ${chatId}`);
        }
        if (model) {
            logInfo(`Используется модель: ${model}`);
        }

        const result = await sendMessage(messageContent, model, chatId);

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

router.post('/analyze/network', (req, res) => {
    try {
        return res.json({ success: true });
    } catch (error) {
        logError('Ошибка при анализе сети', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
})

router.post('/chat/completions', async (req, res) => {
    try {
        const { messages, model, stream} = req.body;

        logInfo(`Получен OpenAI-совместимый запрос${stream ? ' (stream)' : ''}`);
        logDebug(`Детали запроса /chat/completions: ${JSON.stringify({
            model: model,
            stream: stream,
            messages: messages
        }, null, 2)}`);

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            logError('Запрос без сообщений');
            return res.status(400).json({ error: 'Сообщения не указаны' });
        }

        const chatId = createChat("OpenAI API Chat");
        logInfo(`Создан новый чат с ID: ${chatId} для запроса /chat/completions`);
        

        
        let historyTransferred = false;
        try {
            logInfo(`Перенос истории сообщений из запроса в чат ${chatId}`);
            const chatData = loadHistory(chatId);
            
            for (const msg of messages) {
                const timestamp = Math.floor(Date.now() / 1000);
                const messageId = crypto.randomUUID();
                
                const formattedMessage = {
                    id: messageId,
                    role: msg.role,
                    content: msg.content,
                    timestamp: timestamp,
                    chat_type: "t2t"
                };
                
                chatData.messages.push(formattedMessage);
                logDebug(`Добавлено сообщение с ролью "${msg.role}" в историю чата ${chatId}`);
            }
            
            saveHistory(chatId, chatData);
            historyTransferred = true;
            logInfo(`История из ${messages.length} сообщений успешно перенесена в чат ${chatId}`);
        } catch (error) {
            logError(`Ошибка при переносе истории в чат ${chatId}`, error);
        }
        
        const lastUserMessage = messages.filter(msg => msg.role === 'user').pop();
        if (!lastUserMessage) {
            logError('В запросе нет сообщений от пользователя');
            return res.status(400).json({ error: 'В запросе нет сообщений от пользователя' });
        }

        const messageContent = lastUserMessage.content;

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.write('data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":' + Math.floor(Date.now() / 1000) + ',"model":"' + (model || "qwen-max-latest") + '","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n');

            try {
                const result = await sendMessage(messageContent, model, chatId);

                if (result.error) {
                    res.write('data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":' + Math.floor(Date.now() / 1000) + ',"model":"' + (model || "qwen-max-latest") + '","choices":[{"index":0,"delta":{"content":"Error: ' + result.error + '"},"finish_reason":null}]}\n\n');
                } else if (result.choices && result.choices[0] && result.choices[0].message) {
                    const content = result.choices[0].message.content || '';


                    const chunkSize = 8;
                    for (let i = 0; i < content.length; i += chunkSize) {
                        const chunk = content.substring(i, i + chunkSize);
                        res.write('data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":' + Math.floor(Date.now() / 1000) + ',"model":"' + (model || "qwen-max-latest") + '","choices":[{"index":0,"delta":{"content":"' + chunk.replace(/\n/g, "\\n").replace(/"/g, '\\"') + '"},"finish_reason":null}]}\n\n');

                        await new Promise(resolve => setTimeout(resolve, 10));
                    }
                }

                res.write('data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":' + Math.floor(Date.now() / 1000) + ',"model":"' + (model || "qwen-max-latest") + '","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n');
                res.write('data: [DONE]\n\n');
                res.end();

            } catch (error) {
                logError('Ошибка при обработке потокового запроса', error);
                res.write('data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":' + Math.floor(Date.now() / 1000) + ',"model":"' + (model || "qwen-max-latest") + '","choices":[{"index":0,"delta":{"content":"Internal server error"},"finish_reason":"stop"}]}\n\n');
                res.write('data: [DONE]\n\n');
                res.end();
            }
        } else {
            const result = await sendMessage(messageContent, model, chatId);

            if (result.error) {
                return res.status(500).json({
                    error: { message: result.error, type: "server_error" }
                });
            }


            const openaiResponse = {
                id: result.id || "chatcmpl-" + Date.now(),
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: result.model || model || "qwen-max-latest",
                choices: result.choices || [{
                    index: 0,
                    message: {
                        role: "assistant",
                        content: result.choices?.[0]?.message?.content || ""
                    },
                    finish_reason: "stop"
                }],
                usage: result.usage || {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0
                }
            };

            res.json(openaiResponse);
        }
    } catch (error) {
        logError('Ошибка при обработке запроса', error);
        res.status(500).json({ error: { message: 'Внутренняя ошибка сервера', type: "server_error" } });
    }
});

export default router;