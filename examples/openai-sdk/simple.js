// Пример использования OpenAI SDK с прокси для Qwen AI - обычный запрос
// Установка: npm install openai

import OpenAI from 'openai';

const openai = new OpenAI({
    baseURL: 'http://localhost:3264/api', 
    apiKey: 'dummy-key', // Ключ не используется, но требуется для SDK
});

async function simpleRequest() {
    try {
        console.log('Отправка запроса к Qwen AI...\n');

        const completion = await openai.chat.completions.create({
            messages: [
                { role: 'user', content: 'Напиши 5 интересных фактов о космосе' }
            ],
            model: 'qwen-max-latest', 
        });

        console.log('Ответ от Qwen:\n');
        console.log(completion.choices[0].message.content);
        console.log('\nЗапрос успешно выполнен.');

    } catch (error) {
        console.error('Ошибка при выполнении запроса:', error);
    }
}

// Запуск
simpleRequest(); 