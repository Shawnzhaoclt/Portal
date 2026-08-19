export type DialogKind = "default" | "warning" | "danger";
export type DialogType = "alert" | "confirm" | "prompt";

export type DialogOptions = {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  kind?: DialogKind;
  defaultValue?: string;
  placeholder?: string;
};

export type DialogResult = boolean | string | null;

export type DialogRequest = Required<Pick<DialogOptions, "title" | "confirmLabel" | "cancelLabel" | "kind">> & {
  id: number;
  type: DialogType;
  message: string;
  defaultValue: string;
  placeholder: string;
  resolve: (result: DialogResult) => void;
};

let nextDialogId = 1;
let requests: DialogRequest[] = [];
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((listener) => listener());
}

function requestDialog(type: DialogType, message: string, options: DialogOptions = {}) {
  return new Promise<DialogResult>((resolve) => {
    requests = [...requests, {
      id: nextDialogId++,
      type,
      message,
      title: options.title ?? (type === "prompt" ? "Enter information" : type === "alert" ? "Portal Manager message" : "Please confirm"),
      confirmLabel: options.confirmLabel ?? (type === "alert" ? "OK" : "Continue"),
      cancelLabel: options.cancelLabel ?? "Cancel",
      kind: options.kind ?? "default",
      defaultValue: options.defaultValue ?? "",
      placeholder: options.placeholder ?? "",
      resolve,
    }];
    notify();
  });
}

type DialogHostWindow = Window & {
  __portalMessageDialogHost?: (type: DialogType, message: string, options?: DialogOptions) => Promise<DialogResult>;
};

export function installMessageDialogHost() {
  const portalWindow = window as DialogHostWindow;
  const host = (type: DialogType, message: string, options: DialogOptions = {}) => requestDialog(type, message, options);
  portalWindow.__portalMessageDialogHost = host;
  return () => {
    if (portalWindow.__portalMessageDialogHost === host) delete portalWindow.__portalMessageDialogHost;
  };
}

export function dialogSnapshot() {
  return requests;
}

export function subscribeDialogs(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function settleDialog(id: number, result: DialogResult) {
  const completed = requests.find((request) => request.id === id);
  if (!completed) return;
  requests = requests.filter((request) => request.id !== id);
  completed.resolve(result);
  notify();
}

export async function appConfirm(message: string, options: DialogOptions = {}) {
  return (await requestDialog("confirm", message, options)) === true;
}

export async function appPrompt(message: string, options: DialogOptions = {}) {
  const result = await requestDialog("prompt", message, options);
  return typeof result === "string" ? result : null;
}

export async function appAlert(message: string, options: DialogOptions = {}) {
  await requestDialog("alert", message, options);
}
