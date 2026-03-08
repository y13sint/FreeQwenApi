import { getBrowserContext, getAuthenticationStatus, setAuthenticationStatus } from '../browser/browser.js';
import { checkAuthentication } from '../browser/auth.js';
import { checkVerification } from '../browser/auth.js';
import { shutdownBrowser, initBrowser } from '../browser/browser.js';
import { saveAuthToken } from '../browser/session.js';
import { getAvailableToken, markRateLimited, removeInvalidToken } from './tokenManager.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logRaw } from '../logger/index.js';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHAT_API_URL_V2 = 'https://chat.qwen.ai/api/v2/chat/completions';
const CREATE_CHAT_URL = 'https://chat.qwen.ai/api/v2/chats/new';
const CHAT_PAGE_URL = 'https://chat.qwen.ai/';

const MODELS_FILE = path.join(__dirname, '..', 'AvaibleModels.txt');
const AUTH_KEYS_FILE = path.join(__dirname, '..', 'Authorization.txt');

let authToken = null;
let availableModels = null;
let authKeys = null;

// requestId -> onChunk handler for streaming callbacks from the browser context
const streamHandlers = new Map();
const chunkExposedPages = new WeakSet();

// chatId -> promise chain (serialize requests per Qwen chat to avoid "The chat is in progress!")
const chatRequestQueue = new Map();

function enqueueChatTask(chatId, task) {
    const key = String(chatId);
    const prev = chatRequestQueue.get(key) || Promise.resolve();
    const next = prev
        .catch(() => undefined)
        .then(task);

    chatRequestQueue.set(key, next);
    next.finally(() => {
        if (chatRequestQueue.get(key) === next) {
            chatRequestQueue.delete(key);
        }
    });

    return next;
}

function normalizeCompositeMessageParts(parts) {
    if (!Array.isArray(parts)) return null;

    const normalized = [];

    for (const part of parts) {
        if (!part || typeof part !== 'object') return null;

        const type = part.type;

        if (type === 'text' && typeof part.text === 'string') {
            normalized.push({ type: 'text', text: part.text });
            continue;
        }

        // Native proxy format
        if (type === 'image' && typeof part.image === 'string') {
            normalized.push({ type: 'image', image: part.image });
            continue;
        }
        if (type === 'file' && typeof part.file === 'string') {
            normalized.push({ type: 'file', file: part.file });
            continue;
        }

        // OpenAI-style content parts (multimodal)
        if (type === 'image_url') {
            const url = (typeof part.image_url === 'string')
                ? part.image_url
                : part.image_url?.url;

            if (typeof url !== 'string') return null;
            normalized.push({ type: 'image', image: url });
            continue;
        }

        // Some clients use "input_image"
        if (type === 'input_image') {
            const url = part.image?.url ?? part.image_url?.url ?? part.image_url ?? part.url ?? part.image;
            if (typeof url !== 'string') return null;
            normalized.push({ type: 'image', image: url });
            continue;
        }

        // Best-effort "input_file" support
        if (type === 'input_file') {
            const file = part.file_id ?? part.file?.id ?? part.file;
            if (typeof file !== 'string') return null;
            normalized.push({ type: 'file', file });
            continue;
        }

        return null;
    }

    return normalized;
}

export const pagePool = {
    pages: [],
    maxSize: 3,

    async getPage(context) {
        if (this.pages.length > 0) {
            return this.pages.pop();
        }

        const newPage = await context.newPage();
        await newPage.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

        if (!authToken) {
            try {
                authToken = await newPage.evaluate(() => localStorage.getItem('token'));
                console.log('Токен авторизации получен из браузера');

                if (authToken) {
                    saveAuthToken(authToken);
                }
            } catch (e) {
                console.error('Ошибка при получении токена авторизации:', e);
            }
        }

        return newPage;
    },


    releasePage(page) {
        if (this.pages.length < this.maxSize) {
            this.pages.push(page);
        } else {
            page.close().catch(e => console.error('Ошибка при закрытии страницы:', e));
        }
    },

    async clear() {
        for (const page of this.pages) {
            try {
                await page.close();
            } catch (e) {
                console.error('Ошибка при закрытии страницы в пуле:', e);
            }
        }
        this.pages = [];
    }
};

