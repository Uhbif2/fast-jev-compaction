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
