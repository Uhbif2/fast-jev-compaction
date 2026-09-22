# Claude Code function-hook adapter

`hooks/fast-jev.ts` адаптирует `session.compact` и `turn.complete` к библиотеке в `src/`.

## Current behavior

- Claude Code function hooks >= 2.1.274; при разработке проверена bundled 2.1.275.
- `session.compact` никогда не вызывает `next(event)` (это встроенное саммари Claude): отвечает
  сжатыми сообщениями или `{ skip: причина }` — при ошибке Jev, no-op и малом сокращении.
  Хук не отклоняется даже при сбое UI. `/compact <текст>` добавляется к goal для Jev.
- `turn.complete` запускает автокомпакцию (trigger `plugin`) после `await next(event)`, только в
  главном цикле, при `context.percent >= compactAtPercent` и не чаще, чем контекст вырастает на
  10% окна. Отказ — toast один раз. Следующий ход показывает реальный размер первого запроса
  после компакции.
- Автокомпакция движка выключается снаружи: `DISABLE_AUTO_COMPACT=1` (см. `../OPERATIONS.md`).
- Jev requests выполняются последовательно.
- Retry: transport errors, HTTP 429 и 5xx, до 6 попыток, с учётом `Retry-After`, общий бюджет
  150 s на компакцию; permanent 4xx/invalid response не ретраятся. Паузы — `$.clock.sleep`.
- Toast'ы содержат `LOCAL_BUILD` и trigger.
- Result contents не пишутся в diagnostic UI logs.

## Local profile

```text
compactAtPercent=30
keepThreshold=0.01
preserveRecentMessages=12
minReductionRatio=0
compactAssistantText=false
maxStateTokens=31000
maxRequestTokens=62000
resultPreviewChars=1000
truncateHeadChars=300
model=jev-latest
```

`/reload-plugins` может не переключить уже живой Code runtime на новый versioned hook cache.
Проверять `LOCAL_BUILD` в toast; если marker старый — открыть новый Code runtime или
переоткрыть Code-чат. Полный release/rollback процесс: `../OPERATIONS.md`.
