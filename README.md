# Geo TDS Tracker (standalone)

Отдельный рабочий трекер для мультиссылок по GEO.

## Что умеет

- Публичный редирект: `GET /go/:slug`
- Выбор URL по:
  - стране (`country_code`, ISO-2: `US`, `KZ`, `DE`)
  - типу устройства (`all`, `desktop`, `mobile`, `tablet`)
  - весу (`weight`) для ротации
- Fallback на `default_url`, если страна не найдена
- Лог кликов в PostgreSQL
- Веб-админка: `/admin`

## Быстрый локальный запуск (Docker)

```bash
docker compose up -d --build
```

Открой:
- Админка: `http://localhost:8080/admin`
- Health: `http://localhost:8080/health`

Токен по умолчанию в `docker-compose.yml`: `change-me-strong-token`.

## Конфиг

Смотри `.env.example`:

- `PORT`
- `DATABASE_URL`
- `ADMIN_TOKEN`
- `PGSSL=true` (если внешний Postgres с SSL)

## Deploy в Coolify

Вариант A (рекомендуется): **Dockerfile app + отдельный Postgres в Coolify**

1. Создай новый сервис из Git репозитория с этим проектом.
2. Build Pack: `Dockerfile`.
3. Добавь env vars:
   - `PORT=8080`
   - `ADMIN_TOKEN=<сильный_токен>`
   - `DATABASE_URL=<url_от_postgres_в_coolify>`
   - `PGSSL=true` (если требуется)
4. Порт приложения: `8080`.
5. После деплоя открой `/admin`.

Вариант B: `docker-compose.yml` как один стек.

## API (admin)

Все admin endpoints требуют header:

`Authorization: Bearer <ADMIN_TOKEN>`

- `GET /api/admin/me`
- `GET /api/admin/tds/campaigns`
- `POST /api/admin/tds/campaigns`
- `GET /api/admin/tds/campaigns/:id`
- `PUT /api/admin/tds/campaigns/:id`
- `DELETE /api/admin/tds/campaigns/:id`
- `GET /api/admin/tds/campaigns/:id/stats`

### Пример создания кампании

```bash
curl -X POST http://localhost:8080/api/admin/tds/campaigns \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer change-me-strong-token" \
  -d '{
    "name": "Main campaign",
    "slug": "main-geo",
    "default_url": "https://example.com/default",
    "links": [
      {"country_code":"US","url":"https://example.com/us","device_type":"all","weight":100},
      {"country_code":"KZ","url":"https://example.com/kz","device_type":"mobile","weight":100}
    ]
  }'
```

Публичная ссылка будет:

`http://localhost:8080/go/main-geo`
