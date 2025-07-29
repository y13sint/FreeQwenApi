import { getBrowserContext, getAuthenticationStatus, setAuthenticationStatus } from '../browser/browser.js';
import { checkAuthentication } from '../browser/auth.js';
import { checkVerification } from '../browser/auth.js';
import { shutdownBrowser, initBrowser } from '../browser/browser.js';
import { saveAuthToken } from '../browser/session.js';
import { getAvailableToken, markRateLimited, removeInvalidToken } from './tokenManager.js';
import { loadHistory, addUserMessage, addAssistantMessage, createChat, chatExists } from './chatHistory.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHAT_API_URL = 'https://chat.qwen.ai/api/chat/completions';
const CHAT_PAGE_URL = 'https://chat.qwen.ai/';

const MODELS_FILE = path.join(__dirname, '..', 'AvaibleModels.txt');
const AUTH_KEYS_FILE = path.join(__dirname, '..', 'Authorization.txt');

let authToken = null;
let availableModels = null;
let authKeys = null;

export const pagePool = {
    pages: [],
    maxSize: 3,

    async getPage(context) {
        if (this.pages.length > 0) {
            return this.pages.pop();
        }

        const newPage = await context.newPage();
        await newPage.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded' });

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
        await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded' });

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

export async function sendMessage(message, model = "qwen-max-latest", chatId = null, files = null, tools = null, toolChoice = null) {

    if (!availableModels) {
        availableModels = getAvailableModelsFromFile();
    }

    if (!chatId || !chatExists(chatId)) {
        chatId = createChat();
        console.log(`Создан новый чат с ID: ${chatId}`);
    }

    try {
        if (typeof message === 'string') {
            addUserMessage(chatId, message);
        } else if (Array.isArray(message)) {
            const isValid = message.every(item =>
                (item.type === 'text' && typeof item.text === 'string') ||
                (item.type === 'image' && typeof item.image === 'string') ||
                (item.type === 'file' && typeof item.file === 'string')
            );

            if (!isValid) {
                console.error('Некорректная структура составного сообщения');
                return { error: 'Некорректная структура составного сообщения', chatId };
            }

            addUserMessage(chatId, message);
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
            await page.reload({ waitUntil: 'domcontentloaded' });
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

        console.log('Отправка запроса к API...');

        const history = loadHistory(chatId);

        const messages = Array.isArray(history)
            ? history.map(msg => ({
                role: msg.role,
                content: msg.content,
                chat_type: "t2t"
            }))
            : (history.messages || []).map(msg => ({
                role: msg.role,
                content: msg.content,
                chat_type: "t2t"
            }));

        const payload = {
            chat_type: "t2t",
            messages: messages,
            model: model,
            stream: false
        };

        // Проброс спецификации инструментов Cursor (если есть)
        if (tools) {
            payload.tools = tools;
        }

        if (toolChoice) {
            payload.tool_choice = toolChoice;
        }

        if (files && Array.isArray(files) && files.length > 0) {
            payload.files = files;
        }

        console.log(`Отправляемый запрос с историей из ${messages.length} сообщений`);

        const evalData = {
            apiUrl: CHAT_API_URL,
            payload: payload,
            token: authToken
        };

        console.log(`Используем токен: ${authToken ? 'Токен существует' : 'Токен отсутствует'}`);

        let response = await page.evaluate(async (data) => {
            try {
                const token = data.token;
                if (!token) {
                    return { success: false, error: 'Токен авторизации не найден' };
                }

                const response = await fetch(data.apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify(data.payload)
                });

                if (response.ok) {
                    const resultText = await response.text();
                    try {
                        return { success: true, data: JSON.parse(resultText) };
                    } catch (e) {
                        return { success: false, error: 'Не удалось распарсить ответ как JSON', html: resultText };
                    }
                } else {
                    const errorBody = await response.text();
                    return {
                        success: false,
                        status: response.status,
                        statusText: response.statusText,
                        errorBody: errorBody
                    };
                }
            } catch (error) {
                return { success: false, error: error.toString() };
            }
        }, evalData);

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
            console.log('Ответ получен успешно');

            const assistantContent = response.data.choices && response.data.choices[0]?.message?.content || '';
            const responseInfo = response.data.usage || {};

            addAssistantMessage(chatId, assistantContent, responseInfo);


            response.data.chatId = chatId;
            response.data.id = response.data.id || "chatcmpl-" + Date.now();

            return response.data;
        } else {
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
                    return await sendMessage(message, model, chatId, files); // повторяем с новым токеном
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
                return await sendMessage(message, model, chatId, files);
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

export async function clearPagePool() {
    await pagePool.clear();
}

export function getAuthToken() {
    return authToken;
}

export async function listModels(browserContext) {
    return await getAvailableModels(browserContext);
}

export async function testToken(token) {
    const browserContext = getBrowserContext();
    if (!browserContext) return 'ERROR';

    let page;
    try {
        page = await browserContext.newPage();
        await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded' });

        const evalData = {
            apiUrl: CHAT_API_URL,
            token,
            payload: {
                chat_type: 't2t',
                messages: [{ role: 'user', content: 'ping', chat_type: 't2t' }],
                model: 'qwen-max-latest',
                stream: false
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