# Durable context — fast-jev-compaction-local

Обновлено: 22.09.2026.

## Идентичность

- Upstream: tamaratran/fast-jev-compaction 0.3.0.
- Local plugin: fast-jev-compaction-local@fast-jev-compaction-local.
- Upstream установлен отдельно и disabled.
- Текущий local release: 0.3.0-local.9.
- Единственный рабочий исходник: `<repo>` (свой git с 22.09.2026;
  базовая точка — тег `v0.3.0-local.7`). Local marketplace указывает сюда.

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
- transport/429/5xx имеют retry (с учётом Retry-After, общий бюджет 150 s на компакцию),
  permanent errors — нет;
- **встроенное саммари Claude не запускается никогда.** Хук `session.compact` не вызывает
  `next(event)`: он отвечает сам — сжатыми сообщениями или `{ skip }`, в том числе при ошибке
  Jev, no-op и малом сокращении. Автокомпакция движка (это Claude summary) выключена
  `DISABLE_AUTO_COMPACT=1` в `~/.claude/settings.json` → `env`; автоматически сжимает только
  сам плагин из `turn.complete`.

Planner рассчитан на два физических ограничения Jev: 64k total request и 32k state + longest
question. Поэтому большой разговор покрывается несколькими запросами, а не одним oversized state.

## Рабочий профиль

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

## Автокомпакция

`turn.complete` зовёт `$.session.compact()` (trigger `plugin`) **после** `await next(event)`:
движок отвергает вызов, пока ход не закрыт ядром («a turn is running … call it from
turn.complete or later»). До 0.3.0-local.8 вызов стоял до `next(event)` — по транскриптам с
20.09 не было ни одной компакции с trigger `plugin`/`auto`, все 11 — `manual`. Хук при вызове
из плагина пропускает только вызывающий хук (`turn.complete`), а `session.compact` того же
плагина событие видит, так что Jev-хук при этом работает.

Повтор не раньше, чем контекст вырастет на 10% окна от прошлой попытки: иначе контекст, который
Jev оставил выше порога, запускал бы компакцию на каждом ходу. Субагентские ходы автокомпакцию
не запускают. Отказ вызова показывается toast'ом один раз, дальше — в `ui.log`.

## Claude Code

Function hooks требуют >=2.1.274; при разработке проверена bundled 2.1.275 в Claude Desktop.
Отдельная PATH-версия (2.1.212) старее и не должна использоваться для диагностики Desktop hook.

После plugin update живой Code runtime держит старый versioned hook и после
`/reload-plugins` — проверено 22.09: `/reload-plugins` в 06:16:40Z, а `/compact` в 06:16:52Z
отработал ещё на local.7. Какую версию держит процесс, видно без догадок:
`~/.claude/plugins/cache/fast-jev-compaction-local/fast-jev-compaction-local/<версия>/.in_use/<pid>`
(в файле `procStartFt` — время старта процесса, FILETIME). Новая версия подхватывается только
новым Code runtime: переоткрыть Code-чат, весь Desktop не перезапускать. В toast — маркер
`fast-jev <LOCAL_BUILD> [trigger]`.

## Проверенные наблюдения

Один ранний Jev run: 282234 -> 47887 примерно за 1.7 s, без isCompactSummary.

Длительность не означает, что сработал fallback. На разговоре в 229 сообщений со 106 парами
инструментов (реплей 22.09) Jev-компакция — это 6 последовательных запросов, 10–20 с. До local.9
к ним добавлялись ~3.3 с синхронного планирования до первого запроса: планировщик был
квадратичным. 22.09 такую компакцию прервали на 15-й секунде, приняв её за встроенную.
Встроенное саммари на том же объёме — 40–120 с, и оно оставляет в транскрипте
`isCompactSummary` и boundary с `preservedSegment`. С local.9 Jev виден по ходу: toast
`fast-jev … Jev request k/N, t s` (не чаще раза в 3 с), итог — отдельным toast.

`preTokens`/`postTokens` в `compact_boundary` **не доказывают эффект**. До local.8 при ошибке
и no-op хук возвращал исходные сообщения, движок всё равно писал boundary (no-op 21.09:
`preTokens=2518`, `postTokens=61802`, 17 ms). Сессия 8c684e1d, 21.09 10:09 и 10:58: boundary
«541k → 219k» и «682k → 273k», а следующий запрос к API ушёл с 544k и 683k токенов — сжатие
не применилось. Причина подтверждена реплеем живой цепочки через планировщик: отказ
`all user messages plus the minimal global dialogue index exceed the Jev state limit (~79k
tokens, limit 30k)` за 71 ms (см. ниже).
Эффект проверять по `usage` первого ответа после компакции: с local.8 плагин сам показывает
toast «first request after compaction carried N tokens (before: M)».

Все сообщения роли user идут в каждый evidence shard целиком. Сюда попадают не только реплики
владельца, но и прежние саммари Claude и вывод slash-команд: в 8c684e1d это 88k + 17k символов
против 21k набранных. Оценщик токенов считает кириллицу по 0.9 токена на символ (английский
текст — примерно 0.21). Из-за этого state переполняется, и компакция длинной сессии отказывает
целиком. Решение — в плане методологии (`docs/review-2026-09-22.md`).

## Диагностика

Function-hook validator не разрешает произвольный node:fs import. Persistent file diagnostics
была удалена; использовать ui.log/toast и compact_boundary metadata, а для эффекта — `usage`
следующего ответа в `.jsonl` транскрипта.
