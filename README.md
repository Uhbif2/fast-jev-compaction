# fast-jev-compaction-local

Локальный форк `fast-jev-compaction` для Claude Code function hooks. Он заменяет summarization-style
compaction на Jev-решения по tool history: старые `tool_use/tool_result` оцениваются по
информационной релевантности, а сохранённые сообщения остаются verbatim.

Документация local fork:

- `CLAUDE.md` — инварианты и правила для агента;
- `OPERATIONS.md` — установка, update, validation, rollback;
- `CONTEXT.md` — причины форка, архитектурные решения и проверенные наблюдения;
- `hooks/README.md` — детали function-hook surface.

## Текущее поведение

По умолчанию local fork не удаляет user/assistant text. Основные кандидаты — tool calls/results.
Экспериментальная assistant-text compaction существует, но `compactAssistantText=false`.

Для каждого tool call Jev оценивает отдельно:

- релевантность факта вызова/input;
- релевантность информации в result.

Result question содержит head/tail preview фактического output.

Длинный разговор покрывается evidence shards под физические лимиты Jev. Score одного target по
нескольким shards агрегируется через MAX. Jev requests выполняются последовательно и имеют retry
для transport/429/5xx.

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
