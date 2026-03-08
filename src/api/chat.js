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

    return page.evaluate(async (data) => {
        try {
            const t = data.token;
            if (!t) return { success: false, error: 'Токен авторизации не найден' };

            const response = await fetch(data.apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${t}`,
                    'Accept': '*/*'
                },
                body: JSON.stringify(data.payload)
            });

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

                while (!finished) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';

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
            response.data.parentId = response.data.response_id;
            response.data.id = response.data.id || 'chatcmpl-' + Date.now();
            return response.data;
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

        const requestBody = {
            apiUrl: CHAT_API_URL,
            token,
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
