// Пример использования OpenAI SDK с системным сообщением
// Установка: npm install openai

import OpenAI from 'openai';

const openai = new OpenAI({
    baseURL: 'http://localhost:3264/api', 
    apiKey: 'dummy-key', // Ключ не используется, но требуется для SDK
});

async function systemMessageExample() {
    try {
        console.log('Отправка запроса с системным сообщением к Qwen AI...\n');

        const completion = await openai.chat.completions.create({
            messages: [
                { 
                    role: 'system', 
                    content: 'Ты опытный астроном, который специализируется на планетах Солнечной системы. Отвечай научно точно, но понятным языком.' 
                },
                { 
                    role: 'user', 
                    content: 'Расскажи мне о Марсе и его особенностях' 
                }
            ],
            model: 'qwen-max-latest', 
        });

        console.log('Ответ от Qwen:\n');
        console.log(completion.choices[0].message.content);
        console.log('\nЗапрос с системным сообщением успешно выполнен.');

    } catch (error) {
        console.error('Ошибка при выполнении запроса:', error);
    }
}

// Запуск
systemMessageExample(); 