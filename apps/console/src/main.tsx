import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AuthProvider } from "./auth";
import { initTheme } from "./theme/theme";
import "./styles/tokens.css";
import "./styles/base.css";

initTheme();

const root = document.getElementById("root");
if (!root) throw new Error("缺少 #root");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
