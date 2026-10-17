# Исполнимый план завершения fast-jev-compaction-local · 14.10.2026

Цель: выполнить исходную интенцию владельца из `.intent/intent.md` в **существующем** `C:\MCPs\fast-jev-compaction-local`. Выбор `intent/approaches.md`: **A, локальный provenance-aware refactor** вместо shadow-ledger или замены плагина. Доказательный baseline: `py -3 intent/scenarios.py` был функционально RED для S2 (повтор skill_listing/instructions) и S3 (auto compact=1), при S1 synthetic fixture было видно различие estimated 4964→187 и подставленного measured 12000→3000; mock числа не выдавать за реальную Desktop телеметрию.

## Работы

| ТЗ | Непересекающиеся owns в каноническом форке | Наблюдаемый результат |
| --- | --- | --- |
| **TZ-701** · replay provenance | `src/transcript.ts`, `tests/transcript.test.ts`, `tests/replay.test.ts` | Двойной replay S2 не оставляет дублей внутри одного user turn, но не удаляет законный текст нового хода; full tool result находится в immutable page |
| **TZ-702** · manual hook + метрики | `hooks/fast-jev.ts`, `src/size.ts`, `tests/register.test.ts`, `tests/hook.test.ts` | `turn.complete` на 70% → **0** автоматических `session.compact`; manual /compact и Jev error→skip сохранены; `visibleTokens` estimate не смешан с первым measured usage |
| **TZ-703** · сквозной synthetic hook replay | `scripts/hook-replay.ts`, `tests/fast-jev-compaction.test.ts`, `tests/reliability.test.ts` | **Независимый** `py -3 intent/scenarios.py` теперь rc=0 на реальном `hooks/fast-jev.ts::register`, плюс typecheck/полный Vitest rc=0, без подмены сценариев |
| **TZ-704** · UI граница | `docs/desktop-ui-boundary.md`, `tests/ui-boundary.test.ts` | Отдельный обезличенный воспроизводитель различает model input / append-only journal / Claude Desktop renderer; честный upstream report, а не ложное обещание исправить чужую UI строку |
| **TZ-705** · README/чистый запуск/пакет | `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `README.md`, `OPERATIONS.md`, `CONTEXT.md` | Установка с нуля и rollback, согласованная новая patch-версия с `LOCAL_BUILD` TZ-702, отсутствие правок установленного cache или профиля |

Нумерованные исполнимые задания: `ToDo/tz-drafts/TZ-701-replay-provenance.md`, `TZ-702-manual-hook-metrics.md`, `TZ-703-end-to-end-fixtures.md`, `TZ-704-desktop-ui-boundary.md`, `TZ-705-clean-start-release-docs.md`. Серверный регистратор обязан проверить и перенести **каждый** черновик в `ToDo/tz/TZ-*.md` и зарегистрировать соответствующий task в реестре флота. Только файл без зарегистрированной задачи не закрывает эту стадию.

**Инварианты для всех ТЗ:** не удалять/урезать пользовательский текст, не переписывать `.jsonl`, не трогать `~/.claude/fast-jev-pages`, installed cache, credentials или настройки. Все проверки на synthetic data и mock Jev; не привлекать Claude Code/Codex в контур как агентов и не расходовать внешние API/квоты. Решение о выпускаемой patch-версии записать без повторного использования старого номера; не менять идентификатор plugin.

## Зависимости

```text
TZ-701 replay ─┐
               ├─→ TZ-703 integrated S1–S4 ─→ TZ-704 UI boundary ─→ TZ-705 clean start/release docs
