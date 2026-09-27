# Operations — fast-jev-compaction-local

## Канонический дом

`<repo>` — свой git (`master`, с 22.09.2026), теги релизов `v<версия>`.
Local marketplace в `~/.claude/settings.json` (`extraKnownMarketplaces`) и
`~/.claude/plugins/known_marketplaces.json` указывает сюда.

Установленная копия Claude Code в `~/.claude/plugins/cache/...` — производная. Её можно читать для
проверки, но никогда не править как источник.

## Текущий локальный профиль

На 22.09.2026 рабочая конфигурация пользователя (`pluginConfigs` в `~/.claude/settings.json`):

| option | value |
|---|---:|
| `compactAtPercent` | `30` |
| `targetPercent` | default `15` (local.15): до какой доли окна выгружать, `0` — только порог |
| `keepThreshold` | `0.5` |
| `preserveRecentMessages` | `12` |
| `minReductionRatio` | `0` |
| `compactAssistantText` | `false` |
| `maxStateTokens` | default `31000` |
| `maxRequestTokens` | default `62000` |
| `resultPreviewChars` | default `1000` |
| `truncateHeadChars` | default `300` |
| `model` | `jev-latest` |
| `maxJevRequests` | default `16` |

Профиль перечитан 22.09 при работе над local.11. Порог уже был 0.5; 0.01 в прежней документации
было устаревшим значением. Вероятностная оценка Jev не является гарантией отсутствия потери смысла.
Полные тексты user/assistant сохраняются; старые результаты доступны в исходных записях `.jsonl`.

Вне плагина, в `~/.claude/settings.json` → `env`:

- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` — без него хук не загружается;
- `DISABLE_AUTO_COMPACT=1` — выключает автокомпакцию движка, то есть встроенное саммари Claude.
  Автоматически сжимает только плагин (`turn.complete`). `DISABLE_COMPACT` не ставить: он
  выключает и `/compact`, и `$.session.compact()` плагина.

И в `hooks` того же файла — выключатель встроенного саммари, классический `PreCompact`:
`node "<repo>/guard/block-builtin-compact.mjs"` (timeout 10). Он
живёт в settings, а не в плагине, чтобы работать и тогда, когда плагин не загрузился. **Путь к
нему — потребитель пути компонента:** при переезде папки поправить эту строку.
Проверка без затрат: безголовый `claude -p … --settings '{"enabledPlugins":{"fast-jev-compaction-local@fast-jev-compaction-local":false}}' --resume <id> "/compact"`
должен ответить `Compaction blocked by PreCompact hook`.

## Перенос в <local folder> (22.09.2026)

Сделано: папка перенесена владельцем; `git init`, базовый коммит и тег `v0.3.0-local.7`;
marketplace перепривязан (резервные копии обоих файлов — `*.bak-20260922-fastjev`);
`npm run typecheck`, `vitest`, `plugin validate` — зелёные. Осталось: выпуск local.8 через
`plugin update`, проверка marker в новой Code-сессии, запись в локальный реестр.
Исходный чек-лист:

1. Скопировать исходники, но не `node_modules`, `dist`, cache, временные backups и секреты.
2. На новом месте создать собственный Git repository (`master`), потому что старая папка жила
   как untracked subtree внутри репозитория `<previous folder>`.
3. Выполнить `npm ci` для пересоздания env.
4. Прогнать проверки из раздела ниже.
5. Перепривязать local marketplace Claude Code к новому пути, не меняя identity:
   `fast-jev-compaction-local@fast-jev-compaction-local`.
6. Убедиться, что plugin options не сбросились.
7. Проверить новую Code-сессию по preflight marker.
8. Только после приёмки старый исходник считать retired; не запускать две рабочие копии параллельно.

## Выпуск новой локальной версии

Версия меняется синхронно в четырёх местах:

1. `package.json`
2. `.claude-plugin/plugin.json`
3. `.claude-plugin/marketplace.json`
4. `hooks/fast-jev.ts` → `LOCAL_BUILD`

Порядок:

1. Изменить код и тесты.
2. `npm run typecheck`
3. `npx vitest run`
4. bundled Claude Code: `plugin validate .claude-plugin/plugin.json`
5. Коммит в repository компонента; tag текущего release.
6. `claude plugin marketplace update fast-jev-compaction-local`
7. `claude plugin update fast-jev-compaction-local@fast-jev-compaction-local`
8. Проверить settings: профиль выше должен сохраниться.
9. Не полагаться на `/reload-plugins`: 22.09 после него рантайм оставался на старой версии.
   Версию процесса видно в `…/<версия>/.in_use/<pid>`, toast показывает `LOCAL_BUILD`.
10. Если runtime держит старый hook — переоткрыть только Code-сессию/создать новый Code runtime,
    не перезапускать Claude Desktop целиком.
11. Выполнить `/compact` на безопасной сессии и проверить, что built-in summary не появился.

## Проверки

Минимальный release gate:

```text
npm run typecheck
npx vitest run
claude plugin validate .claude-plugin/plugin.json
```

Дополнительно:

- plugin list показывает ожидаемую версию enabled;
- upstream `fast-jev-compaction@fast-jev-compaction` остаётся disabled rollback-reference;
- установленный cache содержит ожидаемый `LOCAL_BUILD`;
- `compactAssistantText=false`;
- TypeSafe key только проверяется на наличие, его значение не выводится;
- no-op `/compact` при 0 eligible candidates должен завершаться почти мгновенно и не обращаться к Jev;
- при Jev error, no-op и малом сокращении хук отвечает `{ skip }`: сессия неизменна, boundary
  не пишется, Claude summary не запускается;
- `DISABLE_AUTO_COMPACT=1` на месте в `~/.claude/settings.json` → `env`.

## Как читать результат /compact

Toast'ы плагина начинаются с `fast-jev <LOCAL_BUILD> [<trigger>]` (`manual` — `/compact`,
`plugin` — автокомпакция плагина). Отказ и no-op приходят одной строкой причины.

Итог состоявшейся компакции (с local.16; числа для примера формата):

```text
fast-jev 0.3.0-local.16 [manual]: done in 9 s, no summary; context 400k → ≈150k tokens
(−230k of messages, ≈−20k of 41 thinking block(s); the next reply shows the exact size.
Claude Code's own "saved N tokens" line is characters/4 …, not the size). Jev checked 55 of 55
candidate(s): 3 result(s) truncated, 50 kept in 2 request(s); 77 old call input(s) paged out;
207 old call(s) collapsed to reach the size target; 0 page-in(s) since the last compaction; …
```

- `context U → ≈A` — U реальный размер последнего запроса, A оценка после, в токенах Claude
  (2.03 символа на токен, thinking ≈480 на блок; `src/size.ts`). Точно — следующий ответ;
- строка движка «Compacted … saved N tokens» и счётчик контекста Desktop до следующего ответа
  показывают `postTokens` движка: символы / 4 без системного промпта и инструментов, примерно
  половина правды. На неё не смотреть;
- `messages ≈X → ≈Y` вместо этого — сессия была переоткрыта с задвоенной историей, и последний
  замер устарел; рядом стоит `N duplicated call(s) removed`;
- `no Jev request needed` — кандидатов для Jev не было, работали только выгрузка входов,
  сворачивание до цели, thinking и дубли;
- `N old call input(s) paged out` — длинные поля старых входов (Bash, Write, Edit, …) выгружены;
- `N old call(s) collapsed to reach the size target` — столько старых вызовов свёрнуто до строки
  со страницей ради `targetPercent`;
- `N page-in(s) since the last compaction` — сколько раз модель читала страницы после прошлой
  компакции. Много — выгрузка слишком смелая: поднять `targetPercent`.

Страницы лежат в `~/.claude/fast-jev-pages/<первые 8 символов сессии>/<tool_use_id>.call.txt`
(до local.16 — `<сессия>/<id>.txt` и `<id>.input.txt`); это данные сессии, удалять их можно вместе
с сессией. Блокировки встроенного саммари — `~/.claude/fast-jev-guard.log`.

**Эффект проверять по следующему запросу, а не по boundary.** После компакции, которая
состоялась, плагин на следующем `turn.complete` показывает «first request after compaction
carried N tokens (before: M; −D, −P%, …)». Это `usage` реального запроса к API, в него входят и
новые сообщения этого хода. В `.jsonl` то же видно у первого ответа assistant после boundary:
`cache_read_input_tokens + cache_creation_input_tokens + input_tokens`.

`preTokens`/`postTokens` у boundary и строка движка «compacted …» эффекта не показывают:

- `postTokens` движок считает сам и только по содержимому сообщений — без системного промпта,
  схем инструментов, вложений и thinking; `preTokens` — реальный размер. Их разность завышает
  эффект в разы (26.09: «204k → 71k», фактически 200k → 164k). Хук её не переопределяет;
- `preTokens` может означать только хвост после предыдущего boundary;
- после компакции хуком Desktop показывает переписку заново под разделителем: копий на экране
  столько, сколько было компакций, плюс одна. Это отображение, не контекст (см. CONTEXT.md,
  local.16);
- до local.8 хук при ошибке возвращал исходные сообщения, а boundary всё равно писался
  (21.09: «541k → 219k», а следующий запрос — 544k).

## Целостность после компакции

Движок пишет компакцию хука копиями сообщений (см. CONTEXT.md, local.14). Проверка записанного и
того, что загрузит переоткрытие сессии, без вывода содержимого:

```text
npx tsx scripts/verify-transcript.ts <session.jsonl>
```

Из чего состоит контекст после компакции и что оставила бы текущая версия (без сети, размеры в
токенах Claude, `--before N` — состояние перед N-й границей):

```text
npx tsx scripts/composition.ts <session.jsonl> [--before N] [opt:targetPercent=20]
```

Чисто, когда `linksIntoHistory`, `sharedMessageIds`, `recoveredOnReload` и дубли равны 0, а
`chainStartsAfterBoundary` — true (код выхода 0). Транскрипт, записанный до local.14, эту проверку
не проходит; первая компакция local.14 его лечит.

## Реплей и живая проверка

```text
npx tsx scripts/replay.ts <transcript.jsonl> --baseline <installed-plugin-root>
```

Скрипт читает только цепочку выбранной сессии и выводит агрегаты; scorer фиктивный. Его
`maximumReductionPercent` — потолок экономии при минимальных score, НЕ измерение качества Jev.
`--before-boundary` проверяет цепочку перед последней компакцией.

Живая проверка на полностью синтетическом разговоре:

```text
node scripts/smoke.mjs <bundled-claude.exe>
```

Живая проверка на копии реальной сессии (Jev-запросы идут, модель не вызывается, исходная сессия
и `settings.json` не меняются):

```text
node scripts/live-compact.mjs <bundled-claude.exe> <session.jsonl> [--rows N] [opt:keepThreshold=0.65]
```

`--rows N` берёт первые N строк — например, состояние перед boundary; `opt:` меняет опцию плагина
только для этого прогона. Скрипт печатает уведомления плагина (включая оценки Jev по каждому
вызову) и результат `verify-transcript`. Копии и форки лежат в `.git/fastjev-live` и в
`~/.claude/projects/<project>/`.

Синтетическая `smoke.mjs` создаёт отдельный fork, запускает `/compact` установленным плагином и проверяет сохранность
всех текстов, нужного результата и отсутствие Claude summary. Credentials читает только сам
Claude. `--source` меняет identity на inline-plugin и потому может не получить sensitive apiKey;
для сетевой приёмки использовать установленную версию. Настройки основной сессии не меняются.

`deferred` в итоге означает кандидатов, оставленных на следующий проход ради ограничения времени.
Повторный ручной `/compact` продвигает очередь; авто-компакция соблюдает обычный cooldown.

## Rollback

Не править cache руками и не переиспользовать прежний version number.

Предпочтительный rollback:

1. `git revert` проблемного изменения или вернуть код к известному хорошему tag/commit.
2. Выпустить новый forward patch version.
3. Пройти полный release gate.
4. Обновить marketplace/plugin обычным путём.
5. Проверить build marker в новом Code runtime.

Upstream 0.3.0 установлен отдельно и disabled; это reference/fallback, а не рабочий источник local fork.
