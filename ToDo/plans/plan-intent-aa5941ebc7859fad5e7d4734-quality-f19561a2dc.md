# Исполнимый план: quality для fast-jev-compaction-local

Дата 15.10.2026; агент W4036; fleet claim_id: 14388.
Исходный outcome: `intent-aa5941ebc7859fad5e7d4734:quality`; владелец в `.intent/intent.md` запросил исправить неправильные числа компактации, повторы старых сообщений и автоматическую компактацию плагина. Критерии собственно исправлений — `CLAUDE.md`, `intent/goal.md`, `intent/plan.md`, синтетический harness и опубликованные TZ-701–705. Этот план — **маршрут к проверяемому quality gate**, а не утверждение о живом Desktop.

## Наблюдаемое состояние

1. В корне `C:\MCPs\fast-jev-compaction-local` команда `py -3 .intent/check.py quality` → **rc=1: «нет intent/lenses.md»**. Это непосредственная причина незакрытого outcome, не общий сбой TypeScript.
2. Независимо выполнены `py -3 .intent/check.py implemented` → **rc=0** и `py -3 intent/scenarios.py` → **rc=0**, сценарии S1–S3. S1 сообщает estimated 4964→187, отдельно **синтетическую/mock** engine usage 12000→3000; S2 подтверждает один tool use/result и сохранённую immutable page после двух компакций; S3 auto `session.compact`=0 при работающем ручном fake-hook и error→skip. Ни одно число не является текущим живым показанием Claude Desktop.
3. `.intent/check.py`, функция `_lenses`, требует `intent/lenses.md` длиной минимум 400 символов и ровно семь содержательных заголовков: `## визуал`, `## пустые и ошибочные состояния`, `## первый запуск`, `## ресурсы`, `## безопасность`, `## документация`, `## восстановление`. Любая строка с открытым P0/P1, совпадающая с `P[01]` и `открыт`, препятствует rc=0. **Нельзя прятать действительные P0/P1**, чтобы зелёнел checker.
4. Уже **взята отдельная соседняя задача** `intent-aa5941ebc7859fad5e7d4734-quality` с owns `intent/lenses.md` и `ToDo/tz-drafts`. Здесь нельзя ни писать её файл, ни дублировать задачу. Рабочее дерево разделяемое и грязное (параллельные TZ-701/702, `intent`, `spikes`); текущий stage rc=0 не подтверждает Git clean-snapshot, installed cache или CI-доставку.

## Следующий исполнимый результат

**Содержательный `intent/lenses.md`** в зоне уже назначенного исполнителя outcome quality, включающий факты, приоритет дефектов, конкретные негативные проверки и маршрут от каждого пробела к существующим TZ-701–705 либо к отдельному новому узкому claim, если чужой owns. Таблица семи обязательных линз:

| Линза | Проверить и записать evidence | Приёмка и действия при дефекте |
| --- | --- | --- |
| **визуал** | Разграничить model-input replay, append-only transcript и Claude Desktop renderer; engine-owned строку `saved N tokens` не объявлять управляемой плагином; фиксировать сравнение `LOCAL_BUILD` в новом Code runtime, если реальный canary вообще разрешён. | Synthetic S2 проверяет только model input. При UI-дублях подготовить обезличенный upstream reproducer через TZ-704, `not_run` без доступного безопасного UI; не переименовывать UNKNOWN в PASS. |
| **пустые и ошибочные состояния** | Empty history, empty tool result, orphan/inflight tool call, идентичный законный assistant text при постороннем повторном tool ID, HTTP 400/timeout Jev, ошибочная цепочка page refs, отсутствующее consent. | Проверять отрицательные tests-first assertions из TZ-701/703; пользовательский/assistant текст не исчезает, незавершённый turn не компактизируется, отказ Jev→skip без Claude summary. Любую потерю user/assistant/page или принудительный summary фиксировать P0/P1 со ссылкой на тест. |
| **первый запуск** | Инструкция `C:\MCPs\fast-jev-compaction-local` → `npm ci` → `npm run typecheck` → `npm test` → `claude plugin validate .claude-plugin/plugin.json` штатной bundled-версией (последний — **отдельный release gate**, не prereq offline stage); потом manifest/build marker и canary. | Нет живой установки без отдельного owner-approved release. При отсутствии bundled validate или нового Code runtime — `not_run/blocked`, не подменять allowlist мягкой проверкой. Задача TZ-705. |
| **ресурсы** | Реальный лимит Jev (64k суммарно/32k state + largest question), sequential calls, fake versus измеренная engine usage, overhead после прошлого compaction, лимит токенов Claude. | Не складывать estimate Jev с engine usage, не сообщать обещанные проценты по synthetic fixture как фактические показатели. Профилировать на обезличенном e2e S1/TZ-702/703, а живую ресурсную цифру объявлять UNKNOWN до трассы. |
| **безопасность** | Не удалять введённый текст пользователя, не писать поверх immutable pages, не читать credentials, не пересылать state/tool result, не запускать вторичный Claude summary и платные обращения для quality-audit. | Проверить отрицательные файлы TZ-701/703, отсутствие live SSH/Jev/network в harness, запрет installed-cache edits. Эффектные действия только с отдельным владельческим разрешением и контрольной точкой. |
| **документация** | Сверить README/OPERATIONS/CONTEXT с version/manifest/LOCAL_BUILD, различение engine saved-N vs S1 estimated/measured, UI-only duplicates, фиксированный clean-start и rollback, запрет старых pins. | Следовать TZ-705; не описывать ещё не принятый выпуск как установленный. Ссылки на доказательства каждой инструкции, а не фраза «всё работает». |
| **восстановление** | Jev error → leave session unchanged/skip; reversible patch/tag pin вместо перезаписи установленного кэша; старый Code runtime после update; исходные append-only JSONL и immutable page должны оставаться читаемыми. | Regression S3 и TZ-705 rollback с сохранением предыдущего pin/tag, новой patch-версии при повторном выпуске, clear indication `not_run` для реальной процедуры. При отсутствии rollback проверить причину, поставить P1 и запретить rollout. |

