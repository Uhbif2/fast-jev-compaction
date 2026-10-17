```yaml
tz: TZ-703
owns:
  - scripts/hook-replay.ts
  - tests/fast-jev-compaction.test.ts
  - tests/reliability.test.ts
needs: [TZ-701, TZ-702]
acceptance:
  - npm run typecheck
  - npm test
  - py -3 intent/scenarios.py
```

# TZ-703 — интеграционный офлайн replay S1–S7

## Цель
На настоящих production hook/transcript/size компонентах, с подменённым Jev HTTP и in-memory immutable pages, доказать отсутствие дублирования model input и отключение автокомпакции при сохранении ручного пути. Ни один expected fixture не возвращать как мок реализации, если проверяемое поведение находится в реальном hook.

## Исполнение
Скрипт scripts/hook-replay.ts запускает подлинный hooks/fast-jev.ts::register, synthetic engine событий turn.complete/session.compact/tool.call и usage. Он выводит только санированные числа и причины. Тесты S1–S7 покрывают два replay, page refs, estimated vs measured mock, ручную компакцию, no-op, недоступный Jev, Retry-After, последовательные requests, 64k/32k ограничения, bounded timeout и отсутствие secret leakage.

## Приёмка
Все три YAML-команды rc=0. В отчёт вывести исходные красные кейсы S2/S3 и их исправленный status с actual trace, а не переписывать intent/scenarios.py, который вне owns. Исключить изменение live sessions, local pages, настроек или installed cache.

## Зависимости
Только после принятия TZ-701 и TZ-702. Окончательный Desktop UI outcome не утверждается — отдельная TZ-704.

## Итог проверки W4061 · claim_id 14470 · 15.10.2026

Сделано в своих зонах: `scripts/hook-replay.ts --synthetic` использует реальный `register` и ручные `session.compact` через deterministic offline Jev, а не expected fixture; не читает пользовательских файлов и ключей, не вызывает сеть. Два последовательных прогона с искусственно повторённым `tool_use_id=t1` и парным result оставляют ровно одну пару, исходные строки пользователя, неизменённую страницу, `builtInCalls=0`, `automaticCalls=0`; post-compact usage помечено `synthetic/mock`. Добавлены три теста `tests/reliability.test.ts` для результата, повторяемости и retry 429/Retry-After/последовательности/отсутствия утечек. Собственный запуск: `npx tsx scripts/hook-replay.ts --synthetic` → rc=0, 7/7 assertions; `npx vitest run tests/reliability.test.ts` → rc=0, 15/15; `npm run typecheck` → rc=0.

**Блокер исходной YAML-приёмки** (источник не подменять): `npm test` → rc=1, 117 passed, 1 fail (`tests/register.test.ts:176`, ожидал единственный текст `a.ts is fine.`, получен 0); `py -3 intent/scenarios.py` → rc=1, 4 FAIL S2 (`skill_listing` и `instructions`: first compaction=1, second replay=3); S1 и S3 PASS. Независимый анализ `src/transcript.ts` показывает обязательный same-source-handle gate, предотвращающий удаление одинакового самостоятельно написанного assistant текста; тест S2 вставляет копии без доказательства общей identity. Не следует ослаблять provenance, удалять чужую прозу по одному равенству строки или переписывать `intent/scenarios.py` ради GREEN. Контрактная коллизия передана уведомлением `m-c1439b6f2b40` в TZ-701. **TZ-703 не может быть сдана как PASS до исправления согласованного контракта и rc=0 всех трёх acceptance.**

## Повторная проверка W4879 · claim_id 16180 · 17.10.2026

Текущее дерево: `npx tsx scripts/hook-replay.ts --synthetic` → rc=0 (7/7); `npm run typecheck` → rc=0; `npm test` → rc=0 (120/120); `py -3 intent/scenarios.py` → rc=1 (S1/S3 PASS, S2: 4 FAIL — `skill_listing`/`instructions` по 1 после первой и по 3 после второй компакции). Прежний FAIL `tests/register.test.ts:176` исправлен соседними изменениями. Синтетический S2 `secondInput` в `intent/scenarios.py:133–137` добавляет копии assistant-текста без идентификатора источника, отличимого от самостоятельно написанного текста; удаление их лишь по равенству строк нарушит инвариант `compactAssistantText=false` и защитные тесты `tests/transcript.test.ts`. Ожидается разрешение provenance-контракта TZ-701 либо правка оракула вне owns; S2 не объявлять PASS.

