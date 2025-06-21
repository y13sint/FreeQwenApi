// FileUpload.js - Модуль для загрузки файлов в чат Qwen.ai
import axios from 'axios';
import { getBrowserContext } from '../browser/browser.js';
import { logInfo, logError } from '../logger/index.js';
import { getAuthToken, extractAuthToken } from './chat.js';
import OSS from 'ali-oss';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '../../uploads');

// Убедимся, что директория для загрузок существует
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * Получает STS токен доступа для загрузки файлов
 * @param {Object} fileInfo - Информация о файле (имя, размер, тип)
 * @returns {Promise<Object>} - Объект с данными токена доступа
 */
export async function getStsToken(fileInfo) {
    try {
        logInfo(`Запрос STS токена для файла: ${fileInfo.filename}`);
        
        const browserContext = getBrowserContext();
        if (!browserContext) {
            throw new Error('Браузер не инициализирован');
        }
        
        // Получаем токен авторизации с помощью существующей функции
        let token = getAuthToken();
        
        // Если токен не найден, попробуем его извлечь
        if (!token) {
            logInfo('Токен авторизации не найден в памяти, пытаемся извлечь из браузера');
            token = await extractAuthToken(browserContext);
            
            if (!token) {
                throw new Error('Не удалось получить токен авторизации');
            }
        }
        
        logInfo('Токен авторизации получен, отправляем запрос на получение STS токена');
        
        // Запрос на получение STS токена
        const response = await axios.post('https://chat.qwen.ai/api/v1/files/getstsToken', fileInfo, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
                'Origin': 'https://chat.qwen.ai',
                'Referer': 'https://chat.qwen.ai/'
            }
        });
        
        logInfo(`STS токен успешно получен для файла: ${fileInfo.filename}`);
        return response.data;
    } catch (error) {
        logError(`Ошибка при получении STS токена: ${error.message}`, error);
        throw error;
    }
}

/**
 * Загружает файл на URL, полученный с STS токеном
 * @param {string} filePath - Путь к файлу для загрузки
 * @param {Object} stsData - Данные STS токена
 * @returns {Promise<Object>} - Результат загрузки файла
 */
export async function uploadFile(filePath, stsData) {
    try {
        logInfo(`Начало загрузки файла: ${filePath}`);
        
        if (!stsData || !stsData.file_path) {
            throw new Error('Некорректные данные STS токена');
        }
        
        // Проверяем наличие необходимых данных для OSS
        if (!stsData.access_key_id || !stsData.access_key_secret || !stsData.security_token ||
            !stsData.region || !stsData.bucketname) {
            throw new Error('Неполные данные STS токена для OSS');
        }
        
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
        
        logInfo(`OSS клиент создан для региона ${stsData.region}, бакет: ${stsData.bucketname}`);
        
        // Получаем имя объекта из file_path
        const objectName = stsData.file_path;
        
        // Загружаем файл
        logInfo(`Загрузка файла в OSS: ${objectName}`);
        const result = await client.put(objectName, filePath);
        
        logInfo(`Файл успешно загружен в OSS: ${objectName}`);
        logInfo(`URL файла: ${stsData.file_url}`);
        
        return {
            success: true,
            fileName: path.basename(filePath),
            url: stsData.file_url,
            fileId: stsData.file_id,
            filePath: stsData.file_path,
            ossResponse: result
        };
    } catch (error) {
        logError(`Ошибка при загрузке файла в OSS: ${error.message}`, error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Полный процесс загрузки файла: получение токена и загрузка
 * @param {string} filePath - Путь к файлу для загрузки
 * @returns {Promise<Object>} - Результат загрузки файла
 */
export async function uploadFileToQwen(filePath) {
    try {
        // Проверяем существование файла
        if (!fs.existsSync(filePath)) {
            throw new Error(`Файл не найден: ${filePath}`);
        }
        
        const fileName = path.basename(filePath);
        const fileSize = fs.statSync(filePath).size;
        const fileExt = path.extname(fileName).toLowerCase();
        
        // Определяем тип файла
        let fileType = 'file';
        if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(fileExt)) {
            fileType = 'image';
        } else if (['.pdf', '.doc', '.docx', '.txt'].includes(fileExt)) {
            fileType = 'document';
        }
        
        // Запрашиваем STS токен
        const fileInfo = {
            filename: fileName,
            filesize: fileSize,
            filetype: fileType
        };
        
        const stsData = await getStsToken(fileInfo);
        
        // Загружаем файл с использованием полученных данных
        const uploadResult = await uploadFile(filePath, stsData);
        
        return {
            ...uploadResult,
            fileInfo,
            stsData
        };
    } catch (error) {
        logError(`Ошибка в процессе загрузки файла: ${error.message}`, error);
        return {
            success: false,
            error: error.message
        };
    }
}

export default {
    getStsToken,
    uploadFile,
    uploadFileToQwen
};

