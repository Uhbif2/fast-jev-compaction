# Integration revalidation · fast-jev-compaction-local / executable_goal

claim_id: 14287 · worker W4027 · 2026-10-15
Historical accept: **544518** — accepted historical result, **not** fabricated new seal.
Reason: `missing_trusted_submission_file_seal`.
Outcome: `intent-aa5941ebc7859fad5e7d4734:executable_goal`.
Scope: current exact owned files, HEAD plus precisely these files, no commit.

## Исходные обязательства и прямое свидетельство

Исходная `.intent/intent.md` требует **(R1)** исправить некорректные видимые цифры, **(R2)** разобраться с повторениями старых сообщений без потери текста и **(R3)** отключить автоматическую компакцию **самого плагина**, оставив manual Jev. На стадии `executable_goal` НЕ требуется исправить живой плагин: нужны измеримая пользовательская цель, 5–15 сценариев, включая негативные/ресурсные/визуальные, и **реально исполняемая функционально красная база** до отдельной реализации. Источники границ — прочитанные `CLAUDE.md`, `CONTEXT.md`, `OPERATIONS.md`. Чужой installed cache, secrets, personal .jsonl и API не открывались.

- `intent/goal.md`: `## Результат`, `## Сценарии`, `## Вне рамок`, R1–R3 и S1–S8. S1 сравнивает приблизительный `visibleTokens` с синтетической `session.usage().context.tokens`, но **не называет mock реальным Desktop**; S2 проверяет повторяемость messages/tool pair/page; S3 высокий `turn.complete` против ручного Jev и запрета fallback; S4–S8 закрывают сохранность, пустой кейс, HTTP error, ресурсные лимиты и чужой UI renderer. Итог: схема и отрицательные исходы проверяемы.
- `intent/scenarios.py`: тест вызывает **реальный** `hooks/fast-jev.ts::register` из существующего TypeScript форка посредством Node+tsx и synthetic harness `$.session`/`$.http`/`$.fs`. Сам сценарий не читает личных данных и не отправляет API. Проверка `--verify-harness` rc=0 сообщает, что реальные обработчики и assertions S1/S2/S3 вызывались; отсутствие Node/tsx помечается `INCONCLUSIVE`, а не ложным RED.
- `intent/understood.md`: по исходному поручению `kind: change`, `target: C:\MCPs\fast-jev-compaction-local`, три отдельные жалобы и ограничения renderer/append-only журнала. Не требуется патчить UI, не сохранив пользовательские сообщения и страницы.
- `intent/candidates/understood/1.md`: независимая оценка токенов/трёх уровней UI–journal–model / auto hook, фактические привязки к `CONTEXT.md`, `hooks/fast-jev.ts` и проверки.
- `intent/candidates/understood/2.md`: независимое различение `pre/postTokens`, `visibleTokens`, `context.tokens`, недопустимости unsafe user-handle removal, manual/no-fallback.
- `intent/candidates/understood/3.md`: дополнительно даёт границу source/installed/active hook `LOCAL_BUILD`; UI-дубли и Desktop saved нельзя объявлять исправленными по одному offline-run.
- `intent/approaches.md`: A (локальный provenance-aware рефакторинг существующего форка), B (sensitive sidecar ledger) и C (замена plugin/built-in summary); A выбран по минимальному риску. Текст содержит историческую spike-сводку, **не** выданную здесь за свежую проверку spike. Он логически согласуется с целями/RED.
- `intent/consensus/approach_selected-gemini.md`: прочитан, `model: gemini`, критика по A/B/C, `approve`; **не новый независимый Gemini receipt** и не прямая проверка модели/прода.
- `intent/plan.md`: независимые TZ-701/702 (replay и manual/hook), TZ-703 integration, TZ-704 UI boundary, TZ-705 release; `needs` и acceptance; этап плана ещё не свидетельство о готовой реализации. Строка 42 содержит **историческую** проблему preflight регистрации; нынешние neighbors TZ-701 и TZ-702 уже `work/taken` — нельзя приравнивать исторический статус к текущему, писать им в owns или ждать их в этой revalidation.
- `ToDo/integration-revalidation/c50ce509bbd4cc4e.md` (настоящий отчёт): матрица, SHA и локальные evidence/ограничения для **нового** независимого ревью. Сервер запечатывает текущие submitted bytes; историческое 544518 не переписывается.

## Текущие SHA-256 файлов зоны

Все хэши получены независимой командой `py -3 -c` через `hashlib.sha256(Path(...).read_bytes())`, rc=0, из канонического корня:

