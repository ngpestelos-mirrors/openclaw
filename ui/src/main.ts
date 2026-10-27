import "./styles.css";
import { unsupportedControlUiBrowser } from "./app/boot-capabilities.ts";
import { prepareApplicationStartup } from "./app/bootstrap-connection.ts";
import { initializeControlUiDocumentHead } from "./app/control-ui-document-head.ts";
import { startEarlyApplicationGateway } from "./app/early-gateway.ts";

if (!unsupportedControlUiBrowser) {
  const initial = prepareApplicationStartup();
  initializeControlUiDocumentHead();
  const early = startEarlyApplicationGateway(initial);
  // Route hints fetch the renderer while the challenge/signature is pending.
  // Start evaluation only after connect is on the wire, so it overlaps the reply.
  void (early ? early.transport.client.initialConnectSent : Promise.resolve())
    .then(() => import("./main.runtime.ts"))
    .then(({ startControlUi }) => startControlUi(initial, early));
}
