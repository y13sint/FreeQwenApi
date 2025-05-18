// auth.js - Модуль для авторизации и проверки авторизации
import { saveSession } from './session.js';
import { setAuthenticationStatus, getAuthenticationStatus, restartBrowserInHeadlessMode } from './browser.js';
import { extractAuthToken } from '../api/chat.js';

const AUTH_URL = 'https://chat.qwen.ai/';
const AUTH_SIGNIN_URL = 'https://chat.qwen.ai/auth?action=signin';

const VERIFICATION_TIMEOUT = 300000;

async function promptUser(question) {
    return new Promise(resolve => {
        process.stdout.write(question);

        const onData = (data) => {
            const input = data.toString().trim();
            process.stdin.removeListener('data', onData);
            process.stdin.pause();
            resolve(input);
        };

        process.stdin.resume();
        process.stdin.once('data', onData);
    });
}

export async function checkAuthentication(context) {
    try {
        if (getAuthenticationStatus()) {
            return true;
        }

        const page = await context.newPage();

        console.log('Проверка авторизации...');
        await page.goto(AUTH_URL);
        await page.waitForLoadState('domcontentloaded');

        await page.waitForTimeout(2000);

        const pageTitle = await page.title();
        const hasVerification = pageTitle.includes('Verification');

        if (hasVerification) {
            console.log('Обнаружена страница верификации. Пожалуйста, пройдите верификацию вручную.');

            await promptUser('После прохождения верификации нажмите ENTER для продолжения...');
            console.log('Верификация подтверждена пользователем.');
        }

        const loginContainerCount = await page.locator('.login-container').count();

        if (loginContainerCount === 0) {
            console.log('======================================================');
            console.log('               АВТОРИЗАЦИЯ ОБНАРУЖЕНА                 ');
            console.log('======================================================');

            setAuthenticationStatus(true);

            await extractAuthToken(context);
            await saveSession(context);

            console.log('Сессия сохранена успешно!');

            await page.close();

            await restartBrowserInHeadlessMode();

            return true;
        } else {
            console.log('------------------------------------------------------');
            console.log('               НЕОБХОДИМА АВТОРИЗАЦИЯ                 ');
            console.log('------------------------------------------------------');
            console.log('Пожалуйста, выполните следующие действия:');
            console.log('1. Войдите в систему через GitHub или другой способ в открытом браузере');
            console.log('2. Если вас перенаправляет на GitHub, разрешите доступ');
            console.log('3. Дождитесь завершения процесса авторизации в браузере');
            console.log('4. После завершения авторизации нажмите ENTER в этой консоли');
            console.log('------------------------------------------------------');

            await promptUser('После успешной авторизации нажмите ENTER для продолжения...');
            console.log('Пользователь подтвердил завершение авторизации.');

            await page.reload();
            await page.waitForLoadState('domcontentloaded');
            await page.waitForTimeout(2000);

            const loginElements = await page.locator('.login-container').count();
            if (loginElements === 0) {
                console.log('Авторизация подтверждена.');
                setAuthenticationStatus(true);

                await saveSession(context);
                await extractAuthToken(context);

                console.log('Сессия сохранена успешно!');
                console.log('======================================================');
                console.log('               АВТОРИЗАЦИЯ ВЫПОЛНЕНА!                 ');
                console.log('======================================================');
                console.log('Теперь вы можете использовать API через локальный прокси.');
                console.log('======================================================');

                await page.close();
                await restartBrowserInHeadlessMode();
                return true;
            } else {
                console.log('Предупреждение: Даже после подтверждения, система не обнаружила авторизацию.');
                console.log('Возможно, авторизация не была завершена корректно.');
                console.log('Попробуйте снова или проверьте страницу браузера.');
                setAuthenticationStatus(false);
                return false;
            }
        }
    } catch (error) {
        console.error('Ошибка при проверке авторизации:', error);
        setAuthenticationStatus(false);
        return false;
    }
}

export async function startManualAuthentication(context) {
    try {
        const page = await context.newPage();

        console.log('Открытие страницы для ручной авторизации...');
        await page.goto(AUTH_SIGNIN_URL);

        console.log('------------------------------------------------------');
        console.log('               НЕОБХОДИМА АВТОРИЗАЦИЯ                 ');
        console.log('------------------------------------------------------');
        console.log('Пожалуйста, выполните следующие действия:');
        console.log('1. Войдите в систему в открытом браузере');
        console.log('2. Дождитесь завершения процесса авторизации в браузере');
        console.log('3. После завершения авторизации нажмите ENTER в этой консоли');
        console.log('------------------------------------------------------');

        await promptUser('После успешной авторизации нажмите ENTER для продолжения...');
        console.log('Пользователь подтвердил завершение авторизации. Подождите...');

        await page.goto(AUTH_URL);
        await page.waitForLoadState('domcontentloaded');
        await page.waitForTimeout(2000);

        const loginElements = await page.locator('.login-container').count();

        if (loginElements === 0) {
            console.log('Авторизация подтверждена.');
            setAuthenticationStatus(true);

            await saveSession(context);

            await extractAuthToken(context);

            console.log('Сессия сохранена успешно!');
            console.log('======================================================');
            console.log('               АВТОРИЗАЦИЯ ВЫПОЛНЕНА!                 ');
            console.log('======================================================');
            console.log('Вы можете использовать API через локальный прокси.');
            console.log('======================================================');

            await page.close();
            await restartBrowserInHeadlessMode();
            return true;
        } else {
            console.log('Предупреждение: Даже после подтверждения, система не обнаружила авторизацию.');
            console.log('Возможно, авторизация не была завершена корректно.');
            console.log('Попробуйте снова или проверьте страницу браузера.');
            setAuthenticationStatus(false);
            return false;
        }
    } catch (error) {
        console.error('Ошибка при ручной авторизации:', error);
        setAuthenticationStatus(false);
        return false;
    }
}

export async function checkVerification(page) {
    try {
        const pageTitle = await page.title();
        const hasVerification = pageTitle.includes('Verification');

        if (hasVerification) {
            console.log('Обнаружена страница верификации');
            console.log('Пожалуйста, пройдите верификацию вручную в открытом браузере...');

            await promptUser('После прохождения верификации нажмите ENTER для продолжения...');
            console.log('Верификация подтверждена пользователем.');

            console.log('======================================================');
            console.log('               ВЕРИФИКАЦИЯ ПРОЙДЕНА!                  ');
            console.log('======================================================');
            return true;
        }

        return false;
    } catch (error) {
        console.error('Ошибка при проверке верификации:', error);
        return false;
    }
} 