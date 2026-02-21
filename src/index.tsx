import * as SDK from "azure-devops-extension-sdk";
import React from "react";
import { createRoot } from "react-dom/client";
import { PRAssistantHub } from "./hub/PRAssistantHub";

async function start() {
  SDK.init();          // Good: initializes the extension environment
  await SDK.ready();   // Good: waits for ADO shell to finish loading

  const root = createRoot(document.getElementById("root")!);
  root.render(<PRAssistantHub />);
}

start();