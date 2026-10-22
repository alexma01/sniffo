# UI

- React 19 + Vite, no UI framework. Styles in `src/App.css`, icons in `src/icons.tsx`.
- Theme: "Signal", dark + light. `?theme=light|dark` forces one.
- Iterate in a browser: `pnpm dev` → http://localhost:1420 (mock data from `src/dev-mock.ts`).
- Gallery: http://localhost:1420/?gallery shows every screen in both themes. New dialog → add it to `SCREENS` in `src/Gallery.tsx`.
- Design reference lives in `design/canvas/` (committed). When a screen changes, keep it in step.
- The app runs in WebKit (macOS, Linux) and WebView2/Chromium (Windows): check both engines (`pnpm test:e2e` runs both).
