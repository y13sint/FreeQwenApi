# PowerShell script to test streaming API

$url = "http://localhost:3264/api/chat/completions"

Write-Host "╔════════════════════════════════════════╗"
Write-Host "║  FreeQwenApi - Streaming Test          ║"
Write-Host "╚════════════════════════════════════════╝`n"

# Test 1: Non-streaming request
Write-Host "📝 Test 1: Non-streaming request"
Write-Host "Message: 'Привет, я Дима'" -ForegroundColor Cyan

$body1 = @"
{
    "messages": [
        {
            "role": "user",
            "content": "Привет, я Дима"
        }
    ],
    "model": "qwen-max-latest",
    "stream": false
}
"@

try {
    $response1 = Invoke-WebRequest -Uri $url `
        -Method POST `
        -Headers @{"Content-Type" = "application/json"; "User-Agent" = "PowerShellClient/1.0"} `
        -Body $body1 `
        -UseBasicParsing
    
    $json1 = $response1.Content | ConvertFrom-Json
    Write-Host "✅ Response: " -ForegroundColor Green
    Write-Host $json1.choices[0].message.content
    Write-Host "Tokens: input=$($json1.usage.input_tokens) output=$($json1.usage.output_tokens)" -ForegroundColor Gray
} catch {
    Write-Host "❌ Error: $_" -ForegroundColor Red
}

Write-Host ""
Start-Sleep -Seconds 2

# Test 2: Streaming request with follow-up question
Write-Host "📝 Test 2: Streaming request (follow-up question)"
Write-Host "Message: 'Как меня зовут?'" -ForegroundColor Cyan

$body2 = @"
{
    "messages": [
        {
            "role": "user",
            "content": "Как меня зовут?"
        }
    ],
    "model": "qwen-max-latest",
    "stream": true
}
"@

try {
    $response2 = Invoke-WebRequest -Uri $url `
        -Method POST `
        -Headers @{"Content-Type" = "application/json"; "User-Agent" = "PowerShellClient/1.0"} `
        -Body $body2 `
        -UseBasicParsing
    
    Write-Host "✅ Streaming response:" -ForegroundColor Green
    $streamContent = ""
    $response2.Content.Split("`n") | ForEach-Object {
        if ($_ -match "^data: ") {
            try {
                $json = $_ -replace "^data: " | ConvertFrom-Json
                if ($json.choices[0].delta.content) {
                    Write-Host $json.choices[0].delta.content -NoNewline -ForegroundColor Yellow
                    $streamContent += $json.choices[0].delta.content
                }
            } catch {
                # Ignore JSON parse errors
            }
        }
    }
    Write-Host ""
    Write-Host "Total response: $streamContent" -ForegroundColor Gray
    
} catch {
    Write-Host "❌ Error: $_" -ForegroundColor Red
}

Write-Host "`n╔════════════════════════════════════════╗"
Write-Host "║  Test Complete!                        ║"
Write-Host "╚════════════════════════════════════════╝"
