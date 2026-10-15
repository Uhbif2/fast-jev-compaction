```yaml
tz: TZ-705
owns:
  - package.json
  - .claude-plugin/plugin.json
  - .claude-plugin/marketplace.json
  - README.md
  - OPERATIONS.md
  - CONTEXT.md
needs: [TZ-702, TZ-703, TZ-704]
acceptance:
  - npm run typecheck
  - npm test
```

# TZ-705 — чистый выпуск, воспроизводимая установка и rollback

## Цель
После независимой приёмки TZ-701–704 оформить новую patch-версию fast-jev-compaction-local и инструкцию установки с нуля, не трогая текущий установленный plugin cache или конфиг владельца этой задачей.

## Реализация
Сверить LOCAL_BUILD в уже принятом hooks/fast-jev.ts от TZ-702 с package.json, plugin.json и marketplace.json; без согласованной версии и проверки локальной installed source fingerprint выпуск заблокировать. Указать что engine-owned saved N нельзя изменить плагином, а UI-only duplicates эскалируются. Обновить README/OPERATIONS/CONTEXT пошагово: исходник C:\MCPs\fast-jev-compaction-local, npm ci, проверка, plugin marketplace update, plugin update, новая Code-сессия для загрузки нового build marker, smoke и откат к предыдущему pin/tag. Инструкции не должны включать ключи/персональные данные или отключать защиту built-in compaction.

## Приёмка
Обе YAML-команды rc=0 из корня. `npm test` запускает тот же полный `vitest run` через штатный package.json script, без сокращения проверок. Reviewer проверяет точное соответствие трёх manifest версий с LOCAL_BUILD, пример clean-start на синтетике и корректный rollback, а не наличие файлов. **Обязательный отдельный выпускной gate, вне автоматического preflight:** `claude plugin validate .claude-plugin/plugin.json` подходящей bundled-версией Claude Code, `rc=0`, с сохранённым очищенным свидетельством, до любого publish/plugin update/canary. При отсутствии этого свидетельства status=blocked, release_not_run: автоматическая приёмка typecheck/Vitest не может разрешать выпуск. Не использовать Claude как агента и не запускать живую установку до отдельного owner-authorized rollout. Реальные визуальные/посткомпакционные данные маркировать not_run, если недоступны.

## Зависимости и запреты
TZ-702 поставляет неизменяемый hook marker; TZ-703 e2e; TZ-704 границу UI. Самостоятельно не менять hooks/fast-jev.ts (чужой owns), ~/.claude, remote, секреты, installed cache и production процессы.

## Итог правки черновика (15.10.2026, W4002, claim_id 14286)

Исходный preflight дал два `acceptance_impossible/unsupported_executable`: `npx vitest run` и `claude plugin validate` в YAML. Первая команда заменена точным эквивалентом полного Vitest suite `npm test` (текущий package.json script=`vitest run`), обязательный `claude plugin validate` сохранён как отдельный блокирующий release gate, поскольку не входит в автоматический allowlist регистрации; отсутствие rc=0 явно запрещает выпуск. Объём автоматических тестов не сокращён, никакой real Claude/конфиг/кэш/production не менялся. Следующий шаг — штатная повторная проверка/публикация черновика контроллером, затем независимое ревью и только позже валидация bundled Claude перед release.
