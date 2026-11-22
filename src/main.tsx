import { createRoot } from "react-dom/client";
import { App } from "./renderer/App";

const container = document.getElementById("root");
if (!container) throw new Error("LibrasLive: elemento #root não encontrado.");

// Sem StrictMode de propósito: efeitos de WebSocket/timer são singletons e
// uma remontagem dupla em dev reiniciaria a fila de animação desnecessariamente.
createRoot(container).render(<App />);
