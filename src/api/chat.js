import { getBrowserContext, getAuthenticationStatus, setAuthenticationStatus } from '../browser/browser.js';
import { checkAuthentication, checkVerification } from '../browser/auth.js';
import { shutdownBrowser, initBrowser } from '../browser/browser.js';
import { saveAuthToken } from '../browser/session.js';
import { getAvailableToken, markRateLimited, removeInvalidToken } from './tokenManager.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logInfo, logError, logWarn, logDebug, logRaw } from '../logger/index.js';
import crypto from 'crypto';
import {
    CHAT_API_URL, CREATE_CHAT_URL, CHAT_PAGE_URL, TASK_STATUS_URL,
    PAGE_TIMEOUT, RETRY_DELAY, PAGE_POOL_SIZE,
    DEFAULT_MODEL, MAX_RETRY_COUNT,
    TASK_POLL_MAX_ATTEMPTS, TASK_POLL_INTERVAL
} from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODELS_FILE = path.join(__dirname, '..', 'AvailableModels.txt');
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
let browserTokenRateLimited = false;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Page helpers ────────────────────────────────────────────────────────────

async function getPage(context) {
    if (context && typeof context.goto === 'function') {
        return context;
    } else if (context && typeof context.newPage === 'function') {
        return await context.newPage();
    }
    throw new Error('Неверный контекст: не страница Puppeteer, не контекст Playwright');
}

export const pagePool = {
    pages: [],
    maxSize: PAGE_POOL_SIZE,

    async getPage(context) {
        while (this.pages.length > 0) {
            const page = this.pages.pop();
            try {
                if (page.isClosed()) {
                    logWarn('Страница из пула закрыта, пропускаем');
                    continue;
                }
                await page.evaluate(() => document.readyState);
                return page;
            } catch (e) {
                logWarn(`Страница из пула протухла (${e.message?.substring(0, 60)}), создаём новую`);
                try { await page.close(); } catch { /* already dead */ }
            }
        }

        const newPage = await getPage(context);
        await newPage.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

        if (!authToken) {
            try {
                authToken = await newPage.evaluate(() => localStorage.getItem('token'));
                logInfo('Токен авторизации получен из браузера');
                if (authToken) {
                    saveAuthToken(authToken);
                }
            } catch (e) {
                logError('Ошибка при получении токена авторизации', e);
            }
        }

        return newPage;
    },

    releasePage(page) {
        try {
            if (page.isClosed()) return;
        } catch { return; }

        if (this.pages.length < this.maxSize) {
            this.pages.push(page);
        } else {
            page.close().catch(e => logError('Ошибка при закрытии страницы', e));
        }
    },

    async clear() {
        for (const page of this.pages) {
            try { await page.close(); } catch (e) {
                logError('Ошибка при закрытии страницы в пуле', e);
            }
        }
        this.pages = [];
    }
};

// ─── Task polling ────────────────────────────────────────────────────────────

