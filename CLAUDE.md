# fast-jev-compaction-local — инструкции агенту

Это канонический исходник локального форка `fast-jev-compaction`. После завершения миграции его
единственный дом: `C:\MCPs\fast-jev-compaction-local`.

## С чего начать

1. Прочитать `CONTEXT.md` — принятые решения и ограничения.
2. Прочитать `OPERATIONS.md` — установка, выпуск новой версии, проверка и rollback.
3. Перед правкой проверить `git status` и текущую версию во всех четырёх местах:
   `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`,
   `hooks/fast-jev.ts` (`LOCAL_BUILD`).
4. После правки: `npm run typecheck`, `npx vitest run`, затем
   `claude plugin validate .claude-plugin/plugin.json` подходящей bundled-версией Claude Code.

## Инварианты

- Пользовательский текст никогда не удаляется и не сокращается. Это текст, который набрал владелец;
  старый вывод локальных команд (`<local-command-stdout|stderr|caveat>`, голый `/compact`) — не он.
- Урезание — это выгрузка: полный текст пишется на страницу (`~/.claude/fast-jev-pages`) до
  решения, и заметка называет файл. Не возвращаться к урезанию без страницы.
- Главная ручка — `targetPercent` (цель по размеру), а не `keepThreshold`: Jev хорошо упорядочивает,
  но плохо калиброван (замер 26.09, CONTEXT.md → local.15).
- Текст assistant по умолчанию тоже не удаляется: `compactAssistantText=false`.
  Экспериментальная поддержка есть только как опция и не включается без явного решения владельца.
- Основной объект компактации — `tool_use/tool_result`.
- Критерий Jev — информационная релевантность корректному продолжению текущего разговора, а не
  «нужно ли хранить verbatim» и не «можно ли повторно запустить инструмент».
- Result preview показывается Jev; не возвращаться к варианту «только N chars omitted».
- Низкий score при неполном контексте не должен разрешать удаление. История покрывается shards;
  для одного target итоговый score берётся как максимум по evidence shards.
- `session.compact` работает в Jev-only режиме. Ошибка Jev оставляет исходную сессию неизменной.
  Не делегировать автоматически в built-in Claude summary: это может тратить квоту подписки.
- Запросы Jev идут последовательно, чтобы не создавать burst/rate-limit каскад.
- Не логировать state, tool result contents, API key или Authorization.
- Секрет TypeSafe — sensitive-опция `apiKey` (с 22.09.2026 лежит в `~/.claude/.credentials.json` → `pluginSecrets`, под масками флота); `TYPESAFE_API_KEY` в окружении — только запасной путь, в `settings.json` его нет. Никогда не читать,
  печатать, переносить или коммитить файл с ключом ради этой миграции.

## Технические ограничения Jev

Рабочая модель лимитов Jev 1.13, под которую написан planner:

- до 64k tokens на весь request: state + все questions;
- до 32k tokens на state + самый длинный question.

Поэтому `maxStateTokens` — физический бюджет запроса, а не лимит всей истории. Длинная история
покрывается несколькими evidence shards; нельзя просто поставить Infinity/60k state.

## Claude Code

Function hooks требуют Claude Code >= 2.1.274. В Claude Desktop проверялась bundled 2.1.275.
Старая отдельная PATH-версия Claude Code может отставать и давать ложные ошибки загрузки hook;
для диагностики Desktop использовать bundled runtime.

После обновления versioned plugin cache существующая Code-сессия может продолжать держать старый
function hook даже после `/reload-plugins`. Проверять версию по preflight toast с `LOCAL_BUILD`.
Если build marker старый — создать новый Code runtime/переоткрыть Code-чат. Сам Claude Desktop
не убивать: Cowork может зависеть от его процессов.

## Что не делать

- Не редактировать установленный cache как источник правды.
- Не вести вторую рабочую копию в `C:\Users\user\Scripts` после принятого переезда.
- Не менять plugin/marketplace identity одновременно с переносом пути.
- Не переиспользовать старый номер версии после отката; делать новый patch release.
- Не запускать `npm audit fix --force`.
- Не включать `compactAssistantText` без явного запроса владельца.
