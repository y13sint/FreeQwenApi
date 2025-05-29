import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { logInfo, logError, logDebug } from '../logger/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HISTORY_DIR = path.join(__dirname, '..', '..', 'session', 'history');

const MAX_HISTORY_LENGTH = 100;

export function initHistoryDirectory() {
    if (!fs.existsSync(HISTORY_DIR)) {
        fs.mkdirSync(HISTORY_DIR, { recursive: true });
        logInfo(`Создана директория для истории чатов: ${HISTORY_DIR}`);
    }
}

export function generateChatId() {
    return crypto.randomUUID();
}

export function createChat(chatName) {
    const chatId = generateChatId();
    const chatInfo = {
        id: chatId,
        name: chatName || `Новый чат ${new Date().toLocaleString()}`,
        created: Date.now(),
        messages: []
    };
    saveHistory(chatId, chatInfo);
    logInfo(`Создан новый чат [${chatId}] с именем "${chatInfo.name}"`);
    return chatId;
}

function getHistoryFilePath(chatId) {
    return path.join(HISTORY_DIR, `${chatId}.json`);
}

export function saveHistory(chatId, data) {
    try {
        initHistoryDirectory();
        const historyFilePath = getHistoryFilePath(chatId);
        fs.writeFileSync(historyFilePath, JSON.stringify(data, null, 2), 'utf8');
        logDebug(`История чата ${chatId} успешно сохранена`);
        return true;
    } catch (error) {
        logError(`Ошибка при сохранении истории чата ${chatId}`, error);
        return false;
    }
}

export function loadHistory(chatId) {
    try {
        const historyFilePath = getHistoryFilePath(chatId);
        if (fs.existsSync(historyFilePath)) {
            const rawData = fs.readFileSync(historyFilePath, 'utf8');
            logDebug(`Данные чата ${chatId} успешно загружены`);

            let data;
            try {
                data = JSON.parse(rawData);
                logDebug(`Данные чата ${chatId} успешно распарсены`);
            } catch (parseErr) {
                logError(`Ошибка при парсинге данных чата ${chatId}`, parseErr);
                return {
                    id: chatId,
                    name: `Восстановленный чат ${new Date().toLocaleString()}`,
                    created: Date.now(),
                    messages: []
                };
            }

            // Поддержка обратной совместимости со старым форматом
            if (Array.isArray(data)) {
                logDebug(`Чат ${chatId} использует устаревший формат, выполняется конвертация`);
                return {
                    id: chatId,
                    name: `Чат от ${new Date().toLocaleString()}`,
                    created: Date.now(),
                    messages: data,
                    wasConverted: true
                };
            }

            // Проверяем наличие обязательных полей
            if (!data.messages) {
                logInfo(`Чат ${chatId} не содержит сообщений, инициализируем пустой массив`);
                data.messages = [];
            }

            if (!data.name) {
                data.name = `Чат ${chatId.substring(0, 6)}`;
            }

            if (!data.created) {
                data.created = Date.now();
            }

            if (!data.id) {
                data.id = chatId;
            }

            return data;
        } else {
            logInfo(`Файл истории для чата ${chatId} не найден`);
        }
    } catch (error) {
        logError(`Ошибка при загрузке истории чата ${chatId}`, error);
    }

    // Если не удалось загрузить, создаем новые данные
    logInfo(`Создаем новую историю для чата ${chatId}`);
    return {
        id: chatId,
        name: `Новый чат ${new Date().toLocaleString()}`,
        created: Date.now(),
        messages: []
    };
}

export function chatExists(chatId) {
    const historyFilePath = getHistoryFilePath(chatId);
    const exists = fs.existsSync(historyFilePath);
    logDebug(`Проверка существования чата ${chatId}: ${exists ? 'найден' : 'не найден'}`);
    return exists;
}

