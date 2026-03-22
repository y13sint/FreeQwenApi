from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3264/api",
    api_key="free-qwen-api",
)

resp = client.chat.completions.create(
    model="qwen-max-latest",
    messages=[
        {"role": "system", "content": "Ты senior Python разработчик. Отвечай коротко и с примером кода."},
        {"role": "user", "content": "Как перевернуть список в Python?"},
    ],
)

print(resp.choices[0].message.content)
