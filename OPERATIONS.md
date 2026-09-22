# Operations — fast-jev-compaction-local

## Канонический дом

`C:\MCPs\fast-jev-compaction-local` — свой git (`master`, с 22.09.2026), теги релизов `v<версия>`.
Local marketplace в `~/.claude/settings.json` (`extraKnownMarketplaces`) и
`~/.claude/plugins/known_marketplaces.json` указывает сюда.

Установленная копия Claude Code в `~/.claude/plugins/cache/...` — производная. Её можно читать для
проверки, но никогда не править как источник.

## Текущий локальный профиль

На 22.09.2026 рабочая конфигурация пользователя (`pluginConfigs` в `~/.claude/settings.json`):

| option | value |
|---|---:|
| `compactAtPercent` | `30` |
| `keepThreshold` | `0.01` |
| `preserveRecentMessages` | `12` |
| `minReductionRatio` | `0` |
| `compactAssistantText` | `false` |
| `maxStateTokens` | default `31000` |
| `maxRequestTokens` | default `62000` |
| `resultPreviewChars` | default `1000` |
| `truncateHeadChars` | default `300` |
| `model` | `jev-latest` |

`keepThreshold=0.01` намеренно консервативен: удалять следует только при практически нулевой
вероятности релевантности.

Вне плагина, в `~/.claude/settings.json` → `env`:

- `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` — без него хук не загружается;
- `DISABLE_AUTO_COMPACT=1` — выключает автокомпакцию движка, то есть встроенное саммари Claude.
  Автоматически сжимает только плагин (`turn.complete`). `DISABLE_COMPACT` не ставить: он
  выключает и `/compact`, и `$.session.compact()` плагина.

И в `hooks` того же файла — выключатель встроенного саммари, классический `PreCompact`:
`node "C:/MCPs/fast-jev-compaction-local/guard/block-builtin-compact.mjs"` (timeout 10). Он
живёт в settings, а не в плагине, чтобы работать и тогда, когда плагин не загрузился. **Путь к
нему — потребитель пути компонента:** при переезде папки поправить эту строку.
Проверка без затрат: безголовый `claude -p … --settings '{"enabledPlugins":{"fast-jev-compaction-local@fast-jev-compaction-local":false}}' --resume <id> "/compact"`
должен ответить `Compaction blocked by PreCompact hook`.

## Перенос в C:\MCPs (22.09.2026)

Сделано: папка перенесена владельцем; `git init`, базовый коммит и тег `v0.3.0-local.7`;
marketplace перепривязан (резервные копии обоих файлов — `*.bak-20260922-fastjev`);
`npm run typecheck`, `vitest`, `plugin validate` — зелёные. Осталось: выпуск local.8 через
`plugin update`, проверка marker в новой Code-сессии, запись в `stack.json`/`MAP.md` пульта.
Исходный чек-лист:

1. Скопировать исходники, но не `node_modules`, `dist`, cache, временные backups и секреты.
2. На новом месте создать собственный Git repository (`master`), потому что старая папка жила
   как untracked subtree внутри репозитория `C:\Users\user\Scripts`.
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

**Эффект проверять по следующему запросу, а не по boundary.** После компакции, которая
состоялась, плагин на следующем `turn.complete` показывает «first request after compaction
carried N tokens (before: M)». Это `usage` реального запроса к API. В `.jsonl` то же видно у
первого ответа assistant после boundary: `cache_read_input_tokens + cache_creation_input_tokens
+ input_tokens`.

`preTokens`/`postTokens` у boundary эффекта не доказывают:

- `preTokens` может означать только хвост после предыдущего boundary;
- `postTokens` считает то, что вернул хук, даже когда до local.8 он возвращал исходные сообщения
  после ошибки (21.09: boundary «541k → 219k», а следующий запрос — 544k);
- строка UI вроде `from 2.5k tokens` поэтому не доказывает, что весь контекст был 2.5k.

## Rollback

Не править cache руками и не переиспользовать прежний version number.

Предпочтительный rollback:

1. `git revert` проблемного изменения или вернуть код к известному хорошему tag/commit.
2. Выпустить новый forward patch version.
3. Пройти полный release gate.
4. Обновить marketplace/plugin обычным путём.
5. Проверить build marker в новом Code runtime.

Upstream 0.3.0 установлен отдельно и disabled; это reference/fallback, а не рабочий источник local fork.
