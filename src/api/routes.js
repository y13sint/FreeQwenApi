// routes.js - Модуль с маршрутами для API
import express from 'express';
import { sendMessage, getAllModels, getApiKeys } from './chat.js';
import { getAuthenticationStatus } from '../browser/browser.js';
import { checkAuthentication } from '../browser/auth.js';
import { getBrowserContext } from '../browser/browser.js';
import { getAllChats, loadHistory, createChat, deleteChat, chatExists, renameChat, deleteChatsAutomatically, saveHistory } from './chatHistory.js';
import { logInfo, logError, logDebug } from '../logger/index.js';
import { getMappedModel } from './modelMapping.js';
import { getStsToken, uploadFileToQwen } from './fileUpload.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { listTokens, markInvalid, markRateLimited, markValid } from './tokenManager.js';
import { testToken } from './chat.js';

const router = express.Router();

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(process.cwd(), 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + crypto.randomBytes(8).toString('hex');
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB макс. размер
});

function authMiddleware(req, res, next) {
    const apiKeys = getApiKeys();

    if (apiKeys.length === 0) {
        return next();
    }

    const authHeader = req.headers.authorization;
    const apiKeyHeaderPrefix = 'Bearer ';

    if (!authHeader || !authHeader.startsWith(apiKeyHeaderPrefix)) {
        logError('Отсутствует или некорректный заголовок авторизации');
        return res.status(401).json({ error: 'Требуется авторизация' });
    }

    const token = authHeader.substring(apiKeyHeaderPrefix.length).trim();

    if (!apiKeys.includes(token)) {
        logError('Предоставлен недействительный API ключ');
        return res.status(401).json({ error: 'Недействительный токен' });
    }

    next();
}

router.use(authMiddleware);
router.use((req, res, next) => {
    req.url = req.url
        .replace(/\/v[12](?=\/|$)/g, '')
        .replace(/\/+/g, '/');
    next();
});

