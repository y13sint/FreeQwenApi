/**
 * Test streaming API
 */

import axios from 'axios';

const API_URL = 'http://localhost:3264/api/chat/completions';

async function testStreaming() {
    try {
        console.log('=== Testing Streaming API ===\n');
        
        // First request: introduce yourself
        console.log('POST 1: Stream "Привет, я Дима"');
        
        const response1 = await axios.post(
            API_URL,
            {
                messages: [
                    {
                        role: 'user',
                        content: 'Привет, я Дима'
                    }
                ],
                model: 'qwen-max-latest',
                stream: true
            },
            {
                headers: {
                    'User-Agent': 'TestClient/1.0'
                },
                responseType: 'stream'
            }
        );

        // Handle streaming response
        let fullContent1 = '';
        let chunkCount1 = 0;
        
        await new Promise((resolve, reject) => {
            response1.data.on('data', (chunk) => {
                const text = chunk.toString();
                const lines = text.split('\n').filter(line => line.trim());
                
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const json = JSON.parse(line.substring(6));
                            if (json.choices?.[0]?.delta?.content) {
                                const content = json.choices[0].delta.content;
                                process.stdout.write(content); // Real-time output
                                fullContent1 += content;
                                chunkCount1++;
                            }
                        } catch (e) {
                            // Ignore parse errors
                        }
                    }
                }
            });
            
            response1.data.on('end', () => {
                console.log('\n');
                console.log(`✅ Stream 1 complete. Chunks: ${chunkCount1}, Total length: ${fullContent1.length}`);
                resolve();
            });
            
            response1.data.on('error', reject);
        });

        // Wait a bit before second request
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Second request: ask about name
        console.log('\nPOST 2: Stream "Как меня зовут?"');
        
        const response2 = await axios.post(
            API_URL,
            {
                messages: [
                    {
                        role: 'user',
                        content: 'Как меня зовут?'
                    }
                ],
                model: 'qwen-max-latest',
                stream: true
            },
            {
                headers: {
                    'User-Agent': 'TestClient/1.0'
                },
                responseType: 'stream'
            }
        );

        // Handle streaming response
        let fullContent2 = '';
        let chunkCount2 = 0;
        
        await new Promise((resolve, reject) => {
            response2.data.on('data', (chunk) => {
                const text = chunk.toString();
                const lines = text.split('\n').filter(line => line.trim());
                
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        try {
                            const json = JSON.parse(line.substring(6));
                            if (json.choices?.[0]?.delta?.content) {
                                const content = json.choices[0].delta.content;
                                process.stdout.write(content); // Real-time output
                                fullContent2 += content;
                                chunkCount2++;
                            }
                        } catch (e) {
                            // Ignore parse errors
                        }
                    }
                }
            });
            
            response2.data.on('end', () => {
                console.log('\n');
                console.log(`✅ Stream 2 complete. Chunks: ${chunkCount2}, Total length: ${fullContent2.length}`);
                resolve();
            });
            
            response2.data.on('error', reject);
        });

        console.log('\n=== Streaming Test Successful ===');

    } catch (error) {
        console.error('Error:', error.message);
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', error.response.data);
        }
    }
}

testStreaming();
