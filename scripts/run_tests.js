import axios from 'axios';
import fs from 'fs';

const base = 'http://localhost:3264/api/chat/completions';
const headers = { 'User-Agent': 'OpenWebUI-Test/1.0', 'Content-Type': 'application/json' };

async function run() {
  try {
    console.log('POST 1: Меня зовут Дима');
    const r1 = await axios.post(base, { model: 'qwen-max-latest', messages: [{ role: 'user', content: 'Меня зовут Дима' }] }, { headers, timeout: 120000 });
    console.log('Response 1 status:', r1.status);
    console.log(JSON.stringify(r1.data, null, 2));
    fs.writeFileSync('./tmp_response1.json', JSON.stringify(r1.data, null, 2), 'utf8');

    await new Promise(r => setTimeout(r, 500));

    console.log('\nPOST 2: Как меня зовут?');
    const r2 = await axios.post(base, { model: 'qwen-max-latest', messages: [{ role: 'user', content: 'Как меня зовут?' }] }, { headers, timeout: 120000 });
    console.log('Response 2 status:', r2.status);
    console.log(JSON.stringify(r2.data, null, 2));
    fs.writeFileSync('./tmp_response2.json', JSON.stringify(r2.data, null, 2), 'utf8');

    console.log('\nSaved responses to tmp_response1.json and tmp_response2.json');

    // tail logs that may include rawChunks entries
    try {
      const logs = fs.readFileSync('./logs/server.log', 'utf8');
      const matches = logs.split(/\r?\n/).filter(l => l.includes('[raw]') || l.includes('rawChunks') || l.includes('Ответ получен успешно'));
      console.log('\n--- recent raw log lines (filtered) ---');
      console.log(matches.slice(-40).join('\n'));
    } catch (e) {
      console.warn('Could not read server log file (server.log). Listing logs folder instead:');
      console.log(fs.readdirSync('./logs').join('\n'));
    }

  } catch (e) {
    console.error('Error running tests:', e.toString());
    if (e.response && e.response.data) {
      console.error('Response data:', JSON.stringify(e.response.data, null, 2));
    }
  }
}

run();
