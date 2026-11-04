import { openUrl } from "@tauri-apps/plugin-opener";
import { backdrop } from "./backdrop";
import { toast, toastError } from "./toast";
import { UpdateInfo } from "./api";
import { t, useLang } from "./i18n";
import { skipVersion } from "./updates";

const BREW = "brew update && brew upgrade --cask sniffo";

export function UpdateDialog({ update, onClose }: { update: UpdateInfo; onClose: () => void }) {
  useLang();
  return (
    <div className="modal-back" {...backdrop(onClose)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("update.title", { version: update.version })}</h3>
        <p className="muted">{t("update.current", { current: update.current })}</p>
        {update.notes.trim() && <>
          <h4>{t("update.notes")}</h4>
          <pre className="code update-notes">{update.notes.trim()}</pre>
        </>}
        <h4>{t("update.brew")}</h4>
        <pre className="code">{BREW}</pre>
        <div className="row"><button onClick={() => navigator.clipboard.writeText(BREW).then(() => toast(t("update.copied")), toastError)}>{t("common.copy")}</button></div>
        <div className="row end">
          <button onClick={() => { skipVersion(update.version); onClose(); }}>{t("update.skip")}</button>
          <button onClick={onClose}>{t("common.close")}</button>
          <button className="primary" onClick={() => openUrl(update.url).catch(toastError)}>{t("update.openRelease")}</button>
        </div>
      </div>
    </div>
  );
}
