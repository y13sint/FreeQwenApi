import { getBrowserContext, getAuthenticationStatus, setAuthenticationStatus } from '../browser/browser.js';
import { checkAuthentication } from '../browser/auth.js';
import { checkVerification } from '../browser/auth.js';
import { shutdownBrowser, initBrowser } from '../browser/browser.js';
import { saveAuthToken, loadAuthToken } from '../browser/session.js';
import { loadHistory, addUserMessage, addAssistantMessage, createChat, chatExists } from './chatHistory.js';
import { getMappedModel } from './modelMapping.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHAT_API_URL = 'https://chat.qwen.ai/api/chat/completions';
const CHAT_PAGE_URL = 'https://chat.qwen.ai/';

const MODELS_FILE = path.join(__dirname, '..', 'AvaibleModels.txt');

let authToken = loadAuthToken();
let availableModels = null;


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

export async function extractAuthToken(context) {
    if (authToken) return authToken;

    try {
        const page = await context.newPage();
        await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded' });

        authToken = await page.evaluate(() => localStorage.getItem('token'));

        await page.close();

        if (authToken) {
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


export function isValidModel(modelName) {
    if (!availableModels) {
        availableModels = getAvailableModelsFromFile();
    }

    // Сначала проверяем, есть ли модель непосредственно в доступных
    if (availableModels.includes(modelName)) {
        return true;
    }

    // Если нет, проверяем, можно ли ее сопоставить с доступной
    const mappedModel = getMappedModel(modelName, null);
    return mappedModel !== null && availableModels.includes(mappedModel);
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

export async function sendMessage(message, model = "qwen-max-latest", chatId = null, files = null) {

    if (!availableModels) {
        availableModels = getAvailableModelsFromFile();
    }

    if (!chatId || !chatExists(chatId)) {
        chatId = createChat();
        console.log(`Создан новый чат с ID: ${chatId}`);
    }

    // Проверка и обработка сообщений
    try {
        if (typeof message === 'string') {
            // Если сообщение - это простая строка, добавляем ее как обычно
            addUserMessage(chatId, message);
        } else if (Array.isArray(message)) {
            // Если сообщение - это массив (текст + изображения), добавляем его как составное сообщение
            // Проверяем, что все элементы имеют корректную структуру
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
        // Используем функцию маппинга моделей для получения доступной модели
        const mappedModel = getMappedModel(model, "qwen-max-latest");
        if (mappedModel !== model) {
            console.log(`Модель "${model}" заменена на доступную модель "${mappedModel}"`);
            model = mappedModel;
        }
        
        // Дополнительная проверка на доступность модели
        if (!availableModels.includes(model)) {
            console.warn(`Предупреждение: Указанная модель "${model}" не найдена в списке доступных моделей. Используется модель по умолчанию.`);
            model = "qwen-max-latest";
        }
    }

    console.log(`Используемая модель: "${model}"`);

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

        // Получаем сообщения из нового формата истории
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

        const response = await page.evaluate(async (data) => {
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