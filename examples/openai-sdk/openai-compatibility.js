// Пример, демонстрирующий совместимость с OpenAI API
// Установка: npm install openai

import OpenAI from 'openai';

// Настройка клиента OpenAI с использованием нашего прокси как точки доступа
const openai = new OpenAI({
    baseURL: 'http://localhost:3264/api', 
    apiKey: 'dummy-key', // Ключ не используется, но требуется для SDK
});

async function openaiCompatibilityExample() {
    try {
        console.log('Демонстрация совместимости с OpenAI API\n');
        
        // 1. Стандартный запрос в формате OpenAI
        console.log('1. Стандартный запрос в формате OpenAI...');
        
        const completion = await openai.chat.completions.create({
            model: 'qwen-max-latest',
            messages: [
                { role: 'system', content: 'Ты полезный ассистент, который дает краткие и четкие ответы.' },
                { role: 'user', content: 'Что такое искусственный интеллект?' }
            ],
            temperature: 0.7,
        });
        
        console.log('Ответ:');
        console.log(completion.choices[0].message.content);
        
        // 2. Потоковый запрос в формате OpenAI
        console.log('\n2. Потоковый запрос в формате OpenAI...');
        
        console.log('Ответ (потоковый режим):');
        const stream = await openai.chat.completions.create({
            model: 'qwen-max-latest',
            messages: [
                { role: 'system', content: 'Ты полезный ассистент, который отвечает кратко.' },
                { role: 'user', content: 'Перечисли 5 самых популярных языков программирования' }
            ],
            stream: true,
        });
        
        let streamedContent = '';
        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || '';
            streamedContent += content;
            process.stdout.write(content);
        }
        console.log('\n');
        
        // 3. Демонстрация структуры ответа в формате OpenAI
        console.log('\n3. Структура ответа в формате OpenAI:');
        
        const responseDemo = await openai.chat.completions.create({
            model: 'qwen-max-latest',
            messages: [{ role: 'user', content: 'Привет!' }],
        });
        
        // Выводим структуру ответа (без содержимого сообщения)
        const { choices, ...responseWithoutChoices } = responseDemo;
        console.log(JSON.stringify({
            ...responseWithoutChoices,
            choices: [{
                ...choices[0],
                message: { role: choices[0].message.role, content: '[содержимое сообщения скрыто для краткости]' }
            }]
        }, null, 2));
        

        
    } catch (error) {
        console.error('Ошибка при выполнении примера:', error);
    }
}

// Запуск
openaiCompatibilityExample(); 