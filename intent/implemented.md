# Реализация интенции · offline stage evidence (15.10.2026)

## Версионированный снимок

- Канонический target: `C:\MCPs\fast-jev-compaction-local`; baseline Git HEAD `ec2157bbbee20f977199ad91390871a254347034`, версия плагина `0.3.0-local.19`.
- Рабочее дерево **нечистое** (изменения независимых TZ-701 и TZ-702); это **не тест неизменённого Git HEAD**. Для повторяемости ниже сохранены SHA-256 конкретных байтов исходников, реально проверенных этой стадией:
  - `hooks/fast-jev.ts` — `8a4002732f5da022266bbe1f235ad7a368c3573b96428ff63f7864423b0267a0`
  - `src/transcript.ts` — `44997e5c9aebd1d780909dc63b82000190109c9ed3613d147f7bc9b3ffa1ea98`
  - `src/size.ts` — `a7f08e6cf970f656aa2903b2fadbdd30000acc877b0dbf3a938f079f562c4d52`
  - `intent/scenarios.py` — `b4aecb07166bdbbd56e0246e7986700c8fdae2d10d1d73fba409e93b9db8a221`
  - `.intent/check.py` — `df4d1dbbe5db67c6bff8576e08aad31662124799d12bacc96c84e905df2452a7`

## Независимые команды

1. `py -3 intent/scenarios.py` → `rc=0`: S1 4/4 (оценка сообщений ≈4964→187, synthetic/mock engine input 12000→3000, без Claude summary), S2 10/10 (двойной replay, одна пара tool_use/result, сохранение user/assistant текста и исходной immutable page), S3 3/3 (никакого auto `session.compact`, ручной Jev сохраняется, HTTP 400 → skip). Вызван реальный TypeScript `hooks/fast-jev.ts::register` с обезличенным mock engine, без сети и ключей.
2. `npm run typecheck` → `rc=0` (включая hooks TypeScript).
3. `npx vitest run` → `rc=0`, 8 файлов / 111 тестов.
4. `py -3 .intent/check.py implemented` → `rc=0`, `✓ implemented`. Сервер повторяет именно этот gate независимо при сдаче стадии.

## Расхождения и границы доказательства

- Первый прогон 15.10.2026 дал `rc=1`: на втором S2 manual replay `ReferenceError: text is not defined` во время незавершённой соседней правки TZ-701. После коррекции владельцем соответствующего `src/transcript.ts` повторный прогон на указанном содержимом SHA-256 стал GREEN. Тестовые условия S1/S2/S3 не ослаблялись для этой стадии.
- На синтетическом полигоне доказаны собственные input messages и immutable page, **не** состояние внешнего Claude Desktop renderer. Его «saved N tokens» и UI-only дубли остаются engine-owned; окончательный manual/UI reproducer и чистая установка — отдельные TZ-704/705. Никакого реального API, пользовательской истории, настройки Desktop или установки эта стадия не меняла.
- В силу параллельных edits вывод относится к байтам с указанными SHA-256; для production release нужен отдельный clean Git snapshot, независимый repeat и runtime canary. Отчёт не объявляет релиз доставленным.
