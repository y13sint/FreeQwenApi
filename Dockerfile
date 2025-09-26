# syntax=docker/dockerfile:1.6
FROM mcr.microsoft.com/playwright:v1.55.1-jammy AS base

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN npx playwright install --with-deps chromium \
 && mkdir -p /app/session /app/logs /app/uploads \
 && chown -R pwuser:pwuser /app

USER pwuser

EXPOSE 3264

CMD ["node", "index.js"]