// Маршрут для автоудаления чатов 
// (должен быть определен до маршрутов с параметрами, чтобы избежать конфликта с /:chatId)
router.post('/chats/cleanup', (req, res) => {
    try {
        logInfo(`Запрос на автоматическое удаление чатов: ${JSON.stringify(req.body)}`);
        const criteria = req.body || {};

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

        let mappedModel = model;
        if (model) {
            mappedModel = getMappedModel(model);
            if (mappedModel !== model) {
                logInfo(`Модель "${model}" заменена на "${mappedModel}"`);
            }
            logInfo(`Используется модель: ${mappedModel}`);
        }

        const result = await sendMessage(messageContent, mappedModel, chatId);

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
        const modelsRaw = getAllModels();


        const openAiModels = {
            object: 'list',
            data: modelsRaw.models.map(m => ({
                id: m.id || m.name || m,
                object: 'model',
                created: 0,
                owned_by: 'openai',
                permission: []
            }))
        };

        logInfo(`Возвращено ${openAiModels.data.length} моделей (OpenAI формат)`);
        res.json(openAiModels);
    } catch (error) {
        logError('Ошибка при получении списка моделей', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});


router.get('/status', async (req, res) => {
    try {
        logInfo('Запрос статуса авторизации');


        const tokens = listTokens();
        const accounts = await Promise.all(tokens.map(async t => {
            const accInfo = { id: t.id, status: 'UNKNOWN', resetAt: t.resetAt || null };

            if (t.resetAt) {
                const resetTime = new Date(t.resetAt).getTime();
                if (resetTime > Date.now()) {
                    accInfo.status = 'WAIT';
                    return accInfo;
                }
            }

            const testResult = await testToken(t.token);
            if (testResult === 'OK') {
                accInfo.status = 'OK';
                if (t.invalid || t.resetAt) markValid(t.id);
            } else if (testResult === 'RATELIMIT') {
                accInfo.status = 'WAIT';
                markRateLimited(t.id, 24);
            } else if (testResult === 'UNAUTHORIZED') {
                accInfo.status = 'INVALID';
                if (!t.invalid) markInvalid(t.id);
            } else {
                accInfo.status = 'ERROR';
            }
            return accInfo;
        }));

        const browserContext = getBrowserContext();
        if (!browserContext) {
            logError('Браузер не инициализирован');
            return res.json({ authenticated: false, message: 'Браузер не инициализирован', accounts });
        }

        if (getAuthenticationStatus()) {
            return res.json({
                accounts
            });
        }

        await checkAuthentication(browserContext);
        const isAuthenticated = getAuthenticationStatus();
        logInfo(`Статус авторизации: ${isAuthenticated ? 'активна' : 'требуется авторизация'}`);

        res.json({
            authenticated: isAuthenticated,
            message: isAuthenticated ? 'Авторизация активна' : 'Требуется авторизация',
            accounts
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
        const { messages, model, stream, tools, functions, tool_choice } = req.body;

        logInfo(`Получен OpenAI-совместимый запрос${stream ? ' (stream)' : ''}`);

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

        let mappedModel = model ? getMappedModel(model) : "qwen-max-latest";
        if (model && mappedModel !== model) {
            logInfo(`Модель "${model}" заменена на "${mappedModel}"`);
        }
        logInfo(`Используется модель: ${mappedModel}`);

        if (stream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');

            const writeSse = (payload) => {
                res.write('data: ' + JSON.stringify(payload) + '\n\n');
            };

            writeSse({
                id: 'chatcmpl-stream',
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: mappedModel || 'qwen-max-latest',
                choices: [
                    { index: 0, delta: { role: 'assistant' }, finish_reason: null }
                ]
            });

            try {
                const result = await sendMessage(null, mappedModel, chatId);

                if (result.error) {
                    writeSse({
                        id: 'chatcmpl-stream',
                        object: 'chat.completion.chunk',
                        created: Math.floor(Date.now() / 1000),
                        model: mappedModel || 'qwen-max-latest',
                        choices: [
                            { index: 0, delta: { content: `Error: ${result.error}` }, finish_reason: null }
                        ]
                    });
                } else if (result.choices && result.choices[0] && result.choices[0].message) {
                    const content = result.choices[0].message.content || '';

                    const chunkSize = 8;
                    for (let i = 0; i < content.length; i += chunkSize) {
                        const chunk = content.substring(i, i + chunkSize);
                        writeSse({
                            id: 'chatcmpl-stream',
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: mappedModel || 'qwen-max-latest',
                            choices: [
                                { index: 0, delta: { content: chunk }, finish_reason: null }
                            ]
                        });

                        await new Promise(resolve => setTimeout(resolve, 10));
                    }
                }

                writeSse({
                    id: 'chatcmpl-stream',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || 'qwen-max-latest',
                    choices: [
                        { index: 0, delta: {}, finish_reason: 'stop' }
                    ]
                });
                res.write('data: [DONE]\n\n');
                res.end();

            } catch (error) {
                logError('Ошибка при обработке потокового запроса', error);
                writeSse({
                    id: 'chatcmpl-stream',
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: mappedModel || 'qwen-max-latest',
                    choices: [
                        { index: 0, delta: { content: 'Internal server error' }, finish_reason: 'stop' }
                    ]
                });
                res.write('data: [DONE]\n\n');
                res.end();
            }
        } else {
            const combinedTools = tools || (functions ? functions.map(fn => ({ type: 'function', function: fn })) : null);
            const result = await sendMessage(null, mappedModel, chatId, null, combinedTools, tool_choice);

            if (result.error) {
                return res.status(500).json({
                    error: { message: result.error, type: "server_error" }
                });
            }

            const openaiResponse = {
                id: result.id || "chatcmpl-" + Date.now(),
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: result.model || mappedModel || "qwen-max-latest",
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

// Новый маршрут для получения STS токена
router.post('/files/getstsToken', async (req, res) => {
    try {
        logInfo(`Запрос на получение STS токена: ${JSON.stringify(req.body)}`);

        const fileInfo = req.body;
        if (!fileInfo || !fileInfo.filename || !fileInfo.filesize || !fileInfo.filetype) {
            logError('Некорректные данные о файле');
            return res.status(400).json({ error: 'Некорректные данные о файле' });
        }

        const stsToken = await getStsToken(fileInfo);
        res.json(stsToken);
    } catch (error) {
        logError('Ошибка при получении STS токена', error);
        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

// Маршрут для загрузки файла - работает
router.post('/files/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            logError('Файл не был загружен');
            return res.status(400).json({ error: 'Файл не был загружен' });
        }

        logInfo(`Файл загружен на сервер: ${req.file.originalname} (${req.file.size} байт)`);

        // Загружаем файл в Qwen OSS хранилище
        const result = await uploadFileToQwen(req.file.path);

        // Удаляем временный файл после успешной загрузки
        fs.unlinkSync(req.file.path);

        if (result.success) {
            logInfo(`Файл успешно загружен в OSS: ${result.fileName}`);
            res.json({
                success: true,
                file: {
                    name: result.fileName,
                    url: result.url,
                    size: req.file.size,
                    type: req.file.mimetype
                }
            });
        } else {
            logError(`Ошибка при загрузке файла в OSS: ${result.error}`);
            res.status(500).json({ error: 'Ошибка при загрузке файла' });
        }
    } catch (error) {
        logError('Ошибка при загрузке файла', error);

        // Удаляем временный файл в случае ошибки
        if (req.file && req.file.path && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }

        res.status(500).json({ error: 'Внутренняя ошибка сервера' });
    }
});

export default router;