export async function extractAuthToken(context, forceRefresh = false) {
    if (authToken && !forceRefresh) {
        return authToken;
    }

    try {
        const page = await context.newPage();
        await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });

        const newToken = await page.evaluate(() => localStorage.getItem('token'));

        await page.close();

        if (newToken) {
            authToken = newToken;
            console.log('Токен авторизации успешно извлечен');
            saveAuthToken(authToken);
            return authToken;
        } else {
            console.error('Токен авторизации не найден в браузере');
            return null;
        }
    } catch (error) {
        console.error('Ошибка при извлечении токена авторизации:', error);
        return null;
    }
}

export function getAvailableModelsFromFile() {
    try {
        if (!fs.existsSync(MODELS_FILE)) {
            console.error(`Файл с моделями не найден: ${MODELS_FILE}`);
            return ['qwen-max-latest'];
        }

        const fileContent = fs.readFileSync(MODELS_FILE, 'utf8');
        const models = fileContent.split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'));

        console.log('===== ДОСТУПНЫЕ МОДЕЛИ =====');
        models.forEach(model => console.log(`- ${model}`));
        console.log('============================');

        return models;
    } catch (error) {
        console.error('Ошибка при чтении файла с моделями:', error);
        return ['qwen-max-latest'];
    }
}

function getAuthKeysFromFile() {
    try {
        if (!fs.existsSync(AUTH_KEYS_FILE)) {
            const template = `# Файл API-ключей для прокси\n# --------------------------------------------\n# В этом файле перечислены токены, которые\n# прокси будет считать «действительными».\n# Один ключ — одна строка без пробелов.\n#\n# 1) Хотите ОТКЛЮЧИТЬ авторизацию целиком?\n#    Оставьте файл пустым — сервер перестанет\n#    проверять заголовок Authorization.\n#\n# 2) Хотите разрешить доступ нескольким людям?\n#    Впишите каждый ключ в отдельной строке:\n#      d35ab3e1-a6f9-4d...\n#      f2b1cd9c-1b2e-4a...\n#\n# Пустые строки и строки, начинающиеся с «#»,\n# игнорируются.`;
            try {
                fs.writeFileSync(AUTH_KEYS_FILE, template, { encoding: 'utf8', flag: 'wx' });
                console.log(`Создан шаблон файла ключей: ${AUTH_KEYS_FILE}`);
            } catch (e) {
                console.error('Не удалось создать шаблон Authorization.txt:', e);
            }
            return [];
        }

        const fileContent = fs.readFileSync(AUTH_KEYS_FILE, 'utf8');
        const keys = fileContent.split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'));

        return keys;
    } catch (error) {
        console.error('Ошибка при чтении файла с ключами авторизации:', error);
        return [];
    }
}

export function isValidModel(modelName) {
    if (!availableModels) {
        availableModels = getAvailableModelsFromFile();
    }


    return availableModels.includes(modelName);
}


export function getAllModels() {
    if (!availableModels) {
        availableModels = getAvailableModelsFromFile();
    }

    return {
        models: availableModels.map(model => ({
            id: model,
            name: model,
            description: `Модель ${model}`
        }))
    };
}

export function getApiKeys() {
    if (!authKeys) {
        authKeys = getAuthKeysFromFile();
    }

    return authKeys;
}