## Заключительная проверка W4889 · claim_id 16334 · 17.10.2026

Причина прежнего расхождения снята в соседнем коммите `e12eb91` (17.10): повторно вставленные служебные listing/instructions схлопываются по их виду, при этом обычная самостоятельная assistant-проза не должна удаляться по совпадению текста; `intent/scenarios.py` не изменялся в этой задаче. **Фактический trace S2:** прежде `skill_listing` и `instructions` после первой компакции по 1, после второго replay по 3 и четыре FAIL; теперь обе проверки `first compaction: 1; replay: 1`, сохранность текста `first: 1, after: 1`, `toolIds=["t1"]`, `resultIds=["t1"]`, исходная страница неизменна, полный payload доступен по ссылке, все user messages сохранены; S2 PASS. **S3:** `automatic compact calls: 0`, ручной путь `requests: 1`, при HTTP 400 — `skip` без built-in summary (`next calls: 0`), S3 PASS. S1 PASS: наблюдённые `3000` input tokens помечены `[synthetic/mock]`, а оценка сохранённых сообщений — `187`, не подменяют друг друга.

Проверено на текущем общем дереве: `npm run typecheck` → rc=0; `npm test` → rc=0 (8 файлов, 120/120 тестов); `py -3 intent/scenarios.py` → rc=0 (S1/S2/S3 все PASS); дополнительно `npx tsx scripts/hook-replay.ts --synthetic` → rc=0 (7/7 checks, `jevRequests=1`, `pageCount=1`, `builtInCalls=0`, `automaticCalls=0`). Только офлайн фикстуры, реальные ключи, live sessions, настройки и installed cache не затрагивались. Приёмка не утверждает Desktop UI outcome (TZ-704).

## Исправление W4919 · fix:TZ-703 · claim_id 16374 · 17.10.2026

Контрпример независимого ревью W4891 подтвердился на настоящем `hooks/fast-jev.ts::register → session.compact`: два пользовательских хода с assistant-ответами `instructions: Answer to first task` и `instructions: Different answer to second task` приводили к потере первого ответа (новый тест `tests/reliability.test.ts -t "preserves distinct assistant instructions"`: исходный **rc=1**, фактический `textAfter` без `Answer to first task`). Причина — `collapseContextListings` в `src/transcript.ts` принимал совпадение одного префикса за служебное происхождение и удалял предыдущий ответ независимо от границ ходов и содержимого.

Исправлено в собственных зонах: самостоятельные assistant-ответы между разными user turns не удаляются; при отсутствии явного source handle схлопываются только полные идентичные listing payload двух или более разных служебных типов внутри одного пользовательского хода. Одиночный префикс, разные payload и смешанная с обычной прозой реплика сохраняются. Если все копии имеют один непустой source handle, удаление разрешено и для одного listing-типа. Добавлены три regression tests в `tests/reliability.test.ts`: real register/session.compact, сохранение изолированных/изменённых/межходовых ответов, сохранение корректного multi-kind replay. `intent/scenarios.py` не изменялся.

После исправления: фокусный RED→GREEN тест **rc=0**; `npm run typecheck` **rc=0**; `npm test` **rc=0, 123/123**; `py -3 intent/scenarios.py` **rc=0, S1/S2/S3 PASS** (S2 `skill_listing` и `instructions`: 1 после первого compact, 1 после replay); `npx tsx scripts/hook-replay.ts --synthetic` **rc=0, 7/7**, `jevRequests=1`, `pageCount=1`, `builtInCalls=0`, `automaticCalls=0`. Только синтетические in-memory fixtures с подменённым HTTP; никаких live sessions, пользовательских настроек, ключей или cache не трогали.
