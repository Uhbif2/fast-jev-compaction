# Operations — fast-jev-compaction-local

## Канонический дом

После миграции:

`C:\MCPs\fast-jev-compaction-local`

Установленная копия Claude Code в `~/.claude/plugins/cache/...` — производная. Её можно читать для
проверки, но никогда не править как источник.

## Текущий локальный профиль

На 21.09.2026 рабочая конфигурация пользователя:

| option | value |
|---|---:|
| `compactAtPercent` | `20` |
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

## Первый перенос в C:\MCPs

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
9. `/reload-plugins --force` допустим как первая попытка, но не считать его доказательством.
   Preflight toast должен показывать новый `LOCAL_BUILD`.
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
- при Jev error сессия остаётся неизменной, Claude fallback не запускается.

## Как читать результат /compact

Custom function-hook compaction имеет непривычную telemetry семантику:

- `preTokens` у boundary может означать только хвост после предыдущего boundary;
- `postTokens` может быть больше, потому что hook возвращает полный сохранённый контекст;
- строка UI вроде `from 2.5k tokens` поэтому не доказывает, что весь контекст был 2.5k.

Пример 21.09.2026: boundary за 17 ms, `preTokens=2518`, `postTokens=61802`,
без `isCompactSummary`; обе оставшиеся Read-пары были pinned последних 12 сообщений, поэтому это
был корректный no-op.

## Rollback

Не править cache руками и не переиспользовать прежний version number.

Предпочтительный rollback:

1. `git revert` проблемного изменения или вернуть код к известному хорошему tag/commit.
2. Выпустить новый forward patch version.
3. Пройти полный release gate.
4. Обновить marketplace/plugin обычным путём.
5. Проверить build marker в новом Code runtime.

Upstream 0.3.0 установлен отдельно и disabled; это reference/fallback, а не рабочий источник local fork.
