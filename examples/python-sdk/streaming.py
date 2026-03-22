from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3264/api",
    api_key="free-qwen-api",
)

stream = client.chat.completions.create(
    model="qwen-max-latest",
    messages=[{"role": "user", "content": "Напиши мини-историю про робота."}],
    stream=True,
)

for chunk in stream:
    delta = chunk.choices[0].delta
    if delta and delta.content:
        print(delta.content, end="", flush=True)

print()
