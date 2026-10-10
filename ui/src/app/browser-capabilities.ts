/** Native overlay and input features required by the Solid cutover. */
export function isControlUiBrowserSupported(): boolean {
  return (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("anchor-name: --a") &&
    typeof HTMLElement !== "undefined" &&
    typeof HTMLElement.prototype.showPopover === "function" &&
    typeof HTMLButtonElement !== "undefined" &&
    "commandForElement" in HTMLButtonElement.prototype &&
    CSS.supports("field-sizing: content")
  );
}
