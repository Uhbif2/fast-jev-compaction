```yaml
tz: TZ-702
owns:
  - hooks/fast-jev.ts
  - src/size.ts
  - tests/register.test.ts
  - tests/hook.test.ts
needs: []
acceptance:
  - npm run typecheck
  - npm test -- tests/register.test.ts tests/hook.test.ts
```

# TZ-702 — только ручная компактация и честные метрики

## Цель
Закрыть S1 и S3: turn.complete не вызывает session.compact ни при 30%, ни при 70% или более заполнения; ручной /compact остаётся доступным. Внутреннее built-in summary Claude не включается даже при ошибке Jev. Сохранить DISABLE_AUTO_COMPACT/PreCompact guard, не менять пользовательские настройки вне owns.

## Реализация
Сначала тестовые фикстуры должны краснеть на автосрабатывании, ложной маркировке estimated tokens как measured и на ошибках Jev. Затем изменить только hooks/fast-jev.ts и src/size.ts: раздельно показывать plugin estimate, фактическое first-request input usage после компакции и engine-owned saved N, которым плагин не управляет. Никаких ложных измерений по mock; их пометить synthetic/mock. На нуле eligible calls no-op без Jev, при 429/5xx bounded retry/Retry-After и skip без потери текста. Не удалять user/assistant content, не перезаписывать immutable pages, не делегировать штатному summary.

## Приёмка
Обе YAML-команды rc=0. Проверить содержательные assertions: remote jev calls=0 после turn.complete; один допустимый manual вызов; failure возвращает skip без нового summary; отчет различает estimated и observed usage и не обещает исправить Desktop строку. Никаких реальных ключей, сети, правок конфигов/профиля.

## Передача
TZ-703 скрещивает эти hook contract fixtures с provenance replay TZ-701; TZ-705 читает finalized LOCAL_BUILD из TZ-702, не правя hook.

## Итог (W4037, claim_id 14278; 15.10.2026)

- S1: `turn.complete` больше не инициирует `session.compact` или Jev ни при 30%, ни при 70%/95%; ручной `/compact` по-прежнему проходит через `session.compact` с Jev-only ответом или `{ skip }`, без `next(event)`/Claude summary. Contract fixtures — `tests/register.test.ts`.
- S3: `sizeReport` явно маркирует plugin estimate, last-request usage и pending first-request; после первой post-compact engine usage выводится отдельно с provenance (`observed engine` или `synthetic/mock`). Desktop `saved N` назван engine-owned и неуправляемым плагином. `src/size.ts`, `hooks/fast-jev.ts`, `tests/hook.test.ts`.
- Отказы 429/5xx сохраняют bounded retry/Retry-After и заканчиваются skip без изменений входной сессии и без built-in summary. Нуль eligible — no-op без Jev. При невозможности прочитать список страниц (кроме ENOENT) новые файлы не пишутся; существующие имена учитываются без регистра. Набранный текст владельца и assistant text не удаляются новой логикой.
- Приёмка по коду: `npm run typecheck` rc=0; `npm test -- tests/register.test.ts tests/hook.test.ts` rc=0 (39/39); полный `npx vitest run` rc=0 (104/104 до дополнительного ENOENT-теста). `git diff --check` rc=0. Все обращения к Jev были mock/synthetic; реальных ключей, сети, профиля и настроек не касались.
- Внешний `intent/scenarios.py:105` пока ищет старую формулировку toast (`first request after compaction carried`); W4040 уведомлен, исправление вне owns этой задачи. `LOCAL_BUILD=0.3.0-local.19` оставлен синхронизированным с тремя манифестами; выпуск версии и Desktop runtime здесь не проводились.
- Соседняя TZ-701 параллельно добавила два новых provenance-теста (`tests/transcript.test.ts:104,115`): повторный полный `npx vitest run` после этих изменений rc=1 (105 PASS, 2 FAIL) — `dedupeReplayedHistory` удаляет самостоятельный assistant text. Это дефект `src/transcript.ts` вне owns TZ-702, факты направлены W4013; полный зелёный gate требуется повторить после его исправления.
