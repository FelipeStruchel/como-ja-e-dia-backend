# Backend (API & Processamento)

Serviço Express que expõe as rotas do bot, processa mensagens recebidas (triggers/comandos) consumindo a fila `incoming-messages`, enfileira envios na `send-messages`, roda rotinas diárias/eventos e persiste logs em Mongo.

## Principais pontos
- Rotas públicas/abertas: eventos, confissões, mídia, frases, health.
- Rotas protegidas (requireAuth): triggers CRUD, logs, auth (`/auth/login`, `/auth/register`, `/auth/me`).
- Ingest de logs: `/logs/ingest` (token `LOG_INGEST_TOKEN`).
- Consumidor de entrada: lê `incoming-messages`, aplica triggers e comandos, enfileira respostas.
- Scheduler: envia bom dia/boa noite e anuncia eventos expirados via fila.
- Logs: console + Mongo (`LogEntry`), consultáveis em `/logs`.

## Rodando local
```bash
npm install
npm start
```
Depende de Redis e Mongo configurados nas envs; WhatsApp roda no worker (não há cliente WA aqui).

## Env essenciais
- `PORT=3000`
- `MONGO_CONNECTION_STRING=<sua string>`
- `REDIS_URL=redis://...`
- `SEND_QUEUE_NAME=send-messages`
- `INCOMING_QUEUE_NAME=incoming-messages`
- `LOG_INGEST_TOKEN=<token compartilhado com worker/frontend>`
- `GROUP_ID` / `ALLOWED_PING_GROUP`
- `JWT_SECRET`
- OpenAI vars se usar IA (`OPENAI_API_KEY` etc.)
- `TZ=America/Sao_Paulo`

## Docker
```bash
docker build -t backend .
docker run -d --env-file .env -p 3000:3000 backend
```

## Entradas/Saídas
- Fila entrada: `incoming-messages` (produzida pelo worker com mensagens recebidas).
- Fila saída: `send-messages` (consumida pelo worker para enviar no WhatsApp).

## Autenticação
- JWT simples para rotas admin (`/auth/*`).
- Rota de ingest de logs usa token `LOG_INGEST_TOKEN` via header `x-log-token`.
