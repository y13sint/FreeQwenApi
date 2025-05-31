// Пример использования OpenAI SDK с прокси для Qwen AI в потоковом режиме
// Установка: npm install openai

import OpenAI from 'openai';

const openai = new OpenAI({
    baseURL: 'http://localhost:3264/api', 
    apiKey: 'dummy-key', 
});

async function streamFromQwen() {
    try {
        console.log('Отправка потокового запроса к Qwen AI...\n');


        const stream = await openai.chat.completions.create({
            messages: [
                { role: 'user', content: 'Напиши небольшую историю о космических путешествиях' }
            ],
            model: 'qwen-max-latest', 
            stream: true, 
        });

        console.log('Ответ от Qwen (потоковый режим):\n');

        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || '';
            process.stdout.write(content);
        }

        console.log('\n\nПотоковый ответ завершен.');

    } catch (error) {
        console.error('Ошибка при выполнении потокового запроса:', error);
    }
}

// Запуск
streamFromQwen(); 