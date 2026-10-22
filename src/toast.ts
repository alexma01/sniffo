// App-wide toasts: any screen calls toast(); App renders the latest one.
export type ToastKind = "ok" | "err" | "info";
export interface Toast { id: number; text: string; kind: ToastKind }

const listeners = new Set<(t: Toast) => void>();
let next = 0;

export const toast = (text: string, kind: ToastKind = "ok") => listeners.forEach((l) => l({ id: ++next, text, kind }));
export const toastError = (e: unknown) => toast(String(e), "err");

export function onToast(listener: (t: Toast) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
