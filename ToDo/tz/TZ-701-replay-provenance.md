```yaml
tz: TZ-701
owns:
  - src/transcript.ts
  - tests/transcript.test.ts
  - tests/replay.test.ts
needs: []
acceptance:
  - npm run typecheck
  - npm test -- tests/transcript.test.ts tests/replay.test.ts
```

# TZ-701 — provenance replay без потери сообщений

## Цель
Исправить S2: после двух ручных compaction восстановленный model-input не содержит дублированных старых skill_listing, instructions и пар tool_use/tool_result одного user turn. Новый законный user turn сохраняется, все исходные user messages побайтно целы, assistant text по умолчанию не удаляется.

## Исполнение
Tests-first на синтетическом журнале: два replay, одинаковый текст в новом turn, несовпадающие IDs, страницы с крупными tool calls/results. Красный тест до исправления, затем provenance-aware нормализация только в src/transcript.ts. Связывать один tool_use с одним result и immutable page ссылкой; не переписывать append-only исходные JSONL, installed cache и реальные сессии. Различать model input и визуальный UI дубль.

## Приёмка
Из корня C:\MCPs\fast-jev-compaction-local выполнить две YAML-команды, обе rc=0. Ревьюер проверяет содержимое expected/actual model-input, сохранность user messages и ссылок на полные страницы, не только число сообщений.

## Передача
После TZ-701 блок совместного hook replay проверяет TZ-703. Никаких реальных Jev ключей, профилей и платных вызовов.
