// Пример использования OpenAI SDK для диалога с несколькими сообщениями
// Установка: npm install openai

import OpenAI from 'openai';

const openai = new OpenAI({
    baseURL: 'http://localhost:3264/api', 
    apiKey: 'dummy-key', // Ключ не используется, но требуется для SDK
});

async function conversationExample() {
    try {
        console.log('Начинаем диалог с Qwen AI...\n');
        
        // Первое сообщение пользователя
        console.log('Пользователь: Привет! Расскажи о квантовой физике простыми словами.');
        
        let completion = await openai.chat.completions.create({
            messages: [
                { role: 'user', content: 'Привет! Расскажи о квантовой физике простыми словами.' }
            ],
            model: 'qwen-max-latest',
        });
        
        const assistantResponse1 = completion.choices[0].message.content;
        console.log('\nQwen:', assistantResponse1);
        
        // Второе сообщение пользователя, включающее историю беседы
        console.log('\nПользователь: А как это связано с теорией относительности?');
        
        completion = await openai.chat.completions.create({
            messages: [
                { role: 'user', content: 'Привет! Расскажи о квантовой физике простыми словами.' },
                { role: 'assistant', content: assistantResponse1 },
                { role: 'user', content: 'А как это связано с теорией относительности?' }
            ],
            model: 'qwen-max-latest',
        });
        
        const assistantResponse2 = completion.choices[0].message.content;
        console.log('\nQwen:', assistantResponse2);
        
        // Третье сообщение пользователя
        console.log('\nПользователь: Спасибо! Кто из ученых внес наибольший вклад в развитие этих теорий?');
        
        completion = await openai.chat.completions.create({
            messages: [
                { role: 'user', content: 'Привет! Расскажи о квантовой физике простыми словами.' },
                { role: 'assistant', content: assistantResponse1 },
                { role: 'user', content: 'А как это связано с теорией относительности?' },
                { role: 'assistant', content: assistantResponse2 },
                { role: 'user', content: 'Спасибо! Кто из ученых внес наибольший вклад в развитие этих теорий?' }
            ],
            model: 'qwen-max-latest',
        });
        
        console.log('\nQwen:', completion.choices[0].message.content);
        console.log('\nДиалог успешно завершен.');

    } catch (error) {
        console.error('Ошибка при выполнении диалога:', error);
    }
}

// Запуск
conversationExample(); 