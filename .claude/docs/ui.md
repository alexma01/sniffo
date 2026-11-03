# UI

- React 19 + Vite, no UI framework. Styles in `src/App.css`, icons in `src/icons.tsx`.
- Theme: "Signal", dark + light. `?theme=light|dark` forces one.
- Iterate in a browser: `pnpm dev` → http://localhost:1420 (mock data from `src/dev-mock.ts`).
- Gallery: http://localhost:1420/?gallery shows every screen in both themes. New dialog → add it to `SCREENS` in `src/Gallery.tsx`.
- Design reference lives in `design/canvas/` (committed). When a screen changes, keep it in step.
- The app runs in WebKit on macOS (`pnpm test:e2e` also runs Chromium).
- Strings: never hardcode UI text. `t("key", { var })` / `tn("key", n)` / `rich(t(...))` from `src/i18n.ts`; components call `useLang()` so they re-render on language change. Keys live in `src/locales/parts/*.ts` (en + it, tsc fails if a key is missing). New language → add it to `LANGS` and an `it`-style object in each part. `?lang=it` forces one. e2e runs in `en-US`.
