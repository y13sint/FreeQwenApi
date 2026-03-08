/**
 * Interactive streaming chat client - test in terminal/console
 */

import axios from 'axios';
import readline from 'readline';

const API_URL = 'http://localhost:3264/api/chat/completions';

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(prompt) {
    return new Promise(resolve => {
        rl.question(prompt, resolve);
    });
}

async function streamChat(userMessage) {
    try {
        console.log('\n🤖 Assistant: ', '');
        
        const response = await axios.post(
            API_URL,
            {
                messages: [
                    {
                        role: 'user',
                        content: userMessage
                    }
                ],
                model: 'qwen-max-latest',
                stream: true
            },
            {
                headers: {
                    'User-Agent': 'InteractiveClient/1.0',
                    'Content-Type': 'application/json'
                },
                responseType: 'stream'
            }
        );

        let fullContent = '';
        let chunkCount = 0;
        
        await new Promise((resolve, reject) => {
            response.data.on('data', (chunk) => {
                const text = chunk.toString();
                const lines = text.split('\n').filter(line => line.trim());
                
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const json = JSON.parse(line.substring(6));
                            if (json.choices?.[0]?.delta?.content) {
                                const content = json.choices[0].delta.content;
                                process.stdout.write(content);
                                fullContent += content;
                                chunkCount++;
                            }
                        } catch (e) {
                            // Ignore parse errors
                        }
                    }
                }
            });
            
            response.data.on('end', () => {
                console.log('\n');
                resolve();
            });
            
            response.data.on('error', reject);
        });

        return fullContent;

    } catch (error) {
        console.error('\n❌ Error:', error.message);
        if (error.response?.status === 404) {
            console.error('Server not running at', API_URL);
        }
        return '';
    }
}

async function main() {
    console.log('╔════════════════════════════════════════╗');
    console.log('║  FreeQwenApi - Interactive Chat        ║');
    console.log('║  Type "exit" to quit                   ║');
    console.log('╚════════════════════════════════════════╝\n');

    while (true) {
        const userInput = await question('👤 You: ');
        
        if (userInput.toLowerCase() === 'exit') {
            console.log('\n👋 Goodbye!');
            rl.close();
            break;
        }

        if (!userInput.trim()) {
            continue;
        }

        await streamChat(userInput);
    }
}

main().catch(console.error);