export function renameChat(chatId, newName) {
    try {
        if (!chatExists(chatId)) {
            logError(`Попытка переименовать несуществующий чат ${chatId}`);
            return false;
        }

        const chatData = loadHistory(chatId);
        const oldName = chatData.name;
        chatData.name = newName;
        const success = saveHistory(chatId, chatData);
        if (success) {
            logInfo(`Чат ${chatId} переименован: "${oldName}" -> "${newName}"`);
        } else {
            logError(`Не удалось переименовать чат ${chatId}`);
        }
        return success;
    } catch (error) {
        logError(`Ошибка при переименовании чата ${chatId}`, error);
        return false;
    }
}

export function addUserMessage(chatId, content) {
    const timestamp = Math.floor(Date.now() / 1000);
    const messageId = crypto.randomUUID();

    // Определяем тип содержимого и его длину для логирования
    let contentDesc;
    if (Array.isArray(content)) {
        // Составное сообщение (текст + изображения)
        const textParts = content.filter(item => item.type === 'text');
        const imageParts = content.filter(item => item.type === 'image');
        const fileParts = content.filter(item => item.type === 'file');

        contentDesc = `составное сообщение (${textParts.length} текст., ${imageParts.length} изобр., ${fileParts.length} файл.)`;
    } else if (typeof content === 'object' && content !== null) {
        contentDesc = 'объект-сообщение';
    } else {
        contentDesc = `текст длиной ${String(content).length}`;
    }

    const message = {
        id: messageId,
        role: "user",
        content: content,
        timestamp: timestamp,
        chat_type: "t2t"
    };

    logInfo(`Добавление сообщения пользователя в чат ${chatId}: ${contentDesc}`);
    return addMessageToHistory(chatId, message);
}

export function addAssistantMessage(chatId, content, info = {}) {
    const timestamp = Math.floor(Date.now() / 1000);
    const messageId = crypto.randomUUID();

    const message = {
        id: messageId,
        role: "assistant",
        content: content,
        timestamp: timestamp,
        info: info,
        chat_type: "t2t"
    };

    logInfo(`Добавление ответа ассистента в чат ${chatId}, длина: ${content.length}`);
    return addMessageToHistory(chatId, message);
}

function addMessageToHistory(chatId, message) {
    try {
        let chatData = loadHistory(chatId);

        if (chatData.messages.length >= MAX_HISTORY_LENGTH) {
            logInfo(`Чат ${chatId} достиг максимальной длины (${MAX_HISTORY_LENGTH}), удаляем старые сообщения`);
            chatData.messages = [chatData.messages[0], ...chatData.messages.slice(chatData.messages.length - MAX_HISTORY_LENGTH + 2)];
        }

        chatData.messages.push(message);
        saveHistory(chatId, chatData);
        logDebug(`Сообщение ${message.id} успешно добавлено в чат ${chatId}`);

        return message.id;
    } catch (error) {
        logError(`Ошибка при добавлении сообщения в историю чата ${chatId}`, error);
        return null;
    }
}

export function getAllChats() {
    try {
        initHistoryDirectory();
        const files = fs.readdirSync(HISTORY_DIR);
        logDebug(`Получен список файлов чатов: ${files.length} файлов`);

        let convertedCount = 0;
        const chats = files
            .filter(file => file.endsWith('.json'))
            .map(file => {
                const chatId = file.replace('.json', '');
                const chatData = loadHistory(chatId);

                // Проверяем, был ли выполнен перевод формата
                if (chatData.wasConverted) {
                    convertedCount++;
                }

                return {
                    id: chatId,
                    name: chatData.name || `Чат ${chatId.substring(0, 6)}`,
                    created: chatData.created || 0,
                    messageCount: chatData.messages ? chatData.messages.length : 0,
                    userMessageCount: chatData.messages ?
                        chatData.messages.filter(m => m.role === 'user').length : 0
                };
            });

        if (convertedCount > 0) {
            logInfo(`Конвертировано ${convertedCount} чатов из устаревшего формата`);
        }

        logInfo(`Обработано ${chats.length} чатов`);
        return chats.sort((a, b) => b.created - a.created);
    } catch (error) {
        logError('Ошибка при получении списка чатов', error);
        return [];
    }
}

