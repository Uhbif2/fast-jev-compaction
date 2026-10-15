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
