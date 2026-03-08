/**
 * Test direct Qwen v2 API call to isolate whether issue is in browser context or Qwen-side.
 * Fetches auth token from headless browser, then POSTs directly to Qwen API.
 */

const axios = require('axios');
const { initBrowser, authenticateUser, getAuthorizationToken } = require('../src/browser/auth');
const { getPage, closeBrowser } = require('../src/browser/browser');
const fs = require('fs');
const path = require('path');

const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

const logFile = path.join(logsDir, 'direct-qwen-test.log');

function log(msg) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}`;
    console.log(line);
    fs.appendFileSync(logFile, line + '\n');
}

async function runTest() {
    try {
        log('=== Starting Direct Qwen API Test ===');
        log('Step 1: Initialize browser and get auth token...');
        
        // Initialize browser
        await initBrowser();
        
        // Get auth token
        const token = await getAuthorizationToken();
        log(`Got token: ${token ? token.substring(0, 50) + '...' : 'FAILED'}`);
        
        if (!token) {
            log('ERROR: Failed to get auth token');
            await closeBrowser();
            return;
        }
        
        // Prepare payload
        const payload = {
            model: 'qwen-turbo',
            messages: [
                {
                    role: 'user',
                    content: 'Hello, please respond with "Test successful"'
                }
            ],
            stream: true
        };
        
        log('Step 2: POST directly to Qwen v2 API...');
        log(`URL: https://chat.qwen.ai/api/v2/chat/completions`);
        log(`Headers: Authorization: Bearer ${token.substring(0, 30)}...`);
        log(`Payload: ${JSON.stringify(payload)}`);
        
        const startTime = Date.now();
        const response = await axios.post(
            'https://chat.qwen.ai/api/v2/chat/completions',
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                responseType: 'stream',
                timeout: 30000
            }
        );
        
        log(`Step 3: Response received in ${Date.now() - startTime}ms`);
        log(`Status: ${response.status}`);
        log(`Headers: ${JSON.stringify(response.headers, null, 2)}`);
        
        // Parse stream
        let rawChunks = [];
        let fullContent = '';
        let chunkCount = 0;
        
        await new Promise((resolve, reject) => {
            response.data.on('data', (chunk) => {
                chunkCount++;
                const chunkStr = chunk.toString('utf-8');
                log(`[Chunk ${chunkCount}] Raw bytes: ${chunk.length} bytes`);
                log(`[Chunk ${chunkCount}] Text: ${chunkStr.substring(0, 100)}`);
                
                rawChunks.push(chunkStr);
                
                // Try to parse as SSE
                const lines = chunkStr.split('\n');
                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const jsonStr = line.substring(6);
                        try {
                            const json = JSON.parse(jsonStr);
                            if (json.choices?.[0]?.delta?.content) {
                                fullContent += json.choices[0].delta.content;
                                log(`[Chunk ${chunkCount}] Content delta: ${json.choices[0].delta.content}`);
                            }
                        } catch (e) {
                            // ignore parse errors
                        }
                    }
                }
            });
            
            response.data.on('end', () => {
                log(`Stream ended after ${chunkCount} chunks`);
                resolve();
            });
            
            response.data.on('error', (err) => {
                log(`Stream error: ${err.message}`);
                reject(err);
            });
        });
        
        log(`Step 4: Stream parsing complete`);
        log(`Total chunks received: ${chunkCount}`);
        log(`Full content: "${fullContent}"`);
        log(`Raw chunks: ${JSON.stringify(rawChunks)}`);
        
        // Save results
        const results = {
            status: response.status,
            headers: response.headers,
            chunkCount: chunkCount,
            fullContent: fullContent,
            rawChunks: rawChunks,
            timestamp: new Date().toISOString()
        };
        
        fs.writeFileSync(
            path.join(logsDir, 'direct-qwen-result.json'),
            JSON.stringify(results, null, 2)
        );
        log(`Results saved to direct-qwen-result.json`);
        
        log('=== Test Complete ===');
        
    } catch (error) {
        log(`ERROR: ${error.message}`);
        log(`Stack: ${error.stack}`);
    } finally {
        await closeBrowser();
    }
}

runTest();
