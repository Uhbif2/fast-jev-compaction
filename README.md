# fast-jev-compaction-local

Форк [`tamaratran/fast-jev-compaction`](https://github.com/tamaratran/fast-jev-compaction) 0.3.0
для Claude Code function hooks. Как и оригинал, он заменяет summarization-style compaction
Jev-решениями по tool history: сохранённые сообщения остаются verbatim.

> A heavily reworked fork of fast-jev-compaction 0.3.0 (about 3x the code and tests). Docs are in Russian.

## Чем отличается от upstream

- **Критерий Jev** — информационная релевантность для корректного продолжения разговора, а не
  «хранить ли verbatim / можно ли перезапустить инструмент». Вопрос о результате получает
  реальный head/tail preview.
- **Выгрузка вместо удаления.** Всё урезанное или свёрнутое пишется на страницу
  (`~/.claude/fast-jev-pages/<сессия>/<tool_use_id>.call.txt`), а заметка в контексте называет
  файл; вернуть можно одним Read. Текст, набранный пользователем, не удаляется никогда.
- **Что остаётся, решает содержимое** (вопрос `keep_or_page`), а не целевая доля окна;
  `ceilingPercent` — только потолок против повторной автокомпакции.
- **Размеры в токенах Claude**; накладные расходы берутся из первого запроса после прошлой
  компакции.
- **Длинная история** покрывается evidence shards под лимиты Jev, score target = MAX по shards;
  запросы последовательные, с retry.
- **Никогда не уходит во встроенное саммари Claude**: при ошибке Jev сессия не меняется;
  есть выключатель встроенного `/compact` (`guard/`).
- Автокомпакция после закрытия хода, корректный replay ветки транскрипта, нет задвоения
  истории после reload.
- Инструменты замера и отладки в `scripts/` (replay, evaluate, jev-experiment, verify-transcript).

Документация:

- `OPERATIONS.md` — установка, update, validation, rollback;
- `CONTEXT.md` — причины форка, архитектурные решения и проверенные наблюдения (журнал local.N);
- `hooks/README.md` — детали function-hook surface.

## Текущее поведение

По умолчанию local fork не удаляет user/assistant text. Основные кандидаты — tool calls/results.
Экспериментальная assistant-text compaction существует, но `compactAssistantText=false`.

Для известных read-only tool calls Jev оценивает отдельно:

- релевантность факта вызова/input;
- релевантность информации в result.

Для команд с возможным побочным эффектом сохраняется запись действия, оценивается только result.

Result question содержит head/tail preview фактического output.

Длинный разговор покрывается evidence shards под физические лимиты Jev. Score одного target по
нескольким shards агрегируется через MAX. Jev requests выполняются последовательно и имеют retry
для transport/429/5xx.

Большие сообщения обеих ролей делятся только в evidence для Jev; выходной текст остаётся целым.
Сначала проверяются самые объёмные результаты, до мягкого бюджета 16 запросов за проход.
`deferred` означает данные, сохранённые до следующего прохода. Уже усечённые результаты не
оцениваются повторно. Усечение оставляет начало и конец результата плюс указатель на оригинал.

При ошибке Jev local fork не запускает built-in Claude summary: исходная сессия остаётся
неизменной.

## Development

```text
npm ci
npm run typecheck
npx vitest run
claude plugin validate .claude-plugin/plugin.json
```

Для установки и выпуска новой local version см. `OPERATIONS.md`.

## Sensitive configuration

Runtime credential для TypeSafe передаётся через окружение или sensitive plugin option. Его
значение не хранится в repository, docs, logs или fixtures.