export async function pollTaskStatus(taskId, page, token, maxAttempts = TASK_POLL_MAX_ATTEMPTS, interval = TASK_POLL_INTERVAL) {
    logInfo(`Начинаем опрос статуса задачи: ${taskId}`);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const statusUrl = `${TASK_STATUS_URL}/${taskId}`;

            const result = await page.evaluate(async (data) => {
                try {
                    const response = await fetch(data.url, {
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${data.token}`,
                            'Accept': 'application/json'
                        }
                    });
                    if (!response.ok) {
                        return { success: false, status: response.status, error: await response.text() };
                    }
                    return { success: true, data: await response.json() };
                } catch (e) {
                    return { success: false, error: e.toString() };
                }
            }, { url: statusUrl, token });

            if (!result.success) {
                logWarn(`Ошибка при проверке статуса (попытка ${attempt}/${maxAttempts}): ${result.error}`);
                if (attempt < maxAttempts) await delay(interval);
                continue;
            }

            const taskData = result.data;
            const taskStatus = taskData.task_status || taskData.status || 'unknown';
            logDebug(`Статус задачи (${attempt}/${maxAttempts}): ${taskStatus}`);

            if (taskStatus === 'completed' || taskStatus === 'success') {
                logInfo('Задача завершена успешно');
                return { success: true, status: 'completed', data: taskData };
            }

            if (taskStatus === 'failed' || taskStatus === 'error') {
                logError('Задача завершилась с ошибкой');
                return { success: false, status: 'failed', error: taskData.error || taskData.message || 'Task failed', data: taskData };
            }

            if (attempt < maxAttempts) await delay(interval);
        } catch (error) {
            logError(`Ошибка при опросе задачи (попытка ${attempt}/${maxAttempts})`, error);
            if (attempt < maxAttempts) await delay(interval);
        }
    }

    logError(`Превышен лимит попыток (${maxAttempts}) для задачи ${taskId}`);
    return { success: false, status: 'timeout', error: 'Task polling timeout exceeded' };
}

// ─── Token extraction ────────────────────────────────────────────────────────

export async function extractAuthToken(context, forceRefresh = false) {
    if (authToken && !forceRefresh) return authToken;

    try {
        const page = await getPage(context);
        try {
            await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
            await delay(RETRY_DELAY);

            const newToken = await page.evaluate(() => localStorage.getItem('token'));
            if (typeof context.newPage === 'function') await page.close();

            if (newToken) {
                authToken = newToken;
                logInfo('Токен авторизации успешно извлечен');
                saveAuthToken(authToken);
                return authToken;
            }
            logError('Токен авторизации не найден в браузере');
            return null;
        } catch (error) {
            if (typeof context.newPage === 'function') await page.close().catch(() => {});
            throw error;
        }
    } catch (error) {
        logError('Ошибка при извлечении токена авторизации', error);
        return null;
    }
}

// ─── Models & keys from files ────────────────────────────────────────────────

export function getAvailableModelsFromFile() {
    try {
        if (!fs.existsSync(MODELS_FILE)) {
            logError(`Файл с моделями не найден: ${MODELS_FILE}`);
            return [DEFAULT_MODEL];
        }
        const models = fs.readFileSync(MODELS_FILE, 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));

        logInfo('===== ДОСТУПНЫЕ МОДЕЛИ =====');
        models.forEach(m => logInfo(`- ${m}`));
        logInfo('============================');
        return models;
    } catch (error) {
        logError('Ошибка при чтении файла с моделями', error);
        return [DEFAULT_MODEL];
    }
}

function getAuthKeysFromFile() {
    try {
        if (!fs.existsSync(AUTH_KEYS_FILE)) {
            const template = `# Файл API-ключей для прокси\n# --------------------------------------------\n# В этом файле перечислены токены, которые\n# прокси будет считать «действительными».\n# Один ключ — одна строка без пробелов.\n#\n# 1) Хотите ОТКЛЮЧИТЬ авторизацию целиком?\n#    Оставьте файл пустым — сервер перестанет\n#    проверять заголовок Authorization.\n#\n# 2) Хотите разрешить доступ нескольким людям?\n#    Впишите каждый ключ в отдельной строке:\n#      d35ab3e1-a6f9-4d...\n#      f2b1cd9c-1b2e-4a...\n#\n# Пустые строки и строки, начинающиеся с «#»,\n# игнорируются.`;
            try {
                fs.writeFileSync(AUTH_KEYS_FILE, template, { encoding: 'utf8', flag: 'wx' });
                logInfo(`Создан шаблон файла ключей: ${AUTH_KEYS_FILE}`);
            } catch (e) {
                logError('Не удалось создать шаблон Authorization.txt', e);
            }
            return [];
        }
        return fs.readFileSync(AUTH_KEYS_FILE, 'utf8')
            .split('\n')
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));
    } catch (error) {
        logError('Ошибка при чтении файла с ключами авторизации', error);
        return [];
    }
}

export function isValidModel(modelName) {
    if (!availableModels) availableModels = getAvailableModelsFromFile();
    return availableModels.includes(modelName);
}

export function getAllModels() {
    if (!availableModels) availableModels = getAvailableModelsFromFile();
    return {
        models: availableModels.map(model => ({
            id: model,
            name: model,
            description: `Модель ${model}`
        }))
    };
}

export function getApiKeys() {
    if (!authKeys) authKeys = getAuthKeysFromFile();
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
// ─── sendMessage — helper functions ──────────────────────────────────────────

function validateAndPrepareMessage(message) {
    if (message === null || message === undefined) {
        return { error: 'Сообщение не может быть пустым' };
    }
    if (typeof message === 'string') return { content: message };
    if (Array.isArray(message)) {
        const isValid = message.every(item =>
            (item.type === 'text' && typeof item.text === 'string') ||
            (item.type === 'image' && typeof item.image === 'string') ||
            (item.type === 'file' && typeof item.file === 'string')
        );
        if (!isValid) return { error: 'Некорректная структура составного сообщения' };
        return { content: message };
    }
    return { error: 'Неподдерживаемый формат сообщения' };
}

async function resolveAuthToken(browserContext) {
    const tokenObj = await getAvailableToken();
    if (tokenObj && tokenObj.token) {
        authToken = tokenObj.token;
        logInfo(`Используется аккаунт: ${tokenObj.id}`);
        global.currentTokenObj = tokenObj; // Сохраняем для обработки RateLimited в стриминге
        return tokenObj;
    }

    if (browserTokenRateLimited) {
        logWarn('Browser-токен залимичен, пропускаем fallback');
        return null;
    }

    if (!getAuthenticationStatus()) {
        logInfo('Проверка авторизации...');
        const authCheck = await checkAuthentication(browserContext);
        if (!authCheck) return null;
    }

    if (!authToken) {
        logInfo('Получение токена авторизации...');
        authToken = await extractAuthToken(browserContext);
    }

    return authToken ? { id: 'browser', token: authToken } : null;
}

function buildPayloadV2(messageContent, model, chatId, parentId, files, systemMessage, tools, toolChoice, chatType = 't2t', size = null) {
    const userMessageId = crypto.randomUUID();
    const assistantChildId = crypto.randomUUID();

    const isVideo = chatType === 't2v';

    const featureConfig = {
        thinking_enabled: isVideo,
        output_schema: 'phase'
    };
    if (isVideo) {
        featureConfig.research_mode = 'normal';
        featureConfig.auto_thinking = true;
        featureConfig.thinking_format = 'summary';
        featureConfig.auto_search = true;
    }

    const newMessage = {
        fid: userMessageId,
        parentId, parent_id: parentId,
        role: 'user',
        content: messageContent,
        chat_type: chatType, sub_chat_type: chatType,
        timestamp: Math.floor(Date.now() / 1000),
        user_action: 'chat',
        models: [model],
        files: files || [],
        childrenIds: [assistantChildId],
        extra: { meta: { subChatType: chatType } },
        feature_config: featureConfig
    };

    const payload = {
        stream: !isVideo,
        incremental_output: true,
        chat_id: chatId,
        chat_mode: 'normal',
        messages: [newMessage],
        model,
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
    if (size) payload.size = size;

    if (systemMessage) {
        payload.system_message = systemMessage;
        logDebug(`System message: ${systemMessage.substring(0, 100)}${systemMessage.length > 100 ? '...' : ''}`);
    }
    if (tools && Array.isArray(tools) && tools.length > 0) {
        payload.tools = tools;
        payload.tool_choice = toolChoice || 'auto';
    }

    return payload;
}

async function executeApiRequest(page, apiUrl, payload, token) {
    const requestBody = { apiUrl, payload, token };

    logDebug(`Используем токен: ${token ? 'Токен существует' : 'Токен отсутствует'}`);
    logDebug(`API URL: ${apiUrl}`);

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
    return page.evaluate(async (data) => {
        try {
            const t = data.token;
            if (!t) return { success: false, error: 'Токен авторизации не найден' };

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
            const response = await fetch(data.apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${t}`,
                    'Accept': '*/*'
                },
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
            if (response.ok) {
                if (data.payload.stream === false) {
                    const jsonResponse = await response.json();
                    if (jsonResponse.code === 'RateLimited' || jsonResponse.error) {
                        return { success: false, status: 429, errorBody: JSON.stringify(jsonResponse) };
                    }
                    return { success: true, isTask: true, data: jsonResponse };
                }

                const contentType = response.headers.get('content-type') || '';

                if (!contentType.includes('text/event-stream')) {
                    const body = await response.text();
                    try {
                        const parsed = JSON.parse(body);
                        if (parsed.code === 'RateLimited' || parsed.error) {
                            return { success: false, status: 429, errorBody: body };
                        }
                    } catch { /* not JSON, treat as unexpected */ }
                    return { success: false, error: 'Unexpected non-SSE 200 response', errorBody: body };
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                let fullContent = '';
                let responseId = null;
                let usage = null;
                let finished = false;
                let streamError = null;

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
                while (!finished) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
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
                    for (const line of lines) {
                        if (!line.trim() || !line.startsWith('data: ')) continue;
                        const jsonStr = line.substring(6).trim();
                        if (!jsonStr) continue;
                        try {
                            const chunk = JSON.parse(jsonStr);

                            if (chunk.code === 'RateLimited' || (chunk.code && chunk.detail)) {
                                streamError = { status: 429, errorBody: JSON.stringify(chunk) };
                                finished = true;
                                break;
                            }
                            if (chunk.error && !chunk.choices) {
                                streamError = { status: 500, errorBody: JSON.stringify(chunk) };
                                finished = true;
                                break;
                            }

                            if (chunk['response.created']) responseId = chunk['response.created'].response_id;
                            if (chunk.choices && chunk.choices[0]) {
                                const delta = chunk.choices[0].delta;
                                if (delta && delta.content) fullContent += delta.content;
                                if (delta && delta.status === 'finished') finished = true;
                            }
                            if (chunk.usage) usage = chunk.usage;
                        } catch { /* ignore parse errors for individual chunks */ }
                    }
                }

                if (streamError) {
                    return { success: false, ...streamError };
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
                return {
                    success: true,
                    isTask: false,
                    data: {
                        id: responseId || 'chatcmpl-' + Date.now(),
                        object: 'chat.completion',
                        created: Math.floor(Date.now() / 1000),
                        model: data.payload.model,
                        choices: [{ index: 0, message: { role: 'assistant', content: fullContent }, finish_reason: 'stop' }],
                        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
                        response_id: responseId
                    }
                };
            }

            const errorBody = await response.text();
            return { success: false, status: response.status, statusText: response.statusText, errorBody };
        } catch (error) {
            return { success: false, error: error.toString() };
        }
    }, requestBody);
}

async function handleApiError(response, tokenObj, message, model, chatId, parentId, files, retryCount, chatType, size, waitForCompletion) {
    logRaw(JSON.stringify(response));
    logError(`Ошибка при получении ответа: ${response.error || response.statusText}`);
    if (response.errorBody) logDebug(`Тело ответа с ошибкой: ${response.errorBody}`);

    if (response.html && response.html.includes('Verification')) {
        setAuthenticationStatus(false);
        logInfo('Обнаружена необходимость верификации, перезапуск браузера в видимом режиме...');
        await pagePool.clear();
        authToken = null;
        await shutdownBrowser();
        await initBrowser(true);
        return { error: 'Требуется верификация. Браузер запущен в видимом режиме.', verification: true, chatId };
    }

    if (response.status === 401 || (response.errorBody && (response.errorBody.includes('Unauthorized') || response.errorBody.includes('Token has expired')))) {
        logWarn(`Токен ${tokenObj?.id} недействителен (401). Удаляем и пробуем другой.`);
        authToken = null;
        browserTokenRateLimited = false;
        if (tokenObj?.id && tokenObj.id !== 'browser') {
            const { markInvalid } = await import('./tokenManager.js');
            markInvalid(tokenObj.id);
        }
        const { hasValidTokens } = await import('./tokenManager.js');
        if (hasValidTokens() && retryCount < MAX_RETRY_COUNT) {
            return sendMessage(message, model, chatId, parentId, files, null, null, null, chatType, size, waitForCompletion, retryCount + 1);
        }
        logError('Не осталось валидных токенов или исчерпаны попытки.');
        return { error: 'Все токены недействительны (401). Требуется повторная авторизация.', chatId };
    }

    if (response.status === 429 || (response.errorBody && response.errorBody.includes('RateLimited'))) {
        let hours = 24;
        try {
            const rateInfo = JSON.parse(response.errorBody);
            hours = Number(rateInfo.num) || 24;
        } catch { /* errorBody might not be valid JSON */ }

        if (tokenObj?.id === 'browser') {
            browserTokenRateLimited = true;
            logWarn(`Browser-токен достиг лимита. Помечаем на ${hours}ч.`);
        } else if (tokenObj?.id) {
            markRateLimited(tokenObj.id, hours);
            logWarn(`Токен ${tokenObj.id} достиг лимита. Помечаем на ${hours}ч и пробуем другой токен...`);
        }

        authToken = null;
        const { hasValidTokens } = await import('./tokenManager.js');
        if (hasValidTokens() && retryCount < MAX_RETRY_COUNT) {
            return sendMessage(message, model, chatId, parentId, files, null, null, null, chatType, size, waitForCompletion, retryCount + 1);
        }
        return { error: `Все токены заблокированы по лимиту (${hours}ч)`, chatId };
    }

    return { error: response.error || response.statusText, details: response.errorBody || 'Нет дополнительных деталей', chatId };
}

// ─── Main public API ─────────────────────────────────────────────────────────

export async function sendMessage(message, model = DEFAULT_MODEL, chatId = null, parentId = null, files = null, tools = null, toolChoice = null, systemMessage = null, chatType = 't2t', size = null, waitForCompletion = true, retryCount = 0) {
    if (!availableModels) availableModels = getAvailableModelsFromFile();

    if (!chatId) {
        const newChatResult = await createChatV2(model);
        if (newChatResult.error) return { error: 'Не удалось создать чат: ' + newChatResult.error };
        chatId = newChatResult.chatId;
        logInfo(`Создан новый чат v2 с ID: ${chatId}`);
    }

    const validated = validateAndPrepareMessage(message);
    if (validated.error) {
        logError(validated.error);
        return { error: validated.error, chatId };
    }
    const messageContent = validated.content;

    if (!model || model.trim() === '') {
        model = DEFAULT_MODEL;
    } else if (!isValidModel(model)) {
        logWarn(`Модель "${model}" не найдена в списке доступных. Используется модель по умолчанию.`);
        model = DEFAULT_MODEL;
    }
    logInfo(`Используемая модель: "${model}"`);
    if (chatType !== 't2t') {
        const typeLabels = { t2i: 'изображение', t2v: 'видео' };
        logInfo(`Тип генерации: ${chatType} (${typeLabels[chatType] || chatType})${size ? `, размер: ${size}` : ''}`);
    }

    const browserContext = getBrowserContext();
    if (!browserContext) return { error: 'Браузер не инициализирован', chatId };

    const tokenObj = await resolveAuthToken(browserContext);
    if (!tokenObj) return { error: 'Ошибка авторизации: не удалось получить токен', chatId };

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);

        const verificationNeeded = await checkVerification(page);
        if (verificationNeeded) {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });
        }

        if (!authToken) {
            logWarn('Токен отсутствует перед отправкой запроса');
            authToken = await page.evaluate(() => localStorage.getItem('token'));
            if (!authToken) return { error: 'Токен авторизации не найден. Требуется перезапуск в ручном режиме.', chatId };
            saveAuthToken(authToken);
        }

        logInfo('Отправка запроса к API v2...');

        const payload = buildPayloadV2(messageContent, model, chatId, parentId, files, systemMessage, tools, toolChoice, chatType, size);
        logDebug('=== PAYLOAD V2 ===\n' + JSON.stringify(payload, null, 2));
        logDebug(`Отправка сообщения в чат ${chatId} с parent_id: ${parentId || 'null'}`);

        const apiUrl = `${CHAT_API_URL}?chat_id=${chatId}`;
        const response = await executeApiRequest(page, apiUrl, payload, authToken);

        if (response.success && response.isTask) {
            logInfo('Обнаружен ответ с задачей (видеогенерация)');
            logRaw(JSON.stringify(response.data));

            const taskId = extractTaskId(response.data);
            if (!taskId) {
                logError('Task ID не найден в ответе');
                pagePool.releasePage(page);
                page = null;
                return { error: 'Task ID not found in response', chatId, rawResponse: response.data };
            }

            logInfo(`Task ID: ${taskId}`);

            if (!waitForCompletion) {
                logInfo('Возвращаем task_id для клиентского polling');
                pagePool.releasePage(page);
                page = null;
                return {
                    id: taskId,
                    object: 'chat.completion.task',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    task_id: taskId,
                    chatId,
                    parentId: response.data.data?.parent_id || taskId,
                    status: 'processing',
                    message: 'Video generation task created. Poll GET /api/tasks/status/:taskId for progress.'
                };
            }

            logInfo('Начинаем polling для получения видео...');
            const taskResult = await pollTaskStatus(taskId, page, authToken);

            pagePool.releasePage(page);
            page = null;

            if (taskResult.success && taskResult.status === 'completed') {
                logInfo('Видео успешно сгенерировано');
                const videoUrl = extractVideoUrl(taskResult.data);
                return {
                    id: taskId,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: videoUrl || JSON.stringify(taskResult.data) },
                        finish_reason: 'stop'
                    }],
                    usage: taskResult.data.usage || { prompt_tokens: 0, output_tokens: 0, total_tokens: 0 },
                    response_id: taskId,
                    chatId,
                    parentId: taskId,
                    task_id: taskId,
                    video_url: videoUrl
                };
            }

            logError(`Не удалось получить видео: ${taskResult.error}`);
            return { error: taskResult.error || 'Video generation failed', status: taskResult.status, chatId, task_id: taskId };
        }

        pagePool.releasePage(page);
        page = null;

        if (response.success) {
            logRaw(JSON.stringify(response.data));
            logInfo('Ответ получен успешно');
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

            response.data.parentId = response.data.response_id;
            response.data.id = response.data.id || 'chatcmpl-' + Date.now();
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
        }

        return handleApiError(response, tokenObj, message, model, chatId, parentId, files, retryCount, chatType, size, waitForCompletion);
    } catch (error) {
        logError('Ошибка при отправке сообщения', error);
        return { error: error.toString(), chatId };
    } finally {
        if (page) {
            try {
                if (typeof getBrowserContext()?.newPage === 'function') await page.close();
            } catch (e) {
                logError('Ошибка при закрытии страницы', e);
            }
        }
    }
}

// ─── Task response helpers ───────────────────────────────────────────────────

function extractTaskId(data) {
    const firstMsg = data.data?.messages?.[0];
    if (firstMsg?.extra?.wanx?.task_id) return firstMsg.extra.wanx.task_id;
    return data.id || data.task_id || data.response_id || data.data?.message_id || null;
}

function extractVideoUrl(taskData) {
    if (taskData.content) return taskData.content;
    if (typeof taskData.result === 'string') return taskData.result;
    if (taskData.result?.url) return taskData.result.url;
    if (taskData.result?.video_url) return taskData.result.video_url;
    return null;
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

// ─── createChatV2 ────────────────────────────────────────────────────────────

export async function createChatV2(model = DEFAULT_MODEL, title = 'Новый чат', retryCount = 0) {
    const browserContext = getBrowserContext();
    if (!browserContext) return { error: 'Браузер не инициализирован' };

    const tokenObj = await getAvailableToken();
    if (tokenObj?.token) {
        authToken = tokenObj.token;
        logInfo(`Используется аккаунт для создания чата: ${tokenObj.id}`);
    }

    if (!authToken) {
        logInfo('Получение токена авторизации для создания чата...');
        authToken = await extractAuthToken(browserContext);
        if (!authToken) return { error: 'Не удалось получить токен авторизации' };
    }

    let page = null;
    try {
        page = await pagePool.getPage(browserContext);

        const payload = { title, models: [model], chat_mode: 'normal', chat_type: 't2t', timestamp: Date.now() };
        const requestBody = { apiUrl: CREATE_CHAT_URL, payload, token: authToken };

        const result = await page.evaluate(async (data) => {
            try {
                const response = await fetch(data.apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${data.token}` },
                    body: JSON.stringify(data.payload)
                });
                if (response.ok) return { success: true, data: await response.json() };
                return { success: false, status: response.status, errorBody: await response.text() };
            } catch (error) {
                return { success: false, error: error.toString() };
            }
        }, requestBody);

        pagePool.releasePage(page);
        page = null;

        if (result.success && result.data.success) {
            logInfo(`Чат создан: ${result.data.data.id}`);
            return { success: true, chatId: result.data.data.id, requestId: result.data.request_id };
        }

        const isTransient = result.status >= 500 && result.status < 600;
        if (isTransient && retryCount < MAX_RETRY_COUNT) {
            logWarn(`Создание чата: ${result.status}, ретрай ${retryCount + 1}/${MAX_RETRY_COUNT} через ${RETRY_DELAY}мс...`);
            await delay(RETRY_DELAY);
            return createChatV2(model, title, retryCount + 1);
        }

        const cleanError = isTransient
            ? `Qwen API недоступен (${result.status}). Повторите позже.`
            : (result.errorBody || result.error || 'Неизвестная ошибка');
        logError(`Ошибка при создании чата: ${result.status || 'unknown'} (попытка ${retryCount + 1})`);
        return { error: cleanError };
    } catch (error) {
        logError('Ошибка при создании чата', error);
        return { error: error.toString() };
    } finally {
        if (page) {
            try {
                if (typeof getBrowserContext()?.newPage === 'function') await page.close();
            } catch (e) {
                logError('Ошибка при закрытии страницы', e);
            }
        }
    }
}

