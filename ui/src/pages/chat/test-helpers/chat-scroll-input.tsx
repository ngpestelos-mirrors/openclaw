import type { JSX } from "@solidjs/web";
import { vi } from "vitest";

type NativeKeyFixture = {
  platform?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  scrollTop?: number;
};

type NativeKeyCase = readonly [
  name: string,
  key: string,
  content: () => JSX.Element,
  controlOwned: boolean,
  fixture: NativeKeyFixture,
];

const controls = [
  ["input", () => <input value="Several words to edit" />],
  ["textarea", () => <textarea>Several words to edit</textarea>],
  [
    "editable",
    () => (
      <div contenteditable="true">
        <span>Several words to edit</span>
      </div>
    ),
  ],
  [
    "select",
    () => (
      <select>
        <option>First</option>
        <option selected>Second</option>
        <option>Third</option>
      </select>
    ),
  ],
] as const;
const [input, textarea, editable, select] = controls;

const boundaryKeys = ["Home", "End"];
const pageKeys = [...boundaryKeys, "PageUp", "PageDown"];
function keyCases(
  name: string,
  content: () => JSX.Element,
  keys: string[],
  owned: (key: string) => boolean,
  fixture: NativeKeyFixture,
): NativeKeyCase[] {
  return keys.map((key) => [`${name}${key}`, key, content, owned(key), fixture]);
}

export const nativeControlNavigationCases: NativeKeyCase[] = [
  ...(
    [
      ["video", () => <video controls />],
      ["audio", () => <audio controls />],
    ] as const
  ).flatMap(([name, content]) =>
    [
      ...[" ", "ArrowUp", "ArrowDown", ...pageKeys].map((key) => [key, {}] as const),
      ...boundaryKeys.flatMap((key) =>
        [{ shiftKey: true }, { ctrlKey: true }].map((fixture) => [key, fixture] as const),
      ),
    ].map(([key, fixture]): NativeKeyCase => [
      `${name} ${JSON.stringify(fixture)} ${key}`,
      key,
      content,
      !key.startsWith("Page"),
      fixture,
    ]),
  ),
  ...["Win32", "Linux x86_64"].flatMap((platform) =>
    controls.flatMap(([name, content]) =>
      keyCases(
        `${platform} ${name} `,
        content,
        pageKeys,
        (key) => name !== "input" || boundaryKeys.includes(key),
        { platform },
      ),
    ),
  ),
  ...["Win32", "Linux x86_64"].flatMap((platform) =>
    keyCases(`${platform} select Ctrl+`, select[1], boundaryKeys, () => false, {
      platform,
      ctrlKey: true,
    }),
  ),
  ...controls.flatMap(([name, content]) =>
    keyCases(`Mac ${name} Shift+`, content, boundaryKeys, () => true, {
      platform: "MacIntel",
      shiftKey: true,
    }),
  ),
  ...[input, select].flatMap(([name, content]) =>
    keyCases(`Mac ${name} `, content, boundaryKeys, () => false, { platform: "MacIntel" }),
  ),
  ...[textarea, editable].flatMap(([name, content]) =>
    pageKeys.flatMap((key) =>
      [true, false].map((inside): NativeKeyCase => [
        `Mac ${name} ${key} at ${inside ? "inner content" : "inner edge"}`,
        key,
        content,
        inside,
        {
          platform: "MacIntel",
          scrollTop: inside ? 240 : key === "Home" || key === "PageUp" ? 0 : 480,
        },
      ]),
    ),
  ),
];

export function configureNativeKeyTarget(control: Element, fixture: NativeKeyFixture = {}) {
  const platform = fixture.platform
    ? vi.spyOn(navigator, "platform", "get").mockReturnValue(fixture.platform)
    : undefined;
  if (fixture.scrollTop !== undefined) {
    control.setAttribute("style", "overflow-y: auto");
    Object.defineProperties(control, {
      clientHeight: { configurable: true, value: 160 },
      scrollHeight: { configurable: true, value: 640 },
      scrollTop: { configurable: true, writable: true, value: fixture.scrollTop },
    });
  }
  return () => platform?.mockRestore();
}
