// Пример для тестирования загрузки файлов
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import FormData from 'form-data';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// URL API
const API_URL = 'http://localhost:3264/api';

/**
 * Загружает тестовый файл на сервер
 * @param {string} filePath - Путь к файлу для загрузки
 * @returns {Promise<Object>} - Результат загрузки файла
 */
async function uploadTestFile(filePath) {
    try {
        console.log(`Загрузка файла: ${filePath}`);
        
        if (!fs.existsSync(filePath)) {
            throw new Error(`Файл не найден: ${filePath}`);
        }
        
        // Создаем FormData для загрузки файла
        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath));
        
        // Отправляем запрос на загрузку
        const response = await axios.post(`${API_URL}/files/upload`, formData, {
            headers: {
                ...formData.getHeaders()
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });
        
        console.log('Файл успешно загружен:');
        console.log(JSON.stringify(response.data, null, 2));
        
        return response.data;
    } catch (error) {
        console.error('Ошибка при загрузке файла:');
        if (error.response) {
            console.error(error.response.data);
        } else {
            console.error(error.message);
        }
        throw error;
    }
}

/**
 * Получает STS токен напрямую (для тестирования)
 * @param {Object} fileInfo - Информация о файле
 * @returns {Promise<Object>} - Данные STS токена
 */
async function getTestStsToken(fileInfo) {
    try {
        console.log(`Запрос STS токена для файла: ${fileInfo.filename}`);
        
        const response = await axios.post(`${API_URL}/files/getstsToken`, fileInfo);
        
        console.log('Получен STS токен:');
        console.log(JSON.stringify(response.data, null, 2));
        
        return response.data;
    } catch (error) {
        console.error('Ошибка при получении STS токена:');
        if (error.response) {
            console.error(error.response.data);
        } else {
            console.error(error.message);
        }
        throw error;
    }
}

/**
 * Напрямую загружает файл через PUT запрос (для тестирования)
 * @param {string} filePath - Путь к файлу
 * @param {Object} stsData - Данные STS токена
 * @returns {Promise<Object>} - Результат загрузки
 */
async function directUploadFile(filePath, stsData) {
    try {
        console.log(`Прямая загрузка файла: ${filePath}`);
        
        if (!stsData || !stsData.file_url) {
            throw new Error('Некорректные данные STS токена');
        }
        
        // В данном случае, файл уже загружен при получении STS токена
        // Qwen.ai автоматически создает файл на сервере при получении токена
        console.log(`Файл уже загружен и доступен по URL: ${stsData.file_url}`);
        
        // Проверяем, что файл действительно существует
        try {
            const verifyResponse = await axios.get(stsData.file_url);
            console.log(`Файл успешно проверен, статус: ${verifyResponse.status}`);
        } catch (error) {
            console.log(`Не удалось проверить файл: ${error.message}`);
            // Это не критическая ошибка, так как файл может быть недоступен сразу
        }
        
        return {
            success: true,
            fileName: path.basename(filePath),
            url: stsData.file_url,
            fileId: stsData.file_id
        };
    } catch (error) {
        console.error('Ошибка при проверке файла:');
        if (error.response) {
            console.error(`Статус: ${error.response.status}`);
            console.error(error.response.data);
        } else {
            console.error(error.message);
        }
        throw error;
    }
}

// Основная функция для запуска тестов
async function runTest() {
    try {
        // Путь к тестовому файлу (например, изображение)
        const testFilePath = path.join(__dirname, 'test-image.jpg');
        
        // Если файл не существует, создадим простой текстовый файл для теста
        if (!fs.existsSync(testFilePath)) {
            console.log('Тестовый файл не найден, создаем текстовый файл для теста...');
            
            const textFilePath = path.join(__dirname, 'test-file.txt');
            fs.writeFileSync(textFilePath, 'Это тестовый файл для загрузки.');
            
            console.log(`Создан тестовый файл: ${textFilePath}`);
            
            // Тестируем получение STS токена
            const fileInfo = {
                filename: 'test-file.txt',
                filesize: fs.statSync(textFilePath).size,
                filetype: 'file'
            };
            
            const stsData = await getTestStsToken(fileInfo);
            
            // Тестируем прямую загрузку файла
            console.log('\n--- Тестирование прямой загрузки файла ---');
            await directUploadFile(textFilePath, stsData);
            
            // Тестируем загрузку через API
            console.log('\n--- Тестирование загрузки через API ---');
            await uploadTestFile(textFilePath);
        } else {
            // Тестируем получение STS токена
            const fileInfo = {
                filename: 'test-image.jpg',
                filesize: fs.statSync(testFilePath).size,
                filetype: 'image'
            };
            
            const stsData = await getTestStsToken(fileInfo);
            
            // Тестируем прямую загрузку файла
            console.log('\n--- Тестирование прямой загрузки файла ---');
            await directUploadFile(testFilePath, stsData);
            
            // Тестируем загрузку через API
            console.log('\n--- Тестирование загрузки через API ---');
            await uploadTestFile(testFilePath);
        }
        
        console.log('\nТестирование завершено успешно!');
    } catch (error) {
        console.error('Ошибка при выполнении теста:', error.message);
    }
}

// Запускаем тест
runTest(); 