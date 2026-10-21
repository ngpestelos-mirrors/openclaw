/** JSDOM native-popover fixture; browser suites own positioning, timing, and light dismissal. */
export function installPopoverPolyfill(): () => void {
  if (typeof HTMLElement === "undefined" || "showPopover" in HTMLElement.prototype) {
    return () => {};
  }
  const methods = ["popover", "showPopover", "hidePopover", "togglePopover"] as const;
  const descriptors = new Map(
    methods.map((name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]),
  );
  const matchesDescriptor: TypedPropertyDescriptor<Element["matches"]> =
    Object.getOwnPropertyDescriptor(Element.prototype, "matches")!;
  const matches = matchesDescriptor.value!;
  const opened = new WeakMap<Element, CSSStyleDeclaration | undefined>();
  const close = (element: Element) => {
    const style = opened.get(element);
    if (style?.getPropertyValue("display") === "block" && !style.getPropertyPriority("display")) {
      style.removeProperty("display");
    }
    opened.delete(element);
  };
  const toggle = (element: HTMLElement, open: boolean) => {
    const connectedPopover = element.isConnected && element.hasAttribute("popover");
    // Removing a native popover (or its attribute) already closes it.
    if (!open && !connectedPopover) {
      close(element);
      return;
    }
    if (opened.has(element) === open) {
      return;
    }
    if (!connectedPopover) {
      throw new DOMException(
        "Popover must be connected and have a popover attribute",
        "InvalidStateError",
      );
    }
    const oldState = opened.has(element) ? "open" : "closed";
    const newState = open ? "open" : "closed";
    const event = (type: string, cancelable = false) => {
      const result = new Event(type, { cancelable });
      Object.defineProperties(result, {
        oldState: { value: oldState },
        newState: { value: newState },
      });
      return result;
    };
    if (!element.dispatchEvent(event("beforetoggle", open))) {
      return;
    }
    if (open) {
      const style = element.style.getPropertyValue("display") ? undefined : element.style;
      style?.setProperty("display", "block");
      opened.set(element, style);
    } else {
      close(element);
    }
    element.dispatchEvent(event("toggle"));
  };
  Object.defineProperty(Element.prototype, "matches", {
    configurable: true,
    writable: true,
    value(this: Element, selector: string) {
      if (selector === ":popover-open") {
        if (!this.isConnected || !this.hasAttribute("popover")) {
          close(this);
          return false;
        }
        return opened.has(this);
      }
      return matches.call(this, selector);
    },
  });
  const polyfill: Pick<HTMLElement, (typeof methods)[number]> & ThisType<HTMLElement> = {
    get popover() {
      const value = this.getAttribute("popover");
      return value === null || value === "manual" || value === "hint" ? value : "auto";
    },
    set popover(value: string | null) {
      if (value === null) {
        this.removeAttribute("popover");
      } else {
        this.setAttribute("popover", value);
      }
    },
    showPopover() {
      toggle(this, true);
    },
    hidePopover() {
      toggle(this, false);
    },
    togglePopover(options?: boolean | { force?: boolean }) {
      toggle(this, (typeof options === "boolean" ? options : options?.force) ?? !opened.has(this));
      return opened.has(this);
    },
  };
  // Preserve the fixture's non-enumerable properties and read-only toggle method.
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(polyfill))) {
    descriptor.enumerable = false;
    if (name === "togglePopover") {
      descriptor.writable = false;
    }
    Object.defineProperty(HTMLElement.prototype, name, descriptor);
  }
  return () => {
    Object.defineProperty(Element.prototype, "matches", matchesDescriptor);
    for (const name of methods) {
      const descriptor = descriptors.get(name);
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, name, descriptor);
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, name);
      }
    }
  };
}
