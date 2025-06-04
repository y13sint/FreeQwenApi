// Пример использования OpenAI SDK для анализа изображения
// Установка: npm install openai

import OpenAI from 'openai';

const openai = new OpenAI({
    baseURL: 'http://localhost:3264/api', 
    apiKey: 'dummy-key', // Ключ не используется, но требуется для SDK
});

// ВАЖНО: Замените URL_ИЗОБРАЖЕНИЯ на реальный URL изображения, полученный из интерфейса Qwen
// Инструкция по получению URL в README.md, раздел "Получение URL изображения из интерфейса Qwen"
const IMAGE_URL = "https://cdn.qwenlm.ai/bf6238a3-4578-49d6-b4a9-516e8a5eb27b/c88bc915-6ae7-4057-9bf9-1185c9141a0a_image.png?key=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyZXNvdXJjZV91c2VyX2lkIjoiYmY2MjM4YTMtNDU3OC00OWQ2LWI0YTktNTE2ZThhNWViMjdiIiwicmVzb3VyY2VfaWQiOiJjODhiYzkxNS02YWU3LTQwNTctOWJmOS0xMTg1YzkxNDFhMGEiLCJyZXNvdXJjZV9jaGF0X2lkIjpudWxsfQ.qPvHr4fq23IgzxmxOyFJuFcVL0AJlpGgPlWB8BHkrlo";

async function analyzeImage() {
    try {
        console.log('Отправка запроса с изображением к Qwen AI...\n');

        const completion = await openai.chat.completions.create({
            messages: [
                { 
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Опиши подробно, что изображено на этой картинке'
                        },
                        {
                            type: 'image',
                            image: 'https://cdn.qwenlm.ai/bf6238a3-4578-49d6-b4a9-516e8a5eb27b/c88bc915-6ae7-4057-9bf9-1185c9141a0a_image.png?key=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyZXNvdXJjZV91c2VyX2lkIjoiYmY2MjM4YTMtNDU3OC00OWQ2LWI0YTktNTE2ZThhNWViMjdiIiwicmVzb3VyY2VfaWQiOiJjODhiYzkxNS02YWU3LTQwNTctOWJmOS0xMTg1YzkxNDFhMGEiLCJyZXNvdXJjZV9jaGF0X2lkIjpudWxsfQ.qPvHr4fq23IgzxmxOyFJuFcVL0AJlpGgPlWB8BHkrlo'
                        }
                    ]
                }
            ],
            model: 'qwen3-235b-a22b', // Используем модель с поддержкой изображений
        });

        console.log('Ответ от Qwen:\n');
        console.log(completion.choices[0].message.content);
        console.log('\nАнализ изображения успешно выполнен.');

    } catch (error) {
        console.error('Ошибка при выполнении запроса с изображением (Убедитесь, что размер изображения не превышает 10MB):', error);
    }
}

// Запуск
analyzeImage(); 