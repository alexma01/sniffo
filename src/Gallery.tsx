// Dev only: http://localhost:1420/?gallery — every screen of the real app, dark and light side by side,
// on the dev-mock data. Keep SCREENS in step with new dialogs. Design reference:
// https://claude.ai/artifact/LJW28FF4TtSLaaLJYqeeEi
const SCREENS: [string, string][] = [
  ["", "Main window"],
  ["palette", "Command palette"],
  ["console", "Script console"],
  ["settings", "Settings"],
  ["devices", "Devices"],
  ["rules", "Rules"],
  ["compose", "Compose request"],
];

export function Gallery() {
  return (
    <div className="gallery">
      <h1>Sniffo — every screen</h1>
      {SCREENS.map(([open, title]) => (
        <section key={title}>
          <h2>{title}</h2>
          <div className="gallery-row">
            {(["dark", "light"] as const).map((theme) => (
              <figure key={theme}>
                <div className="gallery-frame"><iframe title={`${title} — ${theme}`} src={`/?theme=${theme}${open ? `&open=${open}` : ""}`} /></div>
                <figcaption>{theme}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
