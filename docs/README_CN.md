# Qwen AI API 代理

本地 API 代理服务器，通过浏览器模拟与 Qwen AI 交互。允许用户无需官方 API 密钥即可使用 Qwen 模型。

- **免费访问**：无需支付 API 密钥费用即可使用 Qwen 模型
- **完全兼容**：支持 OpenAI 兼容接口，便于集成

## 📋 目录

- [🚀 快速开始](#-快速开始)
  - [安装](#安装)
  - [启动](#启动)
- [💡 功能](#-功能)
- [📘 API 参考](#-api-参考)
  - [主要端点](#主要端点)
  - [请求格式](#请求格式)
  - [对话历史管理](#对话历史管理)
  - [图像处理](#图像处理)
  - [文件上传](#文件上传)
  - [对话管理](#对话管理)
- [📝 使用示例](#-使用示例)
  - [文本请求](#文本请求)
  - [图像请求](#图像请求)
  - [Postman 示例](#postman-示例)
- [🔄 上下文管理](#-上下文管理)
- [🔌 OpenAI API 兼容性](#-openai-api-兼容性)
  - [主要特性](#主要特性)
  - [流式输出支持](#流式输出支持)
  - [OpenAI SDK 使用示例](#openai-sdk-使用示例)
- [🔧 实现细节](#-实现细节)

---

## 🚀 快速开始

### 安装

1. 克隆仓库
2. 安装依赖：

```bash
npm install
```

### 启动

```bash
npm start
```

也可以使用快速启动文件：

```
start.bat
```

> **注意：** 首次启动时会打开浏览器窗口，您需要在 Qwen AI 网站上进行登录授权。成功登录后，按回车键继续。

---

## 💡 功能

本项目允许您：

- 通过本地 API 使用 Qwen AI 模型
- 在请求之间保存对话上下文
- 通过 API 管理对话
- 选择不同的 Qwen 模型生成回答
- 发送图像进行分析
- 使用支持流式输出的 OpenAI 兼容 API

---

## 📘 API 参考

### 主要端点

| 端点 | 方法 | 描述 |
|----------|-------|----------|
| `/api/chat` | POST | 发送消息并获取回复 |
| `/api/chat/completions` | POST | 支持流式输出的 OpenAI 兼容端点 |
| `/api/models` | GET | 获取可用模型列表 |
| `/api/status` | GET | 检查授权状态 |
| `/api/files/upload` | POST | 上传图像用于请求 |
| `/api/chats` | POST/GET | 创建新对话 / 获取所有对话列表 |
| `/api/chats/:chatId` | GET/DELETE | 获取对话历史 / 删除对话 |
| `/api/chats/:chatId/rename` | PUT | 重命名对话 |
| `/api/chats/cleanup` | POST | 根据条件自动删除对话 |

### 请求格式

代理支持两种向 `/api/chat` 发送请求的格式：

#### 1. 使用 `message` 参数的简化格式

```json
{
  "message": "消息文本",
  "model": "qwen-max-latest",
  "chatId": "对话ID"
}
```

#### 2. 与官方 Qwen API 兼容的 `messages` 参数格式

```json
{
  "messages": [
    {"role": "user", "content": "你好，最近怎么样？"}
  ],
  "model": "qwen-max-latest",
  "chatId": "对话ID"
}
```

### 对话历史管理

> **重要提示：** 代理在服务器上使用内部系统存储对话历史。

1. 使用 `message` 格式时 - 消息直接添加到对话历史中。
2. 使用 `messages` 格式时 - 只从数组中提取最后一条用户消息并添加到历史中。

发送请求到官方 Qwen API 时，**始终**使用与指定 `chatId` 关联的完整对话历史。这意味着使用 `messages` 参数时，您只需包含带有 "user" 角色的新用户消息，而不是整个对话历史。

### 图像处理

代理支持在两种格式中发送带图像的消息：

#### 带图像的 `message` 格式

```json
{
  "message": [
    {
      "type": "text",
      "text": "描述这张图片中的物体"
    },
    {
      "type": "image",
      "image": "图像URL"
    }
  ],
  "model": "qwen3-235b-a22b",
  "chatId": "对话ID"
}
```

#### 带图像的 `messages` 格式

```json
{
  "messages": [
    {
      "role": "user", 
      "content": [
        {
          "type": "text",
          "text": "描述这张图片中的物体"
        },
        {
          "type": "image",
          "image": "图像URL"
        }
      ]
    }
  ],
  "model": "qwen3-235b-a22b",
  "chatId": "对话ID"
}
```

### 文件上传

#### 上传图像

```
POST http://localhost:3264/api/files/upload
```

**请求格式：** `multipart/form-data`

**参数：**

- `file` - 图像文件（支持格式：jpg, jpeg, png, gif, webp）

**使用 curl 的示例：**

```bash
curl -X POST http://localhost:3264/api/files/upload \
  -F "file=@/path/to/image.jpg"
```

**响应示例：**

```json
{
  "imageUrl": "https://cdn.qwenlm.ai/user-id/file-id_filename.jpg?key=..."
}
```

#### 获取图像 URL

要通过 API 代理发送图像，您首先需要获取图像 URL。可以通过两种方式实现：

##### 方法 1：通过 API 代理上传

如上所述，向 `/api/files/upload` 端点发送 POST 请求上传图像。

##### 方法 2：通过 Qwen 网页界面获取 URL

1. 在官方 Qwen 网页界面上传图像 (<https://chat.qwen.ai/>)
2. 打开浏览器开发者工具（F12 或 Ctrl+Shift+I）
3. 切换到 "Network"（网络）选项卡
4. 找到包含您图像的 API Qwen 请求（通常是 GetsToken 请求）
5. 在请求主体中找到图像 URL，格式类似：`https://cdn.qwenlm.ai/user-id/file-id_filename.jpg?key=...`
6. 复制此 URL 以在 API 请求中使用

### 对话管理

#### 创建新对话

```
POST http://localhost:3264/api/chats
```

**请求体：**

```json
{
  "name": "对话名称"
}
```

**响应：**

```json
{
  "chatId": "唯一标识符"
}
```

#### 获取所有对话列表

```
GET http://localhost:3264/api/chats
```

#### 获取对话历史

```
GET http://localhost:3264/api/chats/:chatId
```

#### 删除对话

```
DELETE http://localhost:3264/api/chats/:chatId
```

#### 重命名对话

```
PUT http://localhost:3264/api/chats/:chatId/rename
```

**请求体：**

```json
{
  "name": "新对话名称"
}
```

#### 自动删除对话

```
POST http://localhost:3264/api/chats/cleanup
```

**请求体**（所有参数都是可选的）：

```json
{
  "olderThan": 604800000, // 删除超过指定时间的对话（毫秒），例如 7 天
  "userMessageCountLessThan": 3, // 删除用户消息少于 3 条的对话
  "messageCountLessThan": 5, // 删除总消息少于 5 条的对话
  "maxChats": 50 // 只保留最新的 50 个对话
}
```

---

## 📝 使用示例

### 文本请求

#### 简单文本请求示例

```bash
curl -X POST http://localhost:3264/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": "什么是人工智能？",
    "model": "qwen-max-latest"
  }'
```

#### 官方 API 格式请求示例

```bash
curl -X POST http://localhost:3264/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "什么是人工智能？"}
    ],
    "model": "qwen-max-latest"
  }'
```

### 图像请求

#### 上传图像并发送请求示例

```bash
# 步骤 1：上传图像
UPLOAD_RESPONSE=$(curl -s -X POST http://localhost:3264/api/files/upload \
  -F "file=@/path/to/image.jpg")

# 步骤 2：提取图像 URL
IMAGE_URL=$(echo $UPLOAD_RESPONSE | grep -o '"imageUrl":"[^"]*"' | sed 's/"imageUrl":"//;s/"//')

# 步骤 3：发送带图像的请求
curl -X POST http://localhost:3264/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "message": [
      {
        "type": "text",
        "text": "描述这张图片中的物体"
      },
      {
        "type": "image",
        "image": "'$IMAGE_URL'"
      }
    ],
    "model": "qwen3-235b-a22b"
  }'
```

### Postman 示例

#### 上传并使用图像

1. **上传图像**：
   - 创建一个新的 POST 请求到 `http://localhost:3264/api/files/upload`
   - 选择 "Body" 选项卡
   - 选择类型 "form-data"
   - 添加键 "file" 并选择类型 "File"
   - 点击 "Select Files" 按钮上传图像
   - 点击 "Send"

   响应将包含图像 URL：

   ```json
   {
     "imageUrl": "https://cdn.qwenlm.ai/user-id/file-id_filename.jpg?key=..."
   }
   ```

2. **在请求中使用图像**：
   - 创建一个新的 POST 请求到 `http://localhost:3264/api/chat`
   - 选择 "Body" 选项卡
   - 选择类型 "raw" 和格式 "JSON"
   - 粘贴以下 JSON，将 `图像URL` 替换为获取的 URL：

   ```json
   {
     "message": [
       {
         "type": "text",
         "text": "描述这张图片中的物体"
       },
       {
         "type": "image",
         "image": "图像URL"
       }
     ],
     "model": "qwen3-235b-a22b"
   }
   ```

   - 点击 "Send"

#### 使用 OpenAI 兼容端点

1. **通过 OpenAI 兼容端点发送请求**：
   - 创建一个新的 POST 请求到 `http://localhost:3264/api/chat/completions`
   - 选择 "Body" 选项卡
   - 选择类型 "raw" 和格式 "JSON"
   - 粘贴以下 JSON，将 `图像URL` 替换为获取的 URL：

   ```json
   {
     "messages": [
       {
         "role": "user",
         "content": [
           {
             "type": "text",
             "text": "描述这张图片中的内容是什么？"
           },
           {
             "type": "image",
             "image": "图像URL"
           }
         ]
       }
     ],
     "model": "qwen3-235b-a22b"
   }
   ```

   - 点击 "Send"

2. **流式模式请求**：
   - 使用相同的 URL 和请求体，但添加参数 `"stream": true`
   - 注意：要在 Postman 中正确显示流，请在控制台中勾选 "Preserve log" 选项

---

## 🔄 上下文管理

系统会自动保存对话历史并在每个请求中发送到 Qwen API。这使模型能够在生成回答时考虑之前的消息。

### 上下文工作流程

1. **首次请求**（不指定 `chatId`）：

```json
{
  "message": "你好，你叫什么名字？"
}
```

2. **响应**（包含 `chatId`）：

```json
{
  "chatId": "abcd-1234-5678",
  "choices": [...]
}
```

3. **后续请求**（使用获得的 `chatId`）：

```json
{
  "message": "2+2等于多少？",
  "chatId": "abcd-1234-5678"
}
```

---

## 🔌 OpenAI API 兼容性

代理支持 OpenAI API 兼容端点，用于连接使用 OpenAI API 的客户端：

```
POST /api/chat/completions
```

### 主要特性

1. **为每个请求创建新对话：** 每个向 `/chat/completions` 的请求都会在系统中创建一个名为 "OpenAI API Chat" 的新对话。

2. **保存完整消息历史：** 请求中的所有消息（包括系统消息、用户消息和助手消息）都会保存在对话历史中。

3. **支持系统消息：** 代理正确处理并保存系统消息（`role: "system"`），这些消息通常用于配置模型行为。

**带系统消息的请求示例：**

```json
{
  "messages": [
    {"role": "system", "content": "你是 JavaScript 专家。只回答关于 JavaScript 的问题。"},
    {"role": "user", "content": "如何在 JavaScript 中创建类？"}
  ],
  "model": "qwen-max-latest"
}
```

### 流式输出支持

代理支持响应流式传输模式，允许您实时分批接收响应：

```json
{
  "messages": [
    {"role": "user", "content": "写一个关于太空的长故事"}
  ],
  "model": "qwen-max-latest",
  "stream": true
}
```

使用流式模式时，响应将以与 OpenAI API 兼容的 Server-Sent Events (SSE) 格式逐步返回。

### OpenAI SDK 使用示例

```javascript
// 使用 OpenAI Node.js SDK 的示例
import OpenAI from 'openai';
import fs from 'fs';
import axios from 'axios';

const openai = new OpenAI({
  baseURL: 'http://localhost:3264/api', // 代理的基本 URL
  apiKey: 'dummy-key', // 不需要真实密钥，但库要求此字段
});

// 不使用流式输出的请求
const completion = await openai.chat.completions.create({
  messages: [{ role: 'user', content: '你好，最近怎么样？' }],
  model: 'qwen-max-latest', // 使用的 Qwen 模型
});

console.log(completion.choices[0].message);

// 使用流式输出的请求
const stream = await openai.chat.completions.create({
  messages: [{ role: 'user', content: '讲一个关于太空的长故事' }],
  model: 'qwen-max-latest',
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}

// 上传并使用图像
async function uploadAndAnalyzeImage(imagePath) {
  // 通过 API 代理上传图像
  const formData = new FormData();
  formData.append('file', fs.createReadStream(imagePath));
  
  const uploadResponse = await axios.post('http://localhost:3264/api/files/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' }
  });
  
  const imageUrl = uploadResponse.data.imageUrl;
  
  // 创建带图像的请求
  const completion = await openai.chat.completions.create({
    messages: [
      { 
        role: 'user', 
        content: [
          { type: 'text', text: '描述这张图片中的内容是什么？' },
          { type: 'image', image: imageUrl }
        ] 
      }
    ],
    model: 'qwen3-235b-a22b',
  });
  
  console.log(completion.choices[0].message.content);
}

// 使用方法：uploadAndAnalyzeImage('./image.jpg');
```

> **兼容性限制：**
>
> 1. 一些 OpenAI 特有的参数（如 `logprobs`、`functions` 等）不受支持。
> 2. 流式传输速度可能与原始 OpenAI API 不同。

---

## 🔧 实现细节

- 代理通过无头浏览器模拟与 Qwen 网页界面的交互
- 自动管理会话和授权
- 通过浏览器页面池优化性能
- 支持自动保存和恢复授权状态
