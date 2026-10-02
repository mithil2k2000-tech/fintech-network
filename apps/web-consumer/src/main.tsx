import React from "react";
import ReactDOM from "react-dom/client";
import "@fintech-network/design-system/styles.css";
import { App } from "./App";
import { brand } from "./config/brand";

document.title = brand.name;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
