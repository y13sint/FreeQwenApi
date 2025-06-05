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
 * Напрямую загружает файл через OSS (для тестирования)
 * @param {string} filePath - Путь к файлу
 * @param {Object} stsData - Данные STS токена
 * @returns {Promise<Object>} - Результат загрузки
 */
async function directUploadFile(filePath, stsData) {
    try {
        console.log(`Прямая загрузка файла: ${filePath}`);
        
        if (!stsData || !stsData.file_url || !stsData.file_path) {
            throw new Error('Некорректные данные STS токена');
        }
        
        // Загружаем ali-oss библиотеку динамически
        const OSS = (await import('ali-oss')).default;
        
        // Проверяем наличие необходимых данных для OSS
        if (!stsData.access_key_id || !stsData.access_key_secret || !stsData.security_token ||
            !stsData.region || !stsData.bucketname) {
            throw new Error('Неполные данные STS токена для OSS');
        }
        
        console.log(`Создание OSS клиента: регион ${stsData.region}, бакет ${stsData.bucketname}`);
        
        // Создаем клиент OSS с STS токеном
        const client = new OSS({
            region: stsData.region,
            accessKeyId: stsData.access_key_id,
            accessKeySecret: stsData.access_key_secret,
            stsToken: stsData.security_token,
            bucket: stsData.bucketname,
            secure: true, // Используем HTTPS
            timeout: 60000 // 60 секунд таймаут
        });
        
        // Получаем имя объекта из file_path
        const objectName = stsData.file_path;
        
        console.log(`Загрузка файла в OSS: ${objectName}`);
        
        // Загружаем файл
        const result = await client.put(objectName, filePath);
        
        console.log('Файл успешно загружен в OSS:');
        console.log(`URL: ${stsData.file_url}`);
        console.log(`Ответ OSS: ${JSON.stringify(result)}`);
        
        // Проверяем, что файл действительно загружен
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
            fileId: stsData.file_id,
            ossResponse: result
        };
    } catch (error) {
        console.error('Ошибка при загрузке файла в OSS:');
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