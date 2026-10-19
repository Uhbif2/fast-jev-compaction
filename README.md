# fast-jev-compaction-local

Локальный форк `fast-jev-compaction` для Claude Code function hooks. Он заменяет summarization-style
compaction на Jev-решения по tool history: старые `tool_use/tool_result` оцениваются по
информационной релевантности, а сохранённые сообщения остаются verbatim.

Документация local fork:

- `CLAUDE.md` — инварианты и правила для агента;
- `OPERATIONS.md` — установка, update, validation, rollback;
- `CONTEXT.md` — причины форка, архитектурные решения и проверенные наблюдения;
- `hooks/README.md` — детали function-hook surface.

## Clean start / patch release (TZ-705)

Единственный исходник: `C:\MCPs\fast-jev-compaction-local`. Полный
офлайн-прогон на **синтетике**, без доступа к установленному кэшу и личным чатам:

```text
cd C:\MCPs\fast-jev-compaction-local
npm ci
npm run typecheck
npm test
npm test -- tests/ui-boundary.test.ts
```

`npm test` — полный `vitest run`, а не ограниченный subset. Пример TZ-704
делает две настоящие compaction-hook операции с поддельным HTTP и in-memory
страницами, отдельно проверяя model input, append-only journal и синтетический
UI. **GUI Claude Desktop: NOT_RUN** — тест не утверждает, что визуальные дубли
исправлены. Дубли только в UI с корректным model input передаются как
внешняя ошибка Desktop с exact version/expected/actual (см.
`docs/desktop-ui-boundary.md`). Строка движка «saved N tokens» не
управляется плагином.

**Release HOLD (18.10.2026):** по разрешению владельца-оператора
подготовлен **только кандидат** `0.3.0-local.20`: три manifests и
`hooks/fast-jev.ts::LOCAL_BUILD` синхронизированы в исходнике. Последняя
закреплённая версия — `v0.3.0-local.19`; новая не установлена, tag/publish
не выполнялись. `package-lock.json` согласован с `.20` по расширенной
штатным запросом зоне TZ-705; изменения набора зависимостей не требуются.
Не пройдены обязательные выпускные ворота: `claude plugin validate
.claude-plugin/plugin.json` именно совместимой bundled Code версии
с квитанцией `rc=0`, SHA-256 исходника ↔ установленного кэша и
разрешённый владельцем rollout. **BLOCKED / RELEASE_NOT_RUN / GUI_NOT_RUN**.
До этих доказательств **не выполнять** plugin marketplace update,
plugin update, live smoke или публикацию. План и forward-patch rollback —
в `OPERATIONS.md`.

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
npm test
# Отдельный выпускной gate: только подходящий bundled Claude Code,
# не текущий npm/CI и не PATH-клиент неизвестной версии:
claude plugin validate .claude-plugin/plugin.json
```

Для установки и выпуска новой local version см. `OPERATIONS.md`.

## Sensitive configuration

Runtime credential (OpenRouter по умолчанию, `provider=typesafe` — TypeSafe) передаётся через окружение или sensitive plugin option (`openrouterApiKey` / `apiKey`). Его
значение не хранится в repository, docs, logs или fixtures.
