from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3264/api",
    api_key="free-qwen-api",
)

resp = client.chat.completions.create(
    model="qwen-max-latest",
    messages=[{"role": "user", "content": "Привет! Напиши короткое приветствие."}],
)

print(resp.choices[0].message.content)