// ─── testToken ───────────────────────────────────────────────────────────────

export async function testToken(token) {
    const browserContext = getBrowserContext();
    if (!browserContext) return 'ERROR';

    let page;
    try {
        page = await getPage(browserContext);
        await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded' });

        const evalData = {
            apiUrl: CREATE_CHAT_URL,
        const requestBody = {
            apiUrl: CHAT_API_URL,
            token,
            payload: {
                title: 'test',
                models: ['qwen-max-latest'],
                chat_mode: "normal",
                chat_type: "t2t",
                timestamp: Date.now()
            }
            payload: { chat_type: 't2t', messages: [{ role: 'user', content: 'ping', chat_type: 't2t' }], model: DEFAULT_MODEL, stream: false }
        };

        const result = await page.evaluate(async (data) => {
            try {
                const res = await fetch(data.apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${data.token}` },
                    body: JSON.stringify(data.payload)
                });
                return { ok: res.ok, status: res.status };
            } catch (e) {
                return { ok: false, status: 0, error: e.toString() };
            }
        }, requestBody);

        if (result.ok || result.status === 400) return 'OK';
        if (result.status === 401 || result.status === 403) return 'UNAUTHORIZED';
        if (result.status === 429) return 'RATELIMIT';
        return 'ERROR';
    } catch (e) {
        logError('testToken error', e);
        return 'ERROR';
    } finally {
        if (page) {
            try { if (typeof browserContext.newPage === 'function') await page.close(); } catch { }
        }
    }
}



