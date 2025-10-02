// routes.js - Модуль с маршрутами для API
import express from 'express';
import { sendMessage, getAllModels, getApiKeys, createChatV2 } from './chat.js';
import { getAuthenticationStatus } from '../browser/browser.js';
import { checkAuthentication } from '../browser/auth.js';
import { getBrowserContext } from '../browser/browser.js';
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

router.post('/chat', async (req, res) => {
    try {
        const { message, messages, model, chatId, parentId } = req.body;

        // Поддержка как message, так и messages для совместимости
        let messageContent = message;
        let systemMessage = null;

        // Если указан параметр messages (множественное число), используем его в приоритете
        if (messages && Array.isArray(messages)) {
            // Извлекаем system message если есть
            const systemMsg = messages.find(msg => msg.role === 'system');
            if (systemMsg) {
                systemMessage = systemMsg.content;
            }

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
        if (systemMessage) {
            logInfo(`System message: ${systemMessage.substring(0, 50)}${systemMessage.length > 50 ? '...' : ''}`);
        }
        if (chatId) {
            logInfo(`Используется chatId: ${chatId}, parentId: ${parentId || 'null'}`);
        }

        let mappedModel = model || "qwen-max-latest";
        if (model) {
            mappedModel = getMappedModel(model);
            if (mappedModel !== model) {
                logInfo(`Модель "${model}" заменена на "${mappedModel}"`);
            }
        }
        logInfo(`Используется модель: ${mappedModel}`);

        const result = await sendMessage(messageContent, mappedModel, chatId, parentId, null, null, null, systemMessage);

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

router.post('/chats', async (req, res) => {
    try {
        const { name, model } = req.body;
        const chatModel = model ? getMappedModel(model) : 'qwen-max-latest';
        logInfo(`Создание нового чата${name ? ` с именем: ${name}` : ''}, модель: ${chatModel}`);
        
        const result = await createChatV2(chatModel, name || "Новый чат");
        
        if (result.error) {
            logError(`Ошибка создания чата: ${result.error}`);
            return res.status(500).json({ error: result.error });
        }
        
        logInfo(`Создан новый чат v2 с ID: ${result.chatId}`);
        res.json({ chatId: result.chatId, success: true });
    } catch (error) {
        logError('Ошибка при создании чата', error);
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
        const { messages, model, stream, tools, functions, tool_choice, chatId, parentId } = req.body;

        logInfo(`Получен OpenAI-совместимый запрос${stream ? ' (stream)' : ''}`);

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            logError('Запрос без сообщений');
            return res.status(400).json({ error: 'Сообщения не указаны' });
        }

        // Извлекаем system message если есть
        const systemMsg = messages.find(msg => msg.role === 'system');
        const systemMessage = systemMsg ? systemMsg.content : null;

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

        if (systemMessage) {
            logInfo(`System message: ${systemMessage.substring(0, 50)}${systemMessage.length > 50 ? '...' : ''}`);
        }

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
                const combinedTools = tools || (functions ? functions.map(fn => ({ type: 'function', function: fn })) : null);
                const result = await sendMessage(messageContent, mappedModel, chatId, parentId, null, combinedTools, tool_choice, systemMessage);

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
                    const content = String(result.choices[0].message.content || '');

                    const codePoints = Array.from(content);
                    const chunkSize = 16;
                    for (let i = 0; i < codePoints.length; i += chunkSize) {
                        const chunk = codePoints.slice(i, i + chunkSize).join('');
                        writeSse({
                            id: 'chatcmpl-stream',
                            object: 'chat.completion.chunk',
                            created: Math.floor(Date.now() / 1000),
                            model: mappedModel || 'qwen-max-latest',
                            choices: [
                                { index: 0, delta: { content: chunk }, finish_reason: null }
                            ]
                        });

                        await new Promise(resolve => setTimeout(resolve, 20));
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
            const result = await sendMessage(messageContent, mappedModel, chatId, parentId, null, combinedTools, tool_choice, systemMessage);

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
                },
                chatId: result.chatId,
                parentId: result.parentId
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