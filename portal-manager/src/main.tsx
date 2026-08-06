import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
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
  </StrictMode>,
);