## Выполнение и проверка (владелец соседнего owns)

1. Прочитать `intent/goal.md`, `intent/implemented.md`, `CLAUDE.md`, `OPERATIONS.md`, `CONTEXT.md`, `intent/scenarios.py`, published `ToDo/tz/TZ-701..705` и фактические тесты в соответствующих owns. Не переносить гипотезы про UI в колонку «измерено».
2. Создать `intent/lenses.md` с семью exact headings и матрицей `linza → сценарий → observed evidence/command+rc → severity P0/P1/P2 или not_run → owner-TZ → проверка повтором → rollback/нужна авторизация`. Для любого настоящего P0/P1 оставлять **открыт** и конкретный `request_note(to='queue',path=exact file)` на соседний owns, если ещё нет взятого фикса; не менять checker ради PASS.
3. Прогнать `py -3 .intent/check.py quality` после записи (цель **rc=0 только при реально закрытых P0/P1**), `py -3 intent/scenarios.py` (**rc=0** на synthetic S1–S3), `npm run typecheck` (**rc=0**), `npm test` (**rc=0**) и `py -3 .intent/check.py implemented` (**rc=0**). Сохранить даты, source digest, реальные stdout и exit codes. Если параллельные рабочие файлы изменились — повторить на стабильном снимке; не цитировать устаревшие хэши `intent/implemented.md` как текущие.
4. Независимый ревьюер проверяет не только 7 заголовков и rc: S2 без потери legal assistant text, user text и immutable pages; S3 отсутствие auto compaction; S1 различение estimated и mock observed; отдельно опознаёт непроверенные UI/runtime/installed claims. **Публиковать/устанавливать нельзя** без bundled plugin validation и санкции владельца.
5. Передать `fleet_submit` текущего stage quality на независимый review с перечнем закрытых и незакрытых severity. Если реальный P0/P1 невозможно убрать внутри owns без владельца/установки — quality должен остаться честно RED или перевести в `escalate`; помечать снятием слова «открыт» для обхода гейта запрещено.

## Связь с исходной интенцией и приоритет

- **Повторы старых сообщений**: TZ-701 S2 синтетический replay, TZ-703 e2e, TZ-704 отдельно UI-only воспроизводитель. Синтетический зелёный вход не доказывает исправление Claude renderer.
- **Неправильные цифры**: TZ-702 separated estimate/first-request engine usage, TZ-703 mock assertions; engine-owned `saved N` не исправляется в плагине, поэтому quality-report обязан это честно сформулировать.
- **Автоматическая компактация**: TZ-702/703 S3 проверяют `turn.complete` не запускает auto `session.compact`, ручной Jev путь остаётся и error fallback безопасен. Настоящий UI/runtime эффект позже подтвердить без вмешательства в чужой профиль.
- **Путь к продукту**: После принятия quality — независимый stage delivery/clean start по TZ-705, с `LOCAL_BUILD`, bundled `claude plugin validate`, canary новой Code-сессии и rollback; все живые шаги не являются частью triage:13.

## Границы triage:13

Текущий W4036 владеет **только** этим файлом плана `ToDo/plans/plan-intent-aa5941ebc7859fad5e7d4734-quality-f19561a2dc.md`. `intent/lenses.md` уже принадлежит отдельному исполнителю; код, конфиги, личные файлы, системные настройки, веб-запросы, plugin cache и чужие TZ не затрагивались. Новое поручение на ту же зону не требуется — следующим материализуемым результатом служит существующая quality-задача.
