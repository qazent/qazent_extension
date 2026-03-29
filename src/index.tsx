import * as SDK from "azure-devops-extension-sdk";
import React from "react";
import { createRoot } from "react-dom/client";
import { PRAssistantHub } from "./hub/PRAssistantHub";

async function start() {
  await SDK.init();
  await SDK.ready();

  const root = createRoot(document.getElementById("root")!);
  root.render(<PRAssistantHub />);
}

start();