import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  dialogSnapshot,
  installMessageDialogHost,
  settleDialog,
  subscribeDialogs,
  type DialogRequest,
  type DialogResult,
} from "./messageDialogService";

function ActiveMessageDialog({ request }: { request: DialogRequest }) {
  const [value, setValue] = useState(request.defaultValue);
  const cancelResult = request.type === "prompt" ? null : false;

  function settle(result: DialogResult) {
    settleDialog(request.id, result);
  }

  function confirm() {
    settle(request.type === "prompt" ? value : true);
  }

  return createPortal(
    <div className="app-message-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && request.type !== "alert") settle(cancelResult);
    }}>
      <section
        className={`app-message-dialog app-message-dialog--${request.kind}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`app-message-dialog-title-${request.id}`}
        aria-describedby={`app-message-dialog-message-${request.id}`}
        onKeyDown={(event) => {
          if (event.key === "Escape" && request.type !== "alert") {
            event.preventDefault();
            settle(cancelResult);
          } else if (event.key === "Enter" && request.type !== "prompt") {
            event.preventDefault();
            confirm();
          }
        }}
      >
        <header><h2 id={`app-message-dialog-title-${request.id}`}>{request.title}</h2></header>
        <div id={`app-message-dialog-message-${request.id}`} className="app-message-dialog__message">{request.message}</div>
        {request.type === "prompt" ? (
          <input
            autoFocus
            value={value}
            placeholder={request.placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                confirm();
              }
            }}
          />
        ) : null}
        <footer>
          {request.type !== "alert" ? <button type="button" onClick={() => settle(cancelResult)}>{request.cancelLabel}</button> : null}
          <button
            type="button"
            className={`app-message-dialog__confirm${request.kind === "danger" ? " app-message-dialog__confirm--danger" : ""}`}
            autoFocus={request.type !== "prompt"}
            onClick={confirm}
          >
            {request.confirmLabel}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

export function AppMessageDialogProvider({ children }: { children: React.ReactNode }) {
  const requests = useSyncExternalStore(subscribeDialogs, dialogSnapshot, dialogSnapshot);
  const active = requests[0];

  useEffect(() => installMessageDialogHost(), []);

  useEffect(() => {
    if (!active) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [active]);

  return <>{children}{active ? <ActiveMessageDialog key={active.id} request={active} /> : null}</>;
}
