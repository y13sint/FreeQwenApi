import { getBrowserContext, getAuthenticationStatus, setAuthenticationStatus } from '../browser/browser.js';
import { checkAuthentication } from '../browser/auth.js';
import { checkVerification } from '../browser/auth.js';
import { shutdownBrowser, initBrowser } from '../browser/browser.js';
import { saveAuthToken, loadAuthToken } from '../browser/session.js';

const CHAT_API_URL = 'https://chat.qwen.ai/api/chat/completions';
const CHAT_PAGE_URL = 'https://chat.qwen.ai/';
const MODELS_API_URL = 'https://chat.qwen.ai/api/models';

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

//export async function getAvailableModels(context) {
//    try {
//        if (!authToken) {
//            console.error('Токен отсутствует, невозможно запросить список моделей');
//            return null;
//         }

//        const page = await context.newPage();

//        try {
//            console.log('Извлекаем список доступных моделей из интерфейса...');
//
//            // Переходим на главную страницу чата
//            await page.goto(CHAT_PAGE_URL, { waitUntil: 'domcontentloaded' });
//            await page.waitForTimeout(2000); // Даем время для загрузки страницы
//
//            // Пытаемся найти меню выбора моделей и открыть его
//            const modelSelector = '.ant-select-selection-search, .model-selector';
//
//            // Проверяем наличие селектора моделей
//            const hasSelectorElement = await page.locator(modelSelector).count() > 0;
//            if (!hasSelectorElement) {
//                console.log('Селектор моделей не найден, попробуем получить альтернативным способом...');

//                // Альтернативный подход - извлечем доступные модели из страницы другим способом
//                // Извлекаем все глобальные переменные и ищем в них упоминания о моделях
//                const extractedModels = await page.evaluate(() => {
//                    try {
//                        // Просматриваем весь HTML страницы для поиска упоминаний моделей
//                        const html = document.documentElement.innerHTML;

//                        // Ищем характерные упоминания моделей
//                        const modelMatches = html.match(/"model"\s*:\s*"([^"]+)"/g) || [];
//                        const uniqueModels = new Set();
//
// Извлекаем имена моделей из совпадений
//                        modelMatches.forEach(match => {
//                            const modelName = match.match(/"model"\s*:\s*"([^"]+)"/)[1];
//                            if (modelName && !modelName.includes('${') && modelName.startsWith('qwen')) {
//                                uniqueModels.add(modelName);
//                            }
//                        });
//
//                        // Добавляем известные модели, если они не были найдены
//                        const knownModels = ['qwen-max', 'qwen-max-latest', 'qwen-plus', 'qwen-turbo'];
//                        knownModels.forEach(model => uniqueModels.add(model));

//                       return Array.from(uniqueModels);
//                    } catch (error) {
//                        console.error('Ошибка при извлечении моделей:', error);
//                        return null;
//                    }
//                  });

//                if (extractedModels && extractedModels.length > 0) {
//                    console.log('Найдены модели альтернативным способом:', extractedModels);

//                    // Формируем результат в формате, который ожидает API
//                    const result = {
//                        models: extractedModels.map(model => ({
//                            id: model,
//                            name: model,
//                            description: `Модель ${model}`
//                        }))
//                    };

//                    availableModels = result;
//                    return result;
//                }

//                return {
//                    models: [
//                        { id: 'qwen-max-latest', name: 'Qwen Max (latest)', description: 'Рекомендуемая модель (по умолчанию)' },
//                        { id: 'qwen-max', name: 'Qwen Max', description: 'Модель Qwen Max' },
//                        { id: 'qwen-plus', name: 'Qwen Plus', description: 'Модель Qwen Plus' },
//                        { id: 'qwen-turbo', name: 'Qwen Turbo', description: 'Быстрая модель Qwen Turbo' }
//                    ]
//                };
//            }

//            // Нажимаем на селектор моделей, чтобы открыть выпадающий список
//            await page.click(modelSelector);
//            await page.waitForTimeout(1000);

// Извлекаем список моделей из выпадающего списка
//            const modelItems = await page.locator('.ant-select-item, .model-option').all();

//            const models = [];
//            for (const item of modelItems) {
//                const modelText = await item.textContent();
//                const modelId = await item.getAttribute('title') || modelText;

//                models.push({
//                    id: modelId.toLowerCase().trim(),
//                    name: modelText.trim(),
//                    description: `Модель ${modelText.trim()}`
//                });
//            }

//            console.log('Получен список доступных моделей из UI:', models);

//            const result = { models };
//            availableModels = result;
//            return result;
//        } finally {
//            await page.close();
//        }
//    } catch (error) {
//        console.error('Ошибка при запросе списка моделей:', error);
//        // Возвращаем фиксированный список моделей в случае ошибки
//        return {
//            models: [
//                { id: 'qwen-max-latest', name: 'Qwen Max (latest)', description: 'Рекомендуемая модель (по умолчанию)' },
//                { id: 'qwen-max', name: 'Qwen Max', description: 'Модель Qwen Max' },
//                { id: 'qwen-plus', name: 'Qwen Plus', description: 'Модель Qwen Plus' },
//                { id: 'qwen-turbo', name: 'Qwen Turbo', description: 'Быстрая модель Qwen Turbo' }
//            ]
//        };
//    }
//  }

export async function sendMessage(message, model = "qwen-max-latest") {

    model = (!model || model.trim() === "") ? "qwen-max-latest" : model;

    const browserContext = getBrowserContext();
    if (!browserContext) {
        return { error: 'Браузер не инициализирован' };
    }

    // if (!availableModels) {
    //     await getAvailableModels(browserContext);
    // }

    if (!getAuthenticationStatus()) {
        const authCheck = await checkAuthentication(browserContext);
        if (!authCheck) {
            return { error: 'Требуется авторизация. Пожалуйста, авторизуйтесь в открытом браузере.' };
        }
    }

    if (!authToken) {
        authToken = await extractAuthToken(browserContext);
        if (!authToken) {
            console.error('Не удалось получить токен авторизации');
            return { error: 'Ошибка авторизации: не удалось получить токен' };
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
                return { error: 'Токен авторизации не найден. Требуется перезапуск в ручном режиме.' };
            } else {
                saveAuthToken(authToken);
            }
        }

        console.log('Отправка запроса к API...');

        const payload = {
            chat_type: "t2t",
            messages: [
                { role: "user", content: message, extra: {}, chat_type: "t2t" },
            ],
            model: model,
            stream: false
        };

        console.log(`Отправляемый запрос: ${JSON.stringify(payload)}`);

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

                return { error: 'Требуется верификация. Браузер запущен в видимом режиме.', verification: true };
            }

            return { error: response.error || response.statusText, details: response.errorBody || 'Нет дополнительных деталей' };
        }
    } catch (error) {
        console.error('Ошибка при отправке сообщения:', error);
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

export async function clearPagePool() {
    await pagePool.clear();
}

export function getAuthToken() {
    return authToken;
}

export async function listModels(browserContext) {
    return await getAvailableModels(browserContext);
} 