// Скрипт interactively добавляет новые аккаунты.
// Запуск: node scripts/addAccount.js

import { interactiveAccountMenu } from '../src/utils/accountSetup.js';

(async () => {
    await interactiveAccountMenu();
})(); 