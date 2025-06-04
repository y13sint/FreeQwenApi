// Пример управления диалогами через API прокси Qwen
// Установка: npm install axios
// Для запуска примера: node chat-management.js

import axios from 'axios';

const API_BASE_URL = 'http://localhost:3264/api';

async function chatManagementExample() {
    try {
        console.log('Демонстрация API управления диалогами\n');
        
        // 1. Создание нового диалога
        console.log('1. Создание нового диалога...');
        const createResponse = await axios.post(`${API_BASE_URL}/chats`, {
            name: 'Тестовый диалог о программировании'
        });
        
        const chatId = createResponse.data.chatId;
        console.log(`Создан диалог с ID: ${chatId}`);
        
        // 2. Отправка сообщения в этот диалог
        console.log('\n2. Отправка сообщения в диалог...');
        await axios.post(`${API_BASE_URL}/chat`, {
            message: 'Расскажи о Python и его преимуществах',
            chatId: chatId,
            model: 'qwen-max-latest'
        });
        console.log('Сообщение отправлено');
        
        // 3. Получение списка всех диалогов
        console.log('\n3. Получение списка всех диалогов...');
        const chatsResponse = await axios.get(`${API_BASE_URL}/chats`);
        console.log(`Найдено ${chatsResponse.data.chats.length} диалогов:`);
        chatsResponse.data.chats.forEach(chat => {
            console.log(`- ${chat.id}: ${chat.name} (${new Date(chat.createdAt).toLocaleString()})`);
        });
        
        // 4. Получение истории конкретного диалога
        console.log(`\n4. Получение истории диалога ${chatId}...`);
        const historyResponse = await axios.get(`${API_BASE_URL}/chats/${chatId}`);
        console.log(`Получена история диалога, ${historyResponse.data.history.messages.length} сообщений:`);
        historyResponse.data.history.messages.forEach(msg => {
            const timestamp = new Date(msg.timestamp * 1000).toLocaleTimeString();
            console.log(`[${timestamp}] ${msg.role}: ${typeof msg.content === 'string' ? msg.content.substring(0, 50) + '...' : '[Составное сообщение]'}`);
        });
        
        // 5. Переименование диалога
        console.log(`\n5. Переименование диалога ${chatId}...`);
        await axios.put(`${API_BASE_URL}/chats/${chatId}/rename`, {
            name: 'Обновленное название диалога'
        });
        console.log('Диалог переименован');
        
        // 6. Автоудаление старых диалогов (демонстрация API)
        console.log('\n6. Демонстрация API автоудаления диалогов...');
        const cleanupResponse = await axios.post(`${API_BASE_URL}/chats/cleanup`, {
            olderThan: 30 * 24 * 60 * 60 * 1000, // Диалоги старше 30 дней
            userMessageCountLessThan: 2,        // С менее чем 2 сообщениями пользователя
            maxChats: 100                       // Оставить максимум 100 диалогов
        });
        console.log(`Автоудаление: ${cleanupResponse.data.deletedCount} диалогов удалено`);
        
        // 7. Удаление тестового диалога
        console.log(`\n7. Удаление тестового диалога ${chatId}...`);
        await axios.delete(`${API_BASE_URL}/chats/${chatId}`);
        console.log('Тестовый диалог удален');
        
        console.log('\nПример управления диалогами успешно завершен!');
        
    } catch (error) {
        console.error('Ошибка в примере управления диалогами:', error);
        if (error.response) {
            console.error('Детали ошибки:', error.response.data);
        }
    }
}

// Запуск
chatManagementExample(); 