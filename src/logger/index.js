import winston from 'winston';
import morgan from 'morgan';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Создаем директорию для логов, если она не существует
const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Настройки форматирования логов
const { combine, timestamp, printf, colorize } = winston.format;

// Формат для консоли (цветной)
const consoleFormat = combine(
    colorize({ all: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    printf(({ level, message, timestamp }) => {
        return `${timestamp} [${level}]: ${message}`;
    })
);

// Формат для файла (без цветов)
const fileFormat = combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    printf(({ level, message, timestamp }) => {
        return `${timestamp} [${level}]: ${message}`;
    })
);

// Определяем уровни логирования с добавлением уровня http
const customLevels = {
    levels: {
        error: 0,
        warn: 1,
        info: 2,
        http: 3,
        debug: 4
    },
    colors: {
        error: 'red',
        warn: 'yellow',
        info: 'green',
        http: 'cyan',
        debug: 'blue'
    }
};

// Определяем уровень логирования на основе окружения
const level = process.env.NODE_ENV === 'production' ? 'info' : 'debug';

// Создаем инстанс логгера
const logger = winston.createLogger({
    levels: customLevels.levels,
    level,
    format: fileFormat,
    transports: [
        // Лог всех сообщений уровня info и выше в combined.log
        new winston.transports.File({
            filename: path.join(LOG_DIR, 'combined.log'),
            maxsize: 5242880, // 5MB
            maxFiles: 5
        }),
        // Отдельный файл для HTTP-запросов
        new winston.transports.File({
            filename: path.join(LOG_DIR, 'http.log'),
            level: 'http',
            maxsize: 5242880, // 5MB
            maxFiles: 5
        }),
        // Лог всех ошибок в error.log
        new winston.transports.File({
            filename: path.join(LOG_DIR, 'error.log'),
            level: 'error',
            maxsize: 5242880, // 5MB
            maxFiles: 5
        }),
        // Вывод в консоль
        new winston.transports.Console({
            format: consoleFormat
        })
    ]
});

// Добавляем цвета для уровней логирования
winston.addColors(customLevels.colors);

// Создаем stream для morgan, который будет писать в winston
const morganStream = {
    write: (message) => {
        // Убираем символ новой строки и отправляем в http-логи
        logger.http(message.trim());
    }
};

// Настраиваем формат morgan с дополнительной информацией
const morganFormat = ':remote-addr :method :url :status :res[content-length] - :response-time ms';

// Создаем middleware для express с использованием morgan
const httpLogger = morgan(morganFormat, { stream: morganStream });

// Отдельная функция для логирования HTTP-запросов (используется morgan)
export const logHttpRequest = httpLogger;

// Экспортируем функции для разных уровней логирования
export const logInfo = (message) => logger.info(message);
export const logError = (message, error) => {
    if (error) {
        logger.error(`${message}: ${error.message}`);
        logger.error(error.stack);
    } else {
        logger.error(message);
    }
};
export const logWarn = (message) => logger.warn(message);
export const logDebug = (message) => logger.debug(message);
export const logHttp = (message) => logger.http(message);

export default {
    logHttpRequest,
    logInfo,
    logError,
    logWarn,
    logDebug,
    logHttp
}; 