import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { initBrowser, shutdownBrowser, getBrowserContext } from '../browser/browser.js';
import { extractAuthToken } from '../api/chat.js';
import { loadTokens, saveTokens, markValid, removeToken } from '../api/tokenManager.js';
import { loadAuthToken } from '../browser/session.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

function ensureAccountDir(id) {
    const accountDir = path.join(__dirname, '..', '..', 'session', 'accounts', id);
    if (!fs.existsSync(accountDir)) {
        fs.mkdirSync(accountDir, { recursive: true });
    }
    return accountDir;
}

export async function addAccountInteractive() {
    console.log('======================================================');
    console.log('Добавление нового аккаунта Qwen');
    console.log('Браузер откроется, войдите в систему, затем вернитесь к консоли.');
    console.log('======================================================');

    const ok = await initBrowser(true, true);
    if (!ok) {
        console.error('Не удалось запустить браузер.');
        return null;
    }



    const ctx = getBrowserContext();
    let token = await extractAuthToken(ctx, true);

    if (!token) {
        token = loadAuthToken();
        if (token) {
            console.log('Токен получен из сохранённого файла.');
        }
    }

    if (!token) {
        console.error('Токен не был получен. Аккаунт не добавлен.');
        await shutdownBrowser();
        return null;
    }

    await shutdownBrowser();
    // ---

    const id = 'acc_' + Date.now();


    ensureAccountDir(id);
    fs.writeFileSync(path.join(__dirname, '..', '..', 'session', 'accounts', id, 'token.txt'), token, 'utf8');

    const list = loadTokens();
    list.push({ id, token, resetAt: null });
    saveTokens(list);

    console.log(`Аккаунт '${id}' добавлен. Всего аккаунтов: ${list.length}`);
    console.log('======================================================');
    return id;
}

export async function interactiveAccountMenu() {
    while (true) {
        console.log('\n=== Меню управления аккаунтами ===');
        console.log('1 - Добавить новый аккаунт');
        console.log('2 - Завершить');
        const choice = await prompt('Ваш выбор (1/2): ');
        if (choice === '1') {
            await addAccountInteractive();
        } else if (choice === '2') {
            break;
        } else {
            console.log('Неверный выбор.');
        }
    }
}

export async function reloginAccountInteractive() {
    const tokens = loadTokens();
    const invalids = tokens.filter(t => t.invalid);
    if (!invalids.length) {
        console.log('Нет аккаунтов, требующих повторного входа.');
        await prompt('Нажмите ENTER чтобы вернуться в меню...');
        return;
    }

    console.log('\nАккаунты с истекшим токеном:');
    invalids.forEach((t, idx) => console.log(`${idx + 1} - ${t.id}`));
    const choice = await prompt('Выберите номер аккаунта для повторного входа: ');
    const num = parseInt(choice, 10);
    if (isNaN(num) || num < 1 || num > invalids.length) {
        console.log('Неверный выбор.');
        return;
    }
    const account = invalids[num - 1];

    console.log(`\nПовторная авторизация для ${account.id}`);
    const ok = await initBrowser(true, true);
    if (!ok) {
        console.error('Не удалось запустить браузер.');
        return;
    }

    const token = await extractAuthToken(getBrowserContext(), true);
    await shutdownBrowser();

    if (!token) {
        console.error('Не удалось извлечь токен.');
        return;
    }

    // сохраняем новый токен и снимаем invalid
    markValid(account.id, token);
    fs.writeFileSync(path.join(__dirname, '..', '..', 'session', 'accounts', account.id, 'token.txt'), token, 'utf8');

    console.log(`Токен обновлён для ${account.id}`);
}

export async function removeAccountInteractive() {
    const tokens = loadTokens();
    if (!tokens.length) {
        console.log('Нет сохранённых аккаунтов.');
        await prompt('ENTER чтобы вернуться...');
        return;
    }

    console.log('\nДоступные аккаунты:');
    tokens.forEach((t, idx) => console.log(`${idx + 1} - ${t.id}`));
    const choice = await prompt('Номер аккаунта, который нужно удалить (или ENTER для отмены): ');
    if (!choice) return;
    const num = parseInt(choice, 10);
    if (isNaN(num) || num < 1 || num > tokens.length) {
        console.log('Неверный выбор.');
        await prompt('ENTER чтобы вернуться...');
        return;
    }
    const acc = tokens[num - 1];
    const confirm = await prompt(`Точно удалить ${acc.id}? (y/N): `);
    if (confirm.toLowerCase() !== 'y') return;

    removeToken(acc.id);

    // удалить директорию аккаунта
    const dir = path.join(__dirname, '..', '..', 'session', 'accounts', acc.id);
    if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log(`Аккаунт ${acc.id} удалён.`);
    await prompt('ENTER чтобы вернуться...');
} 