export function deleteChat(chatId) {
    try {
        const historyFilePath = getHistoryFilePath(chatId);
        if (fs.existsSync(historyFilePath)) {
            fs.unlinkSync(historyFilePath);
            logInfo(`Чат ${chatId} успешно удален`);
            return true;
        } else {
            logError(`Попытка удаления несуществующего чата ${chatId}`);
        }
    } catch (error) {
        logError(`Ошибка при удалении чата ${chatId}`, error);
    }
    return false;
}

export function deleteChatsAutomatically(criteria = {}) {
    try {
        const { olderThan, userMessageCountLessThan, messageCountLessThan, maxChats } = criteria;
        logInfo(`Автоудаление чатов с критериями: ${JSON.stringify(criteria)}`);

        const chats = getAllChats();
        logInfo(`Найдено ${chats.length} чатов для проверки`);

        let chatsToDelete = [...chats];

        // Фильтрация по возрасту (в миллисекундах)
        if (olderThan) {
            const cutoffTime = Date.now() - olderThan;
            const oldChatsCount = chatsToDelete.filter(chat => chat.created < cutoffTime).length;
            logInfo(`Чатов старше ${olderThan}мс (${new Date(cutoffTime).toLocaleString()}): ${oldChatsCount}`);
            chatsToDelete = chatsToDelete.filter(chat => chat.created < cutoffTime);
        }

        // Фильтрация по количеству сообщений пользователя
        if (userMessageCountLessThan !== undefined) {
            const lowUserMsgChatsCount = chatsToDelete.filter(chat =>
                chat.userMessageCount < userMessageCountLessThan).length;
            logInfo(`Чатов с менее чем ${userMessageCountLessThan} сообщений пользователя: ${lowUserMsgChatsCount}`);
            chatsToDelete = chatsToDelete.filter(chat =>
                chat.userMessageCount < userMessageCountLessThan);
        }

        // Фильтрация по общему количеству сообщений
        if (messageCountLessThan !== undefined) {
            const lowMsgChatsCount = chatsToDelete.filter(chat =>
                chat.messageCount < messageCountLessThan).length;
            logInfo(`Чатов с менее чем ${messageCountLessThan} сообщений всего: ${lowMsgChatsCount}`);
            chatsToDelete = chatsToDelete.filter(chat =>
                chat.messageCount < messageCountLessThan);
        }

        // Удаление старых чатов, если их общее количество превышает maxChats
        if (maxChats && chats.length > maxChats) {
            logInfo(`Общее количество чатов (${chats.length}) превышает лимит (${maxChats}), удаляем старые чаты`);
            // Сортировка по дате создания (от старых к новым)
            const sortedChats = [...chats].sort((a, b) => a.created - b.created);
            // Получение самых старых чатов для удаления
            const oldestChats = sortedChats.slice(0, chats.length - maxChats);

            // Добавление ID чатов, которые еще не в списке удаления
            oldestChats.forEach(chat => {
                if (!chatsToDelete.some(c => c.id === chat.id)) {
                    chatsToDelete.push(chat);
                }
            });
        }

        // Удаление выбранных чатов
        const deletedChats = [];
        logInfo(`Найдено ${chatsToDelete.length} чатов для удаления`);

        for (const chat of chatsToDelete) {
            if (deleteChat(chat.id)) {
                deletedChats.push(chat.id);
            }
        }

        logInfo(`Удалено ${deletedChats.length} чатов`);
        return {
            success: true,
            deletedCount: deletedChats.length,
            deletedChats
        };
    } catch (error) {
        logError('Ошибка при автоматическом удалении чатов', error);
        return {
            success: false,
            error: error.message
        };
    }
} 