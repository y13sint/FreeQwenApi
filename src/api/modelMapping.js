

export const MODEL_MAPPING = {

    "qwen-max-latest": "qwen-max-latest",
    "qwen2.5-coder-32b-instruct": "qwen2.5-coder-32b-instruct",

    "qwen2.5-coder-14b-instruct": "qwen2.5-14b-instruct-1m",
    "qwen2.5-coder-7b-instruct": "qwen2.5-omni-7b",
    "qwen2.5-coder-3b-instruct": "qwen3-32b",
    "qwen2.5-coder-1.5b-instruct": "qwen3-32b",
    "qwen2.5-coder-0.5b-instruct": "qwen3-32b",
    "qwen3-coder-plus": "qwen3-coder-plus",
    "qwen-coder-plus-latest": "qwen3-coder-plus",
    "qwen-coder-plus": "qwen3-coder-plus",


    "qwen-plus-latest": "qwen-plus-2025-01-25",
    "qwen-plus": "qwen-plus-2025-01-25",
    "qwen-turbo-latest": "qwen-turbo-2025-02-11",
    "qwen-turbo": "qwen-turbo-2025-02-11",
    "qwen-max": "qwen-max-latest",


    "qwen-vl-max": "qwen2.5-vl-32b-instruct",
    "qwen-vl-max-latest": "qwen2.5-vl-32b-instruct",
    "qwen-vl-plus": "qwen2.5-vl-32b-instruct",
    "qwen-vl-plus-latest": "qwen2.5-vl-32b-instruct",


    "qwen3": "qwen3-235b-a22b",
    "qwen-3": "qwen3-235b-a22b",
    "qwen3-max": "qwen3-235b-a22b",
    "qwen3-plus": "qwen3-30b-a3b",

    "qwen-plus-2025-09-11": "qwen-plus-2025-09-11",
    "Qwen3-Next-80B-A3Bб": "qwen-plus-2025-09-11",

    "qwen3-max-preview": "qwen3-max-preview",
    "Qwen3-Max-Preview": "qwen3-max-preview"
};

/**
 * Получить соответствующую доступную модель
 * @param {string} requestedModel - Запрошенная модель
 * @param {string} defaultModel - Модель по умолчанию
 * @returns {string} - Доступная модель
 */
export function getMappedModel(requestedModel, defaultModel = "qwen-max-latest") {
    if (!requestedModel) return defaultModel;

    // Проверяем точное соответствие в словаре
    if (MODEL_MAPPING[requestedModel]) {
        return MODEL_MAPPING[requestedModel];
    }

    // Проверяем, является ли запрошенная модель уже доступной
    const availableModels = Object.values(MODEL_MAPPING);
    if (availableModels.includes(requestedModel)) {
        return requestedModel;
    }

    // Возвращаем модель по умолчанию, если соответствие не найдено
    return defaultModel;
} 