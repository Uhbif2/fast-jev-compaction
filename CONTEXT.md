# Durable context — fast-jev-compaction-local

Обновлено: 21.09.2026.

## Идентичность

- Upstream: tamaratran/fast-jev-compaction 0.3.0.
- Local plugin: fast-jev-compaction-local@fast-jev-compaction-local.
- Upstream установлен отдельно и disabled.
- Текущий local release: 0.3.0-local.7.
- После миграции единственный рабочий исходник: <repo>.

## Зачем fork

Критерий изменён с «нужно ли хранить output verbatim / можно ли rerun» на информационную
релевантность корректному продолжению текущего разговора. Result question получает реальный
head/tail preview.

## Инварианты

- user text не удаляется;
- assistant text по умолчанию не удаляется: compactAssistantText=false;
- кандидаты по умолчанию — tool_use/tool_result;
- длинная история покрывается evidence shards;
- для target итоговый keep score = MAX по shards;
- Jev requests выполняются последовательно;
- transport/429/5xx имеют retry, permanent errors — нет;
- built-in Claude summary fallback отключён: при ошибке Jev история остаётся неизменной.

Planner рассчитан на два физических ограничения Jev: 64k total request и 32k state + longest
question. Поэтому большой разговор покрывается несколькими запросами, а не одним oversized state.

## Рабочий профиль

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

## Claude Code

Function hooks требуют >=2.1.274; при разработке проверена bundled 2.1.275 в Claude Desktop.
Отдельная PATH-версия ранее была старее и не должна использоваться для диагностики Desktop hook.

После plugin update живой Code runtime может удерживать старый versioned hook даже после
/reload-plugins. Проверять LOCAL_BUILD в preflight toast. Если marker старый — открыть новый
Code runtime/переоткрыть Code-чат, не перезапуская весь Desktop без необходимости.

## Проверенные наблюдения

Один ранний Jev run: 282234 -> 47887 примерно за 1.7 s, без isCompactSummary.

После sharding один /compact может занимать 15–30+ секунд: несколько Jev requests идут
последовательно. Длительность сама по себе не означает fallback.

Проверенный no-op local.7: durationMs=17, preTokens=2518, postTokens=61802,
isCompactSummary=false. Обе оставшиеся Read-пары находились в recent pinned window.

В custom compaction preTokens может означать только хвост после предыдущего boundary, тогда как
postTokens — полный возвращённый контекст. UI "from 2.5k tokens" поэтому может быть misleading.

## Диагностика

Function-hook validator не разрешает произвольный node:fs import. Persistent file diagnostics
была удалена; использовать ui.log/toast и compact_boundary metadata.
