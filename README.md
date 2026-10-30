# Velly Bridge

Service-плагин Stitch: локальный мост к Velly, каталог моделей, состояние каждой модели и экспорт настроек OpenCode. Требуются Windows, Node.js 22+ и выполненный вход в Velly.

## Интеграция с AI Hub

Плагин находится в `IDE-Account-Manager/plugins-src/stitch-velly`. Код общего Gateway и страниц находится в соседнем публичном клоне `Stitch-Manager`, согласно AGENTS.md хаба. Одного dev-install в старую сборку недостаточно: рантайму нужны модули `velly_bridge.py`, адаптер Velly и изменения discovery/startup.

25.10.2026 изменения также перенесены в рабочий клон хаба с резервной копией для локального запуска пользователя. Его backend на 25584 вернул 25 записей Velly через `/v1/models`. Проверочный браузер на 5181 использует тот же код хаба с отдельной БД.

Страница `/ai/velly` использует `core_page` и содержит вкладки «Модели», «Подключение», «Токены». Старый адрес `/ai/plugin/stitch-velly` перенаправляется на неё. В моделях есть поиск, фильтр проверенных моделей, копирование ID и переход в чат. Настройки путей подставляются из обнаруженного окружения. Модели не вызываются при открытии страницы; ручной тест требует нажатия отдельной кнопки.

Во вкладке «Токены» можно сохранить API-токен в JSON. Команда `export_secrets` сохраняет файл в `data/plugins/stitch-velly/exports`, а интерфейсу возвращает только путь и список полей. Ключ устройства показан отдельно; в текущем интерфейсе экспортируется только API-токен. Внутренняя команда также поддерживает явный `includeDeviceKey: true`; этот вариант проверен на тестовых значениях. Ни чтение страницы, ни поллинг не расшифровывают секреты. Каталог экспорта получает `.gitignore`, файлы не перезаписываются.

Чат обновляет каталог каждые 10 секунд и при возврате фокуса. Модели `velly/...` используют `/v1/chat/completions` общего backend независимо от состояния старого CLI-прокси. В «Маршрутизация → Модели» зарегистрированы публичные имена и маршруты. На схеме и в подключениях есть карточка Velly → AI Gateway с URL и кнопкой копирования ключа установки Stitch.

Токен Velly читается из `auth.bin` через Chromium/Windows DPAPI и остаётся у моста. Клиентам выдаётся локальный ключ. Каталог обновляется по таймеру; состояние генерации учитывается отдельно для каждой модели. Автовыбор Messages и Responses использует раздельные цепочки. После начала ответа автоматического повтора нет.

Наличие модели в каталоге не подтверждает её текущую работоспособность. Ручная проверка инструмента расходует квоту; девять моделей с исторически подтверждённой записью по умолчанию пропускаются.

## Quick start (dev loop)

> **Prerequisite:** `stitch_plugin_tools` must be importable. Run
> `pip install -e python/` from the repo root first, or run all
> `python -m stitch_plugin_tools` commands from the `python/` dir.

```bash
# 1. Generate a signing keypair (one-time):
python -m stitch_plugin_tools keygen --out keys/

# 2. Sign the package:
python -m stitch_plugin_tools sign . --key keys/private.key

# 3. Dev-install to plugins-local:
python -m stitch_plugin_tools dev-install .

# 4. Start Stitch with STITCH_DEV_MODE=1 (allows unsigned dev packages):
STITCH_DEV_MODE=1 python -m stitch_backend
```

## Commands

| Command | Readonly | Description |
|--------|----------|-------------|
| `health_check` | yes | Health check — returns `{pong: true}` |
| `get_status` | yes | Состояние моста и моделей |
| `start_bridge` / `stop_bridge` | no | Запуск / остановка моста |
| `refresh_catalog` / `action_status` | no / yes | Обновление каталога / состояние фоновой команды |
| `export_opencode` | no | Экспорт карточек в OpenCode с резервной копией |
| `get_connection` | yes | Обнаруженные пути и наличие файлов секретов, без значений |
| `export_secrets` | no | Локальная выгрузка API-токена, ключ устройства — только с явным параметром |
| `export_gateway_config` / `get_gateway_provider` | no | Конфигурация подключения общего Gateway |
| `probe_model` | no | Ручная проверка инструмента, расходует квоту |

## Testing

`new` generates `tests/test_plugin_protocol.py` — a protocol smoke test
that spawns the plugin and drives the raw JSON-RPC line protocol over
stdin/stdout (init → ping → health_check → shutdown). No host or harness
dependency; copy the pattern for your own commands.

```bash
# Run the generated test (from the package root):
pip install pytest pytest-timeout
python -m pytest tests/ -q --timeout=60

# Or via the stitch_plugin_tools test command:
python -m stitch_plugin_tools test .
```

## Layout

```
stitch-velly/
├── plugin.json              # v2 manifest (kind=service)
├── README.md
├── tests/
│   └── test_plugin_protocol.py  # generated protocol smoke test
└── stitch_velly/
    ├── __init__.py
    ├── __main__.py           # RPC entry (RpcPluginServer)
    ├── service.py             # domain logic (handlers delegate here)
    └── storage.py            # SQLite helper
```

## Publishing

Публикация выполняется через CI-ферму по правилам AGENTS.md хаба. Плагин не опубликован. 26.10.2026 рабочий `opencode.json` переведён на локальный мост Stitch с резервной копией; старый `velly-opencode-plugin.mjs` из `Work-Velly` удалён из списка плагинов.

## Подключение и авторизация

«Применить настройки» заменяет только `provider.velly` и связанный плагин в OpenCode. Записываются адрес локального моста, его локальный ключ и карточки моделей. Токен Velly в OpenCode не экспортируется. Мост должен работать в Stitch; после изменения конфигурации OpenCode требуется перезапуск.

Мост читает актуальный `auth.bin`. После HTTP 401 он принудительно перечитывает файл и повторяет запрос только если токен изменился. Если отказ сохраняется, один GET каталога помогает различить отказ токена и отказ конкретного маршрута. Генерации для диагностики не выполняются. Успешный каталог не гарантирует право генерации.

Ошибки HTTP содержат `error.source`: `velly_token`, `model_route`, `upstream_session`, `local_storage` или `unknown`. Истёкшая OAuth-сессия поставщика не означает автоматически, что пользователю нужно повторно войти в Velly. После начала SSE поток не переигрывается, исходные события ошибок передаются клиенту.

Для загрузки изменений рантайма нужен перезапуск моста. Подключение каталога к уже работающему процессу код рантайма не обновляет.

For community submission, see `docs/service-plugins.md`.
