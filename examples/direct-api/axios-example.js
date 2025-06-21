// Пример прямого запроса к API прокси Qwen с использованием axios
// Установка: npm install axios
// Для запуска примера: node axios-example.js

import axios from 'axios';

async function axiosExample() {
    try {
        console.log('Отправка запроса через axios к API Qwen...\n');
        
        // Пример с форматом messages, совместимым с OpenAI
        const response = await axios.post('http://localhost:3264/api/chat', {
            messages: [
                { role: 'system', content: 'Ты эксперт по программированию на JavaScript.' },
                { role: 'user', content: 'Объясни, как работают асинхронные функции в JavaScript' }
            ],
            model: 'qwen-max-latest'
        });
        
        console.log('Ответ от API:\n');
        console.log(response.data.choices[0].message.content);
        console.log('\nЗапрос успешно выполнен.');
        
        // Вывод дополнительной информации
        console.log('\nИнформация о запросе:');
        console.log(`ID чата: ${response.data.chatId}`);
        console.log(`Модель: ${response.data.model}`);
        
        // Сохраняем ID чата для следующего примера
        const chatId = response.data.chatId;
        
        // Продолжаем диалог в том же чате
        console.log('\n\nОтправка второго сообщения в тот же чат...\n');
        
        const followUpResponse = await axios.post('http://localhost:3264/api/chat', {
            message: 'Приведи пример использования async/await',
            model: 'qwen-max-latest',
            chatId: chatId
        });
        
        console.log('Ответ на второе сообщение:\n');
        console.log(followUpResponse.data.choices[0].message.content);
        
    } catch (error) {
        console.error('Ошибка при выполнении запроса:', error);
        if (error.response) {
            console.error('Детали ошибки:', error.response.data);
        }
    }
}

// Запуск
axiosExample(); 