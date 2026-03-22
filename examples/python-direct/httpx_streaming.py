import json
import httpx

url = "http://localhost:3264/api/chat/completions"
payload = {
    "model": "qwen-max-latest",
    "messages": [{"role": "user", "content": "Напиши короткое хайку про баги."}],
    "stream": True,
}

with httpx.stream("POST", url, json=payload, timeout=120) as resp:
    resp.raise_for_status()
    for line in resp.iter_lines():
        if not line or not line.startswith("data: "):
            continue
        data = line[6:].strip()
        if data == "[DONE]":
            break
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError:
            continue
        delta = chunk.get("choices", [{}])[0].get("delta", {})
        text = delta.get("content")
        if text:
            print(text, end="", flush=True)

print()
