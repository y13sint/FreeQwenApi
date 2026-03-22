from openai import OpenAI

IMAGE_URL = "https://cdn.qwenlm.ai/your-image-url-here"

client = OpenAI(
    base_url="http://localhost:3264/api",
    api_key="free-qwen-api",
)

resp = client.chat.completions.create(
    model="qwen3-vl-plus",
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Что изображено на картинке?"},
                {"type": "image_url", "image_url": {"url": IMAGE_URL}},
            ],
        }
    ],
)

print(resp.choices[0].message.content)
