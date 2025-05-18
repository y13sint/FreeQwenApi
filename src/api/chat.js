import { getBrowserContext, getAuthenticationStatus, setAuthenticationStatus } from '../browser/browser.js';
import { checkAuthentication } from '../browser/auth.js';
import { checkVerification } from '../browser/auth.js';
import { shutdownBrowser, initBrowser } from '../browser/browser.js';
import { saveAuthToken, loadAuthToken } from '../browser/session.js';
import { loadHistory, addUserMessage, addAssistantMessage, createChat, chatExists } from './chatHistory.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Получаем путь к текущему файлу и директории для ES модулей
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CHAT_API_URL = 'https://chat.qwen.ai/api/chat/completions';
const CHAT_PAGE_URL = 'https://chat.qwen.ai/';

// Путь к файлу со списком доступных моделей
const MODELS_FILE = path.join(__dirname, '..', 'AvaibleModels.txt');

let authToken = loadAuthToken();
let availableModels = null;

const pagePool = {
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

// Загрузка доступных моделей из файла
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

export async function sendMessage(message, model = "qwen-max-latest", chatId = null) {

    if (!availableModels) {
        availableModels = getAvailableModelsFromFile();
    }

    // Если chatId не передан или не существует, создаем новый чат
    if (!chatId || !chatExists(chatId)) {
        chatId = createChat();
        console.log(`Создан новый чат с ID: ${chatId}`);
    }

    // Добавляем сообщение пользователя в историю
    addUserMessage(chatId, message);

    if (!model || model.trim() === "") {
        model = "qwen-max-latest";
    } else {
        if (!isValidModel(model)) {
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
        const authCheck = await checkAuthentication(browserContext);
        if (!authCheck) {
            return { error: 'Требуется авторизация. Пожалуйста, авторизуйтесь в открытом браузере.', chatId };
        }
    }

    if (!authToken) {
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

        // Загружаем историю сообщений
        const history = loadHistory(chatId);

        // Формируем массив сообщений для API в формате Qwen
        const messages = history.map(msg => ({
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

            // Добавляем ответ ассистента в историю
            const assistantContent = response.data.choices && response.data.choices[0]?.message?.content || '';
            const responseInfo = response.data.usage || {};

            addAssistantMessage(chatId, assistantContent, responseInfo);

            // Добавляем chatId в ответ
            response.data.chatId = chatId;

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