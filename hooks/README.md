# Claude Code function-hook adapter

`hooks/fast-jev.ts` адаптирует `session.compact` и `turn.complete` к библиотеке в `src/`.

## Current behavior

- Claude Code function hooks >= 2.1.274; при разработке проверена bundled 2.1.275.
- Jev requests выполняются последовательно.
- Retry: transport errors, HTTP 429 и 5xx; permanent 4xx/invalid response не ретраятся.
- Built-in Claude summary fallback отключён.
- Preflight toast содержит `LOCAL_BUILD` и число candidates.
- Result contents не пишутся в diagnostic UI logs.

## Local profile

```text
compactAtPercent=20
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
Проверять `LOCAL_BUILD` в preflight toast; если marker старый — открыть новый Code runtime или
переоткрыть Code-чат. Полный release/rollback процесс: `../OPERATIONS.md`.
