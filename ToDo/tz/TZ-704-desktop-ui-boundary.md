```yaml
tz: TZ-704
owns:
  - docs/desktop-ui-boundary.md
  - tests/ui-boundary.test.ts
needs: [TZ-703]
acceptance:
  - npm test -- tests/ui-boundary.test.ts
```

# TZ-704 — граница UI Claude Desktop и модельного replay

## Цель
Изолировать дубли, наблюдаемые в Desktop после двух ручных компактаций: модельный ввод, append-only session journal и то, что отрисовал клиент, — три разные поверхности. Нельзя объявлять визуальный баг исправленным, если model-input тесты зелёные.

## Исполнение
Создать обезличенные synthetic snapshots двух replay и сверку provenance/page references. Если только Desktop UI дублирует старые строки, оформить внешний воспроизводитель с точной версией Claude Desktop/Code, временем, шагами, отдельным actual/expected и неизвестными фактами; не удалять/править историю и не обещать влиять на engine-owned строку saved N. Случаи loading/error/empty/disputed, повторного UI фрагмента, клавиатурного доступа и reduced-motion учесть в таблице ожидаемого поведения — без создания новой UI поверх существующего клиента.

## Приёмка
YAML-команда rc=0, assertions сравнивают разные слои и бракуют ложное "UI fixed" при корректном model input. Отдельная проверка Desktop на реальном клиенте: not_run без разрешенного GUI и чистой обезличенной фикстуры; ревьюер читает пример документа глазами. Личные чаты, страницы и installed cache не модифицировать.

## Зависимости
TZ-703 обеспечивает validated model-input trace, после него отдельно проверяется UI boundary. Документация TZ-705 использует подтверждённую границу.