| Путь | Размер (байт) | SHA-256 |
| --- | ---: | --- |
| `intent/approaches.md` | 14441 | `6f658e6d173f16c1645fdfe4374612d421cb5c50f5c722e13f4980ccf711dad8` |
| `intent/candidates/understood/1.md` | 8745 | `321b5b0cb75e45acb7c7b50faea6510a672962603aa864ea2587f50c72c58744` |
| `intent/candidates/understood/2.md` | 10020 | `6259ae7ba2258f1d95968d28d8437384ae37113607c1ce194550375451a84d4a` |
| `intent/candidates/understood/3.md` | 10198 | `c1dfe4c781e783c8d1e6616e8e5e84d1e12585fc5b78229ca8a55ae449ba1666` |
| `intent/consensus/approach_selected-gemini.md` | 362 | `8ee7b09a294410177c3395a1b49e7d61493a8a4a9225e7fec27227bd37cd5f6f` |
| `intent/goal.md` | 12698 | `43864166350f727ce4296d1c2e9b217ad82a03583d7fb80b9e595ac7de801454` |
| `intent/plan.md` | 9994 | `1e21ebe87dc9c8e19adf8246521be9f29c215d26fd36f27d9df8aece825ddd03` |
| `intent/scenarios.py` | 14092 | `367eb530e9005628fb81c2ef7db3843dd0b46eb6b3c8291b3fe2c6c17d6e580b` |
| `intent/understood.md` | 16118 | `68ea208997f4ea5f9b32c5fb1a84c5ab657e435da21e5b7a29aea5bb1c3b87ad` |

**Ограничение:** это локальные хэши момента проверки, не подписанные внешней доверенной стороной. Следующее независимое ревью должно заново проверить exact file bytes, особенно при параллельных claims; собственный отчёт не должен замещать доверенный серверный seal.

## Прогоны нынешнего кандидата и оценка содержимого

```text
cwd: C:\MCPs\fast-jev-compaction-local
py -3 .intent/check.py executable_goal
rc=0
✓ executable_goal

py -3 intent/scenarios.py --verify-harness
rc=0
PASS: real hook executed; S1/S2/S3 behavior coverage observed

py -3 intent/scenarios.py
rc=1 (real functional RED)
S1 PASS: estimated message tokens 4964→187; synthetic first post-compact engine usage=3000 from 12000.
S1 PASS: user data, one tool_use and tool_result, immutable full-page path and no built-in Claude summary.
S2 FAIL: second manual replay repeats skill_listing and instructions two times vs one (both model input and assistant text assertions).
S3 FAIL: high-context turn.complete triggers 1 automatic session.compact vs target 0.
S3 PASS: manual Jev request goes through mock transport, HTTP 400 leads to skip without Claude fallback.

git status --short
rc=0, dirty:
 M tests/replay.test.ts
 M tests/transcript.test.ts
 ?? .intent/
 ?? ToDo/plans/plan-intent-aa5941ebc7859fad5e7d4734-executable_plan-b5fd883970.md
 ?? ToDo/tz-drafts/
 ?? component.json
 ?? intent/
 ?? spikes/
```

Исходная acceptance **rc=0**, RED **rc=1 из функциональных assertions реального хука**, а не из `module not found` / внешней сети / произвольного `exit(1)`. По командам из текущего дерева нет доказательств исправления live Desktop, актуального `LOCAL_BUILD`, согласованной installed version, реальных post-compact токенов или отсутствия UI-only дублей. Значения 12000/3000 — **синтетические**; не использовать их как точную экономию владельца. Статус соседнего работающего TZ-701/702 может измениться; проверка валидна на этот короткий снимок до их изменений, после чего должна быть повторена.

## Вывод для независимого ревью и интеграции

Стадия `executable_goal` **готова для новой независимой публикационной проверки**, не для объявления выполненной доработки. Ни один из девяти исходных файлов этого owns не изменён нами: фактического содержательного дефекта стадии не найдено, потому что её цель — честная исполнимая красная база перед работой TZ-701–705. Для фикса прежних трёх жалоб нужны отдельно принятые TZ-701/702, TZ-703 integration, TZ-704 визуальная/renderer граница, TZ-705 release/rollback, а также позднее model input/effect comparison. **Не claim clean clone / deployed product / owner UI PASS** из dirty дерева; не запускать платный Jev, не менять installed cache/настройки, не коммитить и не включать чужие файлы. Интегратор обязан проверить HEAD + **ровно перечисленные файлы** с серверной новой печатью, не реконструируя историческую 544518.
