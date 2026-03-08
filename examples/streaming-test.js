// Пример использования streaming API через /api/chat
// Запуск: node examples/streaming-test.js

async function testStreaming() {
    console.log('🧪 Тестирование НАСТОЯЩЕГО стриминга через /api/chat\n');
    console.log('📡 Ожидание первого чанка...\n');

    const startTime = Date.now();
    let firstChunkTime = null;

    const response = await fetch('http://localhost:3264/api/chat', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            message: 'Расскажи короткую историю о космосе (5-7 предложений)',
            model: 'qwen-max-latest',
            stream: true
        })
    });

    if (!response.ok) {
        console.error(`❌ Ошибка HTTP: ${response.status}`);
        return;
    }

    console.log('✅ Получен ответ, начинаем чтение потока...\n');
    console.log('📝 Текст ответа:\n');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let chunkCount = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.trim() || !line.startsWith('data: ')) continue;
            if (line === 'data: [DONE]') {
                const endTime = Date.now();
                console.log('\n\n✅ Стриминг завершён');
                console.log(`📊 Статистика:`);
                console.log(`   - Получено чанков: ${chunkCount}`);
                console.log(`   - Время до первого чанка: ${firstChunkTime - startTime}мс`);
                console.log(`   - Общее время: ${endTime - startTime}мс`);
                console.log(`   - Длина ответа: ${fullContent.length} символов`);
                console.log(`   - Средняя скорость: ${Math.round(fullContent.length / ((endTime - firstChunkTime) / 1000))} символов/сек`);
                return;
            }

            try {
                const jsonStr = line.substring(6).trim();
                if (!jsonStr) continue;

                const chunk = JSON.parse(jsonStr);
                const content = chunk.choices?.[0]?.delta?.content || '';
                if (content) {
                    if (!firstChunkTime) {
                        firstChunkTime = Date.now();
                    }
                    chunkCount++;
                    process.stdout.write(content);
                    fullContent += content;
                }
            } catch (e) {
                // Игнорируем ошибки парсинга
            }
        }
    }

    console.log(`\n\n📊 Полный ответ (${fullContent.length} символов)`);
}

testStreaming().catch(console.error);
