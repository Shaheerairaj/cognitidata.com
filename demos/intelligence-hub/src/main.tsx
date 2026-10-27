import React from "react";
import ReactDOM from "react-dom/client";
import Workbench from "./Workbench";
import { installDemoServer } from "./demo/server";
import "./index.css";
import "./loaders.css";

// No backend: every /api call is answered in the browser from the bundled demo data.
installDemoServer();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Workbench />
  </React.StrictMode>,
);
