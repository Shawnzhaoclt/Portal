import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { App } from "./App";
import { AppMessageDialogProvider } from "./AppMessageDialog";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppMessageDialogProvider>
      <App />
      <Toaster
        closeButton
        expand
        position="top-center"
        richColors
        toastOptions={{
          style: {
            borderRadius: 0,
            fontFamily: "inherit",
          },
        }}
      />
    </AppMessageDialogProvider>
  </StrictMode>,
);