TZ-702 hook ───┘                                  (TZ-705 также needs TZ-702 и TZ-703)
```

**TZ-701 и TZ-702 выполняются параллельно**, owns не пересекаются. TZ-703 только после обеих, чтобы не тестировать промежуточный несовместимый API. TZ-704 требует успешной реконструкции model input до сравнения UI слоёв. TZ-705 читает завершённый `LOCAL_BUILD`, синхронизирует manifests и документирует canary, выпуск не запускает автоматически. Каждое ТЗ имеет отдельные acceptance-команды, не слова.

При непредусмотренном пересечении файлов — **request_note на точный чужой owns**, не расширять молча. Любая зависимость, доступ к секретам, личным сессиям, реальному Desktop либо установка вне owns блокируется и выделяется в последующую контролируемую фазу после проверенного результата, а не выдаётся за автоматическую зелёную приёмку.

## Приёмка

1. Для каждого из пяти ТЗ выполнить **все** YAML acceptance-команды; обязательные исходные сигналы `npm run typecheck`, `npx vitest run`, `py -3 intent/scenarios.py` для соответствующих стадий. Измерить RED→GREEN S2 и S3 на тех же inputs; S1 обязан сообщать estimate versus first-request measured (mock обозначить mock), S4 — неизменность user text/page refs и корректность error→skip.
2. Провести `py -3 .intent/check.py executable_plan` из `C:\MCPs\fast-jev-compaction-local` **после регистрации** черновиков сервером, убедиться, что `ToDo/tz/TZ-*.md` присутствуют и каждой есть зарегистрированная work-задача. Не обходить чекер созданием `ToDo/tz` руками.
3. Release gate после реализации: `npm run typecheck`; `npx vitest run`; отдельный безопасный `claude plugin validate .claude-plugin/plugin.json` в контролируемой фазе без вызова Claude Code как агента; потом canary нового Code runtime с проверкой `LOCAL_BUILD`, соответствия версиям, rollback по `OPERATIONS.md`.
4. Для UI-owned `saved N` и повторов в Claude Desktop **не заявлять исправление**, если лишь model-input проверки зелёные. Собрать обезличенный upstream reproducer; при потере текста/страниц или принудительном built-in summary выпуск запрещён.

**Граница стадии:** план и 5 заданий, а не собственно patch или внедрение в Desktop. Результат выпуска считается готовым только после финальных S1–S4, чистого старта, визуальной оговорки и отдельной доставки.

## Итог стадии · блокер регистрации 14.10.2026

15.10.2026, W4002 / claim_id 14221: заново созданы пять содержательных TZ-701–705 в `ToDo/tz-drafts/` с непересекающимися owns. На текущем состоянии сервер **опубликовал TZ-701–704** в `ToDo/tz/` (четыре файла): TZ-701 и TZ-702 уже взяли независимые агенты W4013/W4037, TZ-703/704 ждут зависимостей. **TZ-705 остаётся только черновиком**; `fleet_list` показывает `fix:draft:e836880a7e0cdf68`, который перекрыт текущим active claim. Точная стадийная команда `py -3 .intent/check.py executable_plan` теперь даёт rc=0, но её чекер доказывает только существование хотя бы одного опубликованного TZ, **не все пять**. Следовательно, полнота регистрации/приёмки ТЗ пока не доказана; считать весь executable_plan завершённым рано. Историческая 14.10 ошибка preflight `npx` исправлена эквивалентными YAML `npm test [-- tests/*.ts]` для TZ-701–704 (проверенный script test=vitest run), без снижения тестового покрытия; TZ-705 сохраняет обязательное `claude plugin validate` в acceptance и не должна публиковаться после удаления этого gate. Не переносить черновик вручную и не ослаблять release gate. Следующий шаг — освободить текущий claim для отдельного fix:draft по TZ-705/штатного регистратора; после его независимой приёмки сверить все 5 опубликованных YAML, registry task IDs, acceptance каждой задачи и только тогда объявлять план принятым.

## Актуальная сверка W4025 · 15.10.2026 · claim_id 14363

**Исторический блокер регистрации TZ-705 снят в файловой части.** Вновь прочитан `ToDo/tz/`: **все пять** `TZ-701-replay-provenance.md`, `TZ-702-manual-hook-metrics.md`, `TZ-703-end-to-end-fixtures.md`, `TZ-704-desktop-ui-boundary.md`, `TZ-705-clean-start-release-docs.md` реально размещены в опубликованном каталоге; `ToDo/tz-drafts/` пуст. Состав и YAML-границы проверены чтением: независимые owns без `intent/`, `ToDo/tz-drafts/` или пересечений; зависимости TZ-701/TZ-702 → TZ-703 → TZ-704 → TZ-705 и исполнимые acceptance-команды. Контрольная `py -3 .intent/check.py executable_plan` выполнена W4025 из корня → **rc=0**. Стадийный checker сам по себе проверяет существование хотя бы одной зарегистрированной ТЗ; наличие всех пяти проверено отдельно. `fleet_list` показывает активную fix:TZ-701:2, ожидание TZ-703 от TZ-701 и TZ-704 от TZ-703 — это подтверждение работы графа задач, **но не аттестация выполнения всех пяти заданий**. Запрос `fleet.cmd result` по голому ID проекта вернул «задача не найдена», поэтому полную синхронизацию всех пяти task-ID отдельным этим вызовом **не доказали**; не приписывать ему rc=0 или готовность релиза.

У `TZ-705` зарегистрированное YAML acceptance — `npm run typecheck` + `npm test` (без усечения suite); **отдельный обязательный release gate** `claude plugin validate .claude-plugin/plugin.json` с `rc=0` сохранён внутри ТЗ и в пункте 3 плана, но не выполнялся в этой стадии. Отсутствие его независимо сохранённого receipt означает **release BLOCKED**, не недостаток содержания executable_plan. Самостоятельно не публиковать plugin, не открывать секреты, не менять cache или рабочие процессы. Исходные `TZ-701` и `TZ-702` ещё проходят отдельные fix/review, поэтому их implementation gates и полная постфиксовая `intent/scenarios.py` здесь **не заявляются зелёными**. Эта стадия подтверждает план и размещение ТЗ, а не фактический итог починки или установленную сборку.
