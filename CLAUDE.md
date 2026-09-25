# Travel Expenses app

Personal travel expense PWA (vanilla JS, no build step), hosted on GitHub Pages from `main`. See README.md for features and file layout.

- When a change is finished and validated, put it live on `main` **without asking**. Follow `.claude/skills/ship-to-main/SKILL.md`.
- `npm test` runs the unit tests (Node 20+).
- All UI text goes through `t()` in `js/i18n.js`: English (default), Swedish and German.
- Data stays on the phone. Receipt reading is on-device only (Tesseract in `vendor/tesseract/`); don't add cloud services without asking the user.
