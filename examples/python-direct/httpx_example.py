import httpx

url = "http://localhost:3264/api/chat/completions"
payload = {
    "model": "qwen-max-latest",
    "messages": [{"role": "user", "content": "Привет! Напиши 1 полезный совет по Python."}],
}

resp = httpx.post(url, json=payload, timeout=120)
resp.raise_for_status()

data = resp.json()
print(data["choices"][0]["message"]["content"])