// Функция для стриминга через page.evaluate с передачей чанков
async function sendStreamingRequest(page, apiUrl, payload, authToken, model, chatId, onChunk) {
    const requestId = crypto.randomUUID();

    try {
        streamHandlers.set(requestId, typeof onChunk === 'function' ? onChunk : null);

        if (!chunkExposedPages.has(page)) {
            await page.exposeFunction('__qwen_stream_chunk', (rid, chunk) => {
                const handler = streamHandlers.get(rid);
                if (typeof handler === 'function' && typeof chunk === 'string' && chunk.length > 0) {
                    handler(chunk);
                }
            });
            chunkExposedPages.add(page);
        }

        const evalData = {
            apiUrl: apiUrl,
            payload: payload,
            token: authToken,
            requestId: requestId,
            timeoutMs: 180000
        };

        // Real-time streaming: forward chunks from the page context to Node via __qwen_stream_chunk.
        const result = await page.evaluate(async (data) => {
            try {
                const controller = new AbortController();
                const timeoutMs = typeof data.timeoutMs === 'number' ? data.timeoutMs : 180000;
                const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

                const response = await fetch(data.apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${data.token}`,
                        'Accept': '*/*'
                    },
                    signal: controller.signal,
                    body: JSON.stringify(data.payload)
                });

                const __response_status = response.status;
                const __response_headers = {};
                try { for (const p of response.headers.entries()) { __response_headers[p[0]] = p[1]; } } catch (e) {}

                const __content_type = (response.headers.get('content-type') || '').toLowerCase();
                if (__content_type.includes('application/json')) {
                    const errorBody = await response.text();
                    clearTimeout(timeoutId);
                    return {
                        success: false,
                        status: __response_status,
                        statusText: response.statusText,
                        errorBody: errorBody,
                        responseStatus: __response_status,
                        responseHeaders: __response_headers
                    };
                }

                if (!response.ok) {
                    const errorBody = await response.text();
                    clearTimeout(timeoutId);
                    return {
                        success: false,
                        status: response.status,
                        statusText: response.statusText,
                        errorBody: errorBody
                    };
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let fullContent = '';
                let responseId = null;
                let usage = null;
                let finished = false;
                const streamedChunks = [];

                const tryHandleDataLine = async (line) => {
                    const trimmed = (line || '').trim();
                    if (!trimmed) return;
                    if (!trimmed.startsWith('data:')) return;

                    // Accept both "data: {...}" and "data:{...}"
                    const dataPart = trimmed.slice(5).trimStart();
                    if (!dataPart) return;
                    if (dataPart === '[DONE]') {
                        finished = true;
                        return;
                    }

                    try {
                        const chunk = JSON.parse(dataPart);

                        if (chunk['response.created']) {
                            responseId = chunk['response.created'].response_id;
                        }

                        if (chunk.choices && chunk.choices[0]) {
                            const choice0 = chunk.choices[0];
                            const delta = choice0.delta;
                            const finishReason = choice0.finish_reason;

                            if (delta && typeof delta.content === 'string' && delta.content.length > 0) {
                                fullContent += delta.content;
                                streamedChunks.push(delta.content);
                                try {
                                    // eslint-disable-next-line no-undef
                                    await window.__qwen_stream_chunk(data.requestId, delta.content);
                                } catch (e) {}
                            }

                            if ((delta && delta.status === 'finished') || finishReason === 'stop' || finishReason === 'length') {
                                finished = true;
                            }
                        }

                        if (chunk.usage) {
                            usage = chunk.usage;
                        }

                        if (chunk['response.completed'] || chunk['response.complete']) {
                            finished = true;
                        }
                    } catch (e) {
                        // Ignore per-line parse errors.
                    }
                };

                while (!finished) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const textPart = decoder.decode(value, { stream: true });
                    buffer += textPart;

                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

                    for (const line of lines) {
                        await tryHandleDataLine(line);
                    }
                }

                // Flush tail buffer best-effort.
                if (!finished && buffer && buffer.includes('data:')) {
                    await tryHandleDataLine(buffer);
                }

                clearTimeout(timeoutId);

                return {
                    success: true,
                    data: {
                        id: responseId || 'chatcmpl-' + Date.now(),
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model: data.payload.model,
                        choices: [{
                            index: 0,
                            message: {
                                role: 'assistant',
                                content: fullContent
                            },
                            finish_reason: 'stop'
                        }],
                        usage: usage || {
                            prompt_tokens: 0,
                            completion_tokens: 0,
                            total_tokens: 0
                        },
                        response_id: responseId,
                        responseStatus: __response_status,
                        responseHeaders: __response_headers,
                        streamedChunks: streamedChunks
                    }
                };
            } catch (error) {
                try { clearTimeout(timeoutId); } catch (e) {}
                return { success: false, error: error.toString() };
            }
        }, evalData);

        if (result.success) {
            return {
                id: result.data.id,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: model,
                choices: [{
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: result.data.choices[0].message.content
                    },
                    finish_reason: 'stop'
                }],
                usage: result.data.usage,
                chatId: chatId,
                parentId: result.data.response_id
            };
        }

        return { error: result.error || result.errorBody, chatId };
    } catch (error) {
        return { error: error.message, chatId };
    } finally {
        streamHandlers.delete(requestId);
    }
}

async function sendMessageUnlocked(message, model = "qwen-max-latest", chatId = null, parentId = null, files = null, tools = null, toolChoice = null, systemMessage = null, onChunk = null) {
    if (!availableModels) {
        availableModels = getAvailableModelsFromFile();
    }

    // Создаём новый чат, если не передан
    if (!chatId) {
        const newChatResult = await createChatV2(model);
        if (newChatResult.error) {
            return { error: 'Не удалось создать чат: ' + newChatResult.error };
        }
        chatId = newChatResult.chatId;
        console.log(`Создан новый чат v2 с ID: ${chatId}`);
    } else if (chatId.startsWith('chat_')) {
        // chatId - это наш сгенерированный ID, нужно создать реальный чат на Qwen
        console.log(`Сгенерированный chatId обнаружен: ${chatId}. Создаем реальный чат на Qwen...`);
        const newChatResult = await createChatV2(model);
        if (newChatResult.error) {
            console.error(`Не удалось создать реальный чат для сессии ${chatId}: ${newChatResult.error}`);
            return { error: 'Не удалось создать чат на Qwen: ' + newChatResult.error, chatId };
        }
        const realChatId = newChatResult.chatId;
        console.log(`Реальный чат создан: ${realChatId}. Сохраняем маппинг: ${chatId} -> ${realChatId}`);
        // Обновляем chatId на реальный
        chatId = realChatId;
    }

    // Валидация сообщения
    let messageContent = message;
    try {
        if (message === null || message === undefined) {
            console.error('Сообщение пустое');
            return { error: 'Сообщение не может быть пустым', chatId };
        } else if (typeof message === 'string') {
            messageContent = message;
        } else if (Array.isArray(message)) {
            const normalized = normalizeCompositeMessageParts(message);

            if (!normalized) {
                console.error('Некорректная структура составного сообщения');
                return { error: 'Некорректная структура составного сообщения', chatId };
            }

            messageContent = normalized;
        } else {
            console.error('Неподдерживаемый формат сообщения:', message);
            return { error: 'Неподдерживаемый формат сообщения', chatId };
        }
    } catch (error) {
        console.error('Ошибка при обработке сообщения:', error);
        return { error: 'Ошибка при обработке сообщения: ' + error.message, chatId };
    }

    if (!model || model.trim() === "") {
        model = "qwen-max-latest";
    } else {
        if (!isValidModel(model)) {
            console.warn(`Предупреждение: Указанная модель "${model}" не найдена в списке доступных моделей. Используется модель по умолчанию.`);
            model = "qwen-max-latest";
        }
    }

    console.log(`Используемая модель: "${model}"`);

    let tokenObj = await getAvailableToken();
    if (tokenObj && tokenObj.token) {
        authToken = tokenObj.token;
        console.log(`Используется аккаунт: ${tokenObj.id}`);
        global.currentTokenObj = tokenObj; // Сохраняем для обработки RateLimited в стриминге
    }

    const browserContext = getBrowserContext();
    if (!browserContext) {
        return { error: 'Браузер не инициализирован', chatId };
    }

    if (!getAuthenticationStatus()) {
        console.log('Проверка авторизации...');
        const authCheck = await checkAuthentication(browserContext);
        if (!authCheck) {
            return { error: 'Требуется авторизация. Пожалуйста, авторизуйтесь в открытом браузере.', chatId };
        }
    }

    if (!authToken) {
        console.log('Получение токена авторизации...');
        authToken = await extractAuthToken(browserContext);
        if (!authToken) {
            console.error('Не удалось получить токен авторизации');
            return { error: 'Ошибка авторизации: не удалось получить токен', chatId };
        }
    }

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);

        const verificationNeeded = await checkVerification(page);
        if (verificationNeeded) {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
        }

        if (!authToken) {
            console.error('Токен отсутствует перед отправкой запроса');
            authToken = await page.evaluate(() => localStorage.getItem('token'));
            if (!authToken) {
                return { error: 'Токен авторизации не найден. Требуется перезапуск в ручном режиме.', chatId };
            } else {
                saveAuthToken(authToken);
            }
        }

        console.log('Отправка запроса к API v2...');

        // Формируем новое сообщение для v2 API
        const userMessageId = crypto.randomUUID();
        const assistantChildId = crypto.randomUUID();
        
        const newMessage = {
            fid: userMessageId,
            parentId: parentId,
            parent_id: parentId,
            role: "user",
            content: messageContent,
            chat_type: "t2t",
            sub_chat_type: "t2t",
            timestamp: Math.floor(Date.now() / 1000),
            user_action: "chat",
            models: [model],
            files: files || [],
            childrenIds: [assistantChildId],
            extra: {
                meta: {
                    subChatType: "t2t"
                }
            },
            feature_config: {
                thinking_enabled: false,
                output_schema: "phase"
            }
        };

        // Формируем payload для v2 API
        const payload = {
            stream: true,
            incremental_output: true,
            chat_id: chatId,
            chat_mode: "normal",
            messages: [newMessage],
            model: model,
            parent_id: parentId,
            timestamp: Math.floor(Date.now() / 1000)
        };

        // Добавляем system message если есть
        if (systemMessage) {
            payload.system_message = systemMessage;
            console.log(`System message: ${systemMessage.substring(0, 100)}${systemMessage.length > 100 ? '...' : ''}`);
        }

        // Добавляем tools если есть
        if (tools && Array.isArray(tools) && tools.length > 0) {
            payload.tools = tools;
            payload.tool_choice = toolChoice || "auto";
        }

        console.log('=== PAYLOAD V2 ===\n' + JSON.stringify(payload, null, 2));
        console.log(`Отправка сообщения в чат ${chatId} с parent_id: ${parentId || 'null'}`);

        const apiUrl = `${CHAT_API_URL_V2}?chat_id=${chatId}`;

        // Ретраи, чтобы переживать "The chat is in progress!" и другие кратковременные блокировки.
        const RETRY_ATTEMPTS = 12;
        const BASE_RETRY_DELAY = 800;
        const MAX_RETRY_DELAY = 12000;

        let lastError = null;
        let response = null;

        // Если есть callback для стриминга - используем стриминг через page.evaluate
        if (onChunk) {
            const STREAM_RETRY_ATTEMPTS = 8;
            const BASE_STREAM_DELAY = 800;
            const MAX_STREAM_DELAY = 12000;

            for (let sAttempt = 0; sAttempt < STREAM_RETRY_ATTEMPTS; sAttempt++) {
                if (sAttempt > 0) {
                    const delay = Math.min(MAX_STREAM_DELAY, Math.round(BASE_STREAM_DELAY * Math.pow(1.6, sAttempt - 1)));
                    console.log(`Повтор стриминга ${sAttempt + 1}/${STREAM_RETRY_ATTEMPTS} (задержка ${delay}мс)...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }

                const streamResult = await sendStreamingRequest(page, apiUrl, payload, authToken, model, chatId, onChunk);
                if (streamResult && !streamResult.error) {
                    pagePool.releasePage(page);
                    page = null;
                    return streamResult;
                }

                const errText = String(streamResult?.error || '').toLowerCase();
                if (!errText.includes('chat is in progress')) {
                    break; // не "in progress" — дальше пробуем обычный режим
                }
            }
            // Если стриминг не удался, продолжаем с обычной попыткой
        }

        for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
            if (attempt > 0) {
                const delay = Math.min(MAX_RETRY_DELAY, Math.round(BASE_RETRY_DELAY * Math.pow(1.6, attempt - 1)));
                console.log(`Попытка ${attempt + 1}/${RETRY_ATTEMPTS} отправки сообщения (задержка ${delay}мс)...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }

            try {
                const evalData = {
                    apiUrl: apiUrl,
                    payload: payload,
                    token: authToken,
                    timeoutMs: 180000
                };

                console.log(`Используем токен: ${authToken ? 'Токен существует' : 'Токен отсутствует'}`);
                console.log(`API URL: ${apiUrl}`);

                // Выполняем запрос через браузер и парсим SSE
                response = await page.evaluate(async (data) => {
            try {
                const token = data.token;
                if (!token) {
                    return { success: false, error: 'Токен авторизации не найден' };
                }

                 const controller = new AbortController();
                 const timeoutMs = typeof data.timeoutMs === 'number' ? data.timeoutMs : 180000;
                 const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

                 const response = await fetch(data.apiUrl, {
                     method: 'POST',
                     headers: {
                         'Content-Type': 'application/json',
                         'Authorization': `Bearer ${token}`,
                         'Accept': '*/*'
                     },
                     signal: controller.signal,
                     body: JSON.stringify(data.payload)
                 });

                // DEBUG: capture http status and headers
                const __response_status = response.status;
                const __response_headers = {};
                try { for (const p of response.headers.entries()) { __response_headers[p[0]] = p[1]; } } catch (e) {}

                 const __content_type = (response.headers.get('content-type') || '').toLowerCase();
                 if (__content_type.includes('application/json')) {
                     const errorBody = await response.text();
                     clearTimeout(timeoutId);
                     return {
                         success: false,
                         status: __response_status,
                         statusText: response.statusText,
                         errorBody: errorBody,
                         responseStatus: __response_status,
                         responseHeaders: __response_headers
                     };
                 }

                 if (response.ok) {
                     const reader = response.body.getReader();
                     const decoder = new TextDecoder();
                     let buffer = '';
                     let fullContent = '';
                    let responseId = null;
                    let usage = null;
                    let finished = false;
                    let streamedChunks = []; // Collect chunks for return

                    const __debug_raw_chunks = []; // DEBUG: collect raw SSE json strings
                    const __debug_raw_texts = []; // DEBUG: collect raw decoded text parts
                    let __debug_raw_body = ''; // DEBUG: fallback capture of raw body
                    while (!finished) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        const textPart = decoder.decode(value, { stream: true });
                        try { __debug_raw_texts.push(textPart); } catch (e) { }
                        try { __debug_raw_body += textPart; } catch (e) { }

                        buffer += textPart;
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';

                         for (const line of lines) {
                             const trimmed = (line || '').trim();
                             if (!trimmed || !trimmed.startsWith('data:')) continue;

                             const dataPart = trimmed.slice(5).trimStart();
                             if (!dataPart) continue;
                             if (dataPart === '[DONE]') {
                                 finished = true;
                                 continue;
                             }

                             const jsonStr = dataPart;
                             // collect raw chunk for debugging
                             try { __debug_raw_chunks.push(jsonStr); } catch (e) { }

                             try {
                                 const chunk = JSON.parse(jsonStr);
                                
                                // Первый чанк с метаданными
                                if (chunk['response.created']) {
                                    responseId = chunk['response.created'].response_id;
                                }
                                
                                // Чанки с контентом - собираем для потоковой передачи
                                 if (chunk.choices && chunk.choices[0]) {
                                     const choice0 = chunk.choices[0];
                                     const delta = choice0.delta;
                                     const finishReason = choice0.finish_reason;
                                     if (delta && delta.content) {
                                         fullContent += delta.content;
                                         streamedChunks.push(delta.content);
                                     }
                                     if ((delta && delta.status === 'finished') || finishReason === 'stop' || finishReason === 'length') {
                                         finished = true;
                                     }
                                 }
                                
                                // Обновляем usage
                                if (chunk.usage) {
                                    usage = chunk.usage;
                                }
                            } catch (e) {
                                // Игнорируем ошибки парсинга отдельных чанков
                            }
                        }
                    }

                     clearTimeout(timeoutId);
                     return {
                         success: true,
                         data: {
                            id: responseId || 'chatcmpl-' + Date.now(),
                            object: 'chat.completion',
                            created: Math.floor(Date.now() / 1000),
                            model: data.payload.model,
                            choices: [{
                                index: 0,
                                message: {
                                    role: 'assistant',
                                    content: fullContent
                                },
                                finish_reason: 'stop'
                            }],
                            usage: usage || {
                                prompt_tokens: 0,
                                completion_tokens: 0,
                                total_tokens: 0
                            },
                            response_id: responseId,
                            // DEBUG: include raw chunks and fallback body capture
                            rawChunks: __debug_raw_chunks,
                            rawTextChunks: __debug_raw_texts,
                            rawBody: __debug_raw_body.substring(0, 500), // truncate for log brevity
                            responseStatus: __response_status,
                            responseHeaders: __response_headers,
                            // Return collected chunks for real-time delivery
                            streamedChunks: streamedChunks
                         }
                     };
                 } else {
                     const errorBody = await response.text();
                     clearTimeout(timeoutId);
                     return {
                         success: false,
                         status: response.status,
                         statusText: response.statusText,
                         errorBody: errorBody
                     };
                 }
             } catch (error) {
                 try { clearTimeout(timeoutId); } catch (e) {}
                 return { success: false, error: error.toString() };
             }
         }, evalData);

            // Проверяем ошибку "chat is in progress" и пробуем снова
            let shouldRetry = false;
            if (response && !response.success && response.errorBody) {
                let details = '';
                try {
                    const parsed = JSON.parse(response.errorBody);
                    details = parsed?.data?.details || parsed?.detail || parsed?.message || '';
                } catch (e) {
                    details = '';
                }

                const haystack = String(details || response.errorBody).toLowerCase();
                if (haystack.includes('chat is in progress')) {
                    lastError = details || 'The chat is in progress!';
                    console.warn(`Чат ещё обрабатывает предыдущее сообщение: ${lastError}`);
                    if (attempt < RETRY_ATTEMPTS - 1) {
                        shouldRetry = true; // Пробуем снова
                    }
                }
            }
            
            // Если успешно или исчерпали попытки - выходим из цикла
            if (!shouldRetry) {
                break;
            }
        } catch (e) {
            lastError = e.message;
            console.error(`Ошибка при отправке сообщения (попытка ${attempt + 1}): ${lastError}`);
            if (attempt < RETRY_ATTEMPTS - 1) {
                continue;
            }
        }
        }

        // --- TEST: симуляция ответа RateLimited ---
        if (global.simulateRateLimit && !global.__rateLimitedTested) {
            global.__rateLimitedTested = true;
            response = {
                success: false,
                status: 429,
                errorBody: JSON.stringify({
                    code: 'RateLimited',
                    detail: "You've reached the upper limit for today's usage.",
                    template: 'You have reached the daily usage limit. Please wait {{num}} hours before trying again.',
                    num: 4
                })
            };
            console.log('*** Симуляция ответа RateLimited активирована ***');
        }

        pagePool.releasePage(page);
        page = null;

        if (response.success) {
            // Логируем сырой ответ от модели
            logRaw(JSON.stringify(response.data));
            console.log('Ответ получен успешно');

            // Добавляем метаданные для клиента
            response.data.chatId = chatId;
            response.data.parentId = response.data.response_id; // Для следующего сообщения
            response.data.id = response.data.id || "chatcmpl-" + Date.now();

            // Если клиент ожидал stream=true, но мы оказались в fallback-пути,
            // отдадим накопленные чанки хотя бы в конце (лучше, чем пустой стрим).
            if (typeof onChunk === 'function' && Array.isArray(response.data.streamedChunks)) {
                for (const chunk of response.data.streamedChunks) {
                    try { onChunk(chunk); } catch (e) { }
                }
            }

            return response.data;
        } else {
            // Логируем ошибочный сырой ответ
            logRaw(JSON.stringify(response));
            console.error('Ошибка при получении ответа:', response.error || response.statusText);

            if (response.errorBody) {
                console.error('Тело ответа с ошибкой:', response.errorBody);
            }

            if (response.html && response.html.includes('Verification')) {
                setAuthenticationStatus(false);
                console.log('Обнаружена необходимость верификации, перезапуск браузера в видимом режиме...');

                await pagePool.clear();

                authToken = null;

                await shutdownBrowser();
                await initBrowser(true);

                return { error: 'Требуется верификация. Браузер запущен в видимом режиме.', verification: true, chatId };
            }

            // ----- Новая обработка истекшего токена / 401 Unauthorized -----
            if ((response.status === 401) || (response.errorBody && (response.errorBody.includes('Unauthorized') || response.errorBody.includes('Token has expired')))) {
                console.log('Токен', tokenObj?.id, 'недействителен (401). Удаляем и пробуем другой.');

                // Удаляем токен из пула
                authToken = null;
                if (tokenObj && tokenObj.id) {
                    const { markInvalid } = await import('./tokenManager.js');
                    markInvalid(tokenObj.id);
                }

                // Есть ли ещё токены?
                const { hasValidTokens } = await import('./tokenManager.js');
                if (hasValidTokens()) {
                    return await sendMessage(message, model, chatId, parentId, files, tools, toolChoice, systemMessage, onChunk); // повторяем с новым токеном
                }

                console.error('Не осталось валидных токенов. Останавливаю прокси.');
                await pagePool.clear();
                await shutdownBrowser();
                process.exit(1);
            }

            if (response.errorBody && response.errorBody.includes('RateLimited')) {
                try {
                    const rateInfo = JSON.parse(response.errorBody);
                    const hours = Number(rateInfo.num) || 24;
                    if (tokenObj && tokenObj.id) {
                        markRateLimited(tokenObj.id, hours);
                        console.log(`Токен ${tokenObj.id} достиг лимита. Помечаем на ${hours}ч и пробуем другой токен...`);
                    }
                } catch (e) {
                    console.error('Не удалось распарсить тело ошибки RateLimited:', e);
                }
                authToken = null;
                return await sendMessage(message, model, chatId, parentId, files, tools, toolChoice, systemMessage, onChunk);
            }

            return { error: response.error || response.statusText, details: response.errorBody || 'Нет дополнительных деталей', chatId };
        }
    } catch (error) {
        console.error('Ошибка при отправке сообщения:', error);
        return { error: error.toString(), chatId };
    } finally {

        if (page) {
            try {
                await page.close();
            } catch (e) {
                console.error('Ошибка при закрытии страницы:', e);
            }
        }
    }
}

export async function sendMessage(message, model = "qwen-max-latest", chatId = null, parentId = null, files = null, tools = null, toolChoice = null, systemMessage = null, onChunk = null) {
    // Serialize requests per chatId to avoid Qwen "The chat is in progress!" errors when clients send parallel calls.
    if (typeof chatId === 'string' && chatId.trim() !== '') {
        return enqueueChatTask(chatId, () =>
            sendMessageUnlocked(message, model, chatId, parentId, files, tools, toolChoice, systemMessage, onChunk)
        );
    }

    return sendMessageUnlocked(message, model, chatId, parentId, files, tools, toolChoice, systemMessage, onChunk);
}

export async function clearPagePool() {
    await pagePool.clear();
}

export function getAuthToken() {
    return authToken;
}

export async function listModels(browserContext) {
    return await getAvailableModels(browserContext);
}

// Создание нового чата через v2 API
export async function createChatV2(model = "qwen-max-latest", title = "Новый чат") {
    const browserContext = getBrowserContext();
    if (!browserContext) {
        return { error: 'Браузер не инициализирован' };
    }

    // Получаем токен из tokenManager
    let tokenObj = await getAvailableToken();
    if (tokenObj && tokenObj.token) {
        authToken = tokenObj.token;
        console.log(`Используется аккаунт для создания чата: ${tokenObj.id}`);
    }

    if (!authToken) {
        console.log('Получение токена авторизации для создания чата...');
        authToken = await extractAuthToken(browserContext);
        if (!authToken) {
            return { error: 'Не удалось получить токен авторизации' };
        }
    }

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);

        const payload = {
            title: title,
            models: [model],
            chat_mode: "normal",
            chat_type: "t2t",
            timestamp: Date.now()
        };

        const evalData = {
            apiUrl: CREATE_CHAT_URL,
            payload: payload,
            token: authToken
        };

        const result = await page.evaluate(async (data) => {
            try {
                const response = await fetch(data.apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${data.token}`
                    },
                    body: JSON.stringify(data.payload)
                });

                if (response.ok) {
                    const result = await response.json();
                    return { success: true, data: result };
                } else {
                    const errorBody = await response.text();
                    return {
                        success: false,
                        status: response.status,
                        errorBody: errorBody
                    };
                }
            } catch (error) {
                return { success: false, error: error.toString() };
            }
        }, evalData);

        pagePool.releasePage(page);
        page = null;

        if (result.success && result.data.success) {
            console.log(`Чат создан: ${result.data.data.id}`);
            return { 
                success: true, 
                chatId: result.data.data.id,
                requestId: result.data.request_id
            };
        } else {
            console.error('Ошибка при создании чата:', result);
            return { error: result.errorBody || result.error || 'Неизвестная ошибка' };
        }
    } catch (error) {
        console.error('Ошибка при создании чата:', error);
        return { error: error.toString() };
    } finally {
        if (page) {
            try {
                await page.close();
            } catch (e) {
                console.error('Ошибка при закрытии страницы:', e);
            }
        }
    }
}

export async function testToken(token) {
    const browserContext = getBrowserContext();
    if (!browserContext) return 'ERROR';

    let page;
    try {
        page = await browserContext.newPage();
        await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded' });

        const evalData = {
            apiUrl: CREATE_CHAT_URL,
            token,
            payload: {
                title: 'test',
                models: ['qwen-max-latest'],
                chat_mode: "normal",
                chat_type: "t2t",
                timestamp: Date.now()
            }
        };

        const result = await page.evaluate(async (data) => {
            try {
                const res = await fetch(data.apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${data.token}`
                    },
                    body: JSON.stringify(data.payload)
                });
                return { ok: res.ok, status: res.status };
            } catch (e) {
                return { ok: false, status: 0, error: e.toString() };
            }
        }, evalData);

        if (result.ok || result.status === 400) return 'OK';
        if (result.status === 401 || result.status === 403) return 'UNAUTHORIZED';
        if (result.status === 429) return 'RATELIMIT';
        return 'ERROR';
    } catch (e) {
        console.error('testToken error:', e);
        return 'ERROR';
    } finally {
        if (page) {
            try { await page.close(); } catch { }
        }
    }
}


