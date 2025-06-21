// Пример прямого запроса к API прокси Qwen с использованием fetch
// Для запуска примера: node fetch-example.js

async function directApiRequest() {
    try {
        console.log('Отправка прямого запроса к API Qwen...\n');
        
        const response = await fetch('http://localhost:3264/api/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                message: 'Объясни простыми словами, что такое искусственный интеллект',
                model: 'qwen-max-latest'
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ошибка! Статус: ${response.status}`);
        }
        
        const result = await response.json();
        
        console.log('Ответ от API:\n');
        console.log(result.choices[0].message.content);
        console.log('\nЗапрос успешно выполнен.');
        
        // Вывод дополнительной информации
        console.log('\nИнформация о запросе:');
        console.log(`ID чата: ${result.chatId}`);
        console.log(`Модель: ${result.model}`);
        
    } catch (error) {
        console.error('Ошибка при выполнении запроса:', error);
    }
}

// Запуск
directApiRequest(); 