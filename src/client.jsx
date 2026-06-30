import React from "react";
import { createRoot } from "react-dom/client";
import ClientPortal from "./ClientPortal.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ClientPortal />
  </React.StrictMode>
);
