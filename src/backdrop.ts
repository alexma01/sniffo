import type { MouseEvent } from "react";

/** Props for a dialog's backdrop: it closes only on a click that both starts and ends on the
 *  backdrop, so dragging a textarea's resize handle or a text selection out of the dialog
 *  doesn't close it. */
export function backdrop(onClose: () => void) {
  return {
    onMouseDown: (e: MouseEvent<HTMLElement>) => { e.currentTarget.dataset.downOnBackdrop = String(e.target === e.currentTarget); },
    onClick: (e: MouseEvent<HTMLElement>) => {
      if (e.target === e.currentTarget && e.currentTarget.dataset.downOnBackdrop === "true") onClose();
    },
  };
}
