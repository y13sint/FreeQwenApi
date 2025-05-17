import { getBrowserContext, getAuthenticationStatus, setAuthenticationStatus } from '../browser/browser.js';
import { checkAuthentication } from '../browser/auth.js';
import { checkVerification } from '../browser/auth.js';
import { shutdownBrowser, initBrowser } from '../browser/browser.js';
import { saveAuthToken, loadAuthToken } from '../browser/session.js';

const CHAT_API_URL = 'https://chat.qwen.ai/api/chat/completions';
const CHAT_PAGE_URL = 'https://chat.qwen.ai/';

let authToken = loadAuthToken();

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

export async function sendMessage(message, model = "qwen-max-latest") {
    const browserContext = getBrowserContext();
    if (!browserContext) {
        return { error: 'Браузер не инициализирован' };
    }

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
                    return { success: false, status: response.status, statusText: response.statusText };
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

            if (response.html && response.html.includes('Verification')) {
                setAuthenticationStatus(false);
                console.log('Обнаружена необходимость верификации, перезапуск браузера в видимом режиме...');

                await pagePool.clear();

                // Сбрасываем токен
                authToken = null;

                await shutdownBrowser();
                await initBrowser(true);

                return { error: 'Требуется верификация. Браузер запущен в видимом режиме.', verification: true };
            }

            return { error: response.error || response.statusText };
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