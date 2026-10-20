import { createRoot } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createImageLightboxGallery } from "./image-lightbox-gallery.ts";
import type { ImageLightboxItem } from "./image-lightbox.types.ts";

function imageItem(title: string) {
  return { src: `https://example.com/${title}.png`, title, release: vi.fn() };
}

let decode: ReturnType<typeof vi.fn<() => Promise<void>>>;
let controller: ReturnType<typeof createImageLightboxGallery>;
let disposeGallery: () => void;
type Selection = ReturnType<typeof controller.peek>;
function expectSelection(current: ImageLightboxItem, fields: Partial<Omit<Selection, "current">>) {
  expect(controller.peek().current).toBe(current);
  expect(controller.peek()).toMatchObject(fields);
}
beforeEach(() => {
  decode = vi.fn(async () => {});
  vi.stubGlobal(
    "Image",
    class {
      src = "";
      decode = decode;
    },
  );
  controller = createRoot((dispose) => {
    disposeGallery = dispose;
    return createImageLightboxGallery();
  });
});

afterEach(() => {
  disposeGallery();
  vi.unstubAllGlobals();
});

it.each(["upgrade reset", "upgrade evict", "neighbor reset"] as const)(
  "releases late images without replacing newer intent: %s",
  async (action) => {
    const initial = imageItem("preview");
    const late = imageItem("original");
    const replacement = imageItem("replacement");
    const beyond = imageItem("beyond");
    const pending = createDeferred<ImageLightboxItem | null>();
    const load = vi.fn(() => pending.promise);
    const moving = action === "neighbor reset";
    const preview = moving ? initial : { ...initial, loadDisplayImage: load };
    controller.reset(
      {
        index: 0,
        items: [async () => preview, moving ? load : async () => replacement, async () => beyond],
      },
      preview,
    );
    const navigation = moving ? controller.move(1) : undefined;
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    if (moving) {
      expectSelection(initial, { busy: true });
    }
    if (action === "upgrade evict") {
      expect(await controller.move(1)).toBe(true);
      expect(await controller.move(1)).toBe(true);
    } else {
      controller.reset(undefined, replacement);
    }
    pending.resolve(late);
    if (navigation) {
      expect(await navigation).toBe(false);
    }
    await vi.waitFor(() => expect(late.release).toHaveBeenCalledOnce());
    expectSelection(action === "upgrade evict" ? beyond : replacement, {
      busy: false,
      failed: false,
    });
    disposeGallery();
    await Promise.resolve();
    expect(late.release).toHaveBeenCalledOnce();
    expect(initial.release).not.toHaveBeenCalled();
    if (moving) {
      expect(replacement.release).not.toHaveBeenCalled();
    }
  },
);

it.each([false, true])(
  "upgrades the previous image (return while loading=%s)",
  async (returnWhileLoading) => {
    const original = imageItem("original");
    const neighbor = imageItem("neighbor");
    const pending = createDeferred<ImageLightboxItem | null>();
    const load = vi.fn(() => pending.promise);
    const initial = { ...imageItem("preview"), loadDisplayImage: load };
    controller.reset({ index: 0, items: [async () => initial, async () => neighbor] }, initial);
    expect(await controller.move(1)).toBe(true);
    const returning = returnWhileLoading ? controller.move(-1) : undefined;
    pending.resolve(original);
    if (returning) {
      expect(await returning).toBe(true);
    } else {
      await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2));
      expectSelection(neighbor, { index: 1 });
      expect(await controller.move(-1)).toBe(true);
    }
    expect(controller.peek().current).toBe(original);
    expect(load).toHaveBeenCalledOnce();
  },
);

it.each(["fetch", "decode"] as const)(
  "retries display-image %s failures without losing the preview",
  async (failure) => {
    const original = imageItem("original");
    if (failure === "decode") {
      decode.mockRejectedValueOnce(new Error("Image decode failed"));
    }
    const load = vi.fn(async () => {
      if (failure === "fetch") {
        throw new Error("Image unavailable");
      }
      return original;
    });
    const initial = { ...imageItem("preview"), loadDisplayImage: load };
    controller.reset(undefined, initial);
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    if (failure === "decode") {
      await vi.waitFor(() => expect(original.release).toHaveBeenCalledOnce());
    }
    await vi.waitFor(() => expect(controller.peek().upgradeFailed).toBe(true));
    expect(controller.peek().current?.src).toBe(initial.src);
    expect(controller.peek()).toMatchObject({ failed: false, upgrading: false });
    expect(initial.release).not.toHaveBeenCalled();
    const recovered = imageItem("recovered-display");
    load.mockResolvedValueOnce(recovered);
    controller.retryDisplayImage();
    expect(controller.peek().upgrading).toBe(true);
    await vi.waitFor(() => expect(controller.peek().current).toBe(recovered));
    expect(controller.peek().upgradeFailed).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
  },
);

it("retries failed neighbor loads without losing selection", async () => {
  const initial = imageItem("initial");
  const broken = imageItem("broken");
  const recovered = imageItem("recovered");
  const load = vi
    .fn<() => Promise<ImageLightboxItem | null>>()
    .mockResolvedValueOnce(broken)
    .mockRejectedValueOnce(new Error("Image temporarily unavailable"))
    .mockResolvedValue(recovered);
  decode.mockRejectedValueOnce(new Error("Image decode failed"));
  controller.reset({ index: 0, items: [async () => initial, load] }, initial);
  expect(load).not.toHaveBeenCalled();
  expect(await controller.move(1)).toBe(false);
  expect(broken.release).toHaveBeenCalledOnce();
  expectSelection(initial, { failed: true });

  expect(await controller.move(1)).toBe(false);
  expectSelection(initial, { index: 0, failed: true, busy: false });

  expect(await controller.move(1)).toBe(true);
  expectSelection(recovered, { index: 1, failed: false });
  disposeGallery();
  await vi.waitFor(() => expect(recovered.release).toHaveBeenCalledOnce());
  expect(broken.release).toHaveBeenCalledOnce();
  expect(initial.release).not.toHaveBeenCalled();
});

it("loads on selection, reuses neighbors and releases evictions", async () => {
  const images = ["previous", "initial", "next", "beyond", "farthest"].map(imageItem);
  const loads = images.map((item) => vi.fn(async () => item));
  const initial = images[1]!;
  controller.reset({ index: 1, items: loads }, initial);
  await Promise.resolve();
  expect(loads.map((load) => load.mock.calls.length)).toEqual([0, 0, 0, 0, 0]);
  expect(decode).not.toHaveBeenCalled();

  expect(await controller.move(1)).toBe(true);
  expect(controller.peek().current).toBe(images[2]);
  expect(loads[2]).toHaveBeenCalledExactlyOnceWith(true);
  expect([loads[0], loads[3], loads[4]].map((load) => load?.mock.calls.length)).toEqual([0, 0, 0]);
  expect(await controller.move(-1)).toBe(true);
  expect(controller.peek().current?.src).toBe(initial.src);
  expect(await controller.move(1)).toBe(true);
  expect(loads[2]).toHaveBeenCalledOnce();
  expect(await controller.move(1)).toBe(true);
  expect(controller.peek().current).toBe(images[3]);
  expect(loads[3]).toHaveBeenCalledExactlyOnceWith(true);
  expect(loads[4]).not.toHaveBeenCalled();
  expect(initial.release).not.toHaveBeenCalled();

  expect(await controller.move(-1)).toBe(true);
  expect(await controller.move(-1)).toBe(true);
  await Promise.resolve();
  expect(images[3]!.release).toHaveBeenCalledOnce();
  expect(loads[1]).toHaveBeenCalledOnce();
  disposeGallery();
  await Promise.resolve();
  expect(images.map((image) => image.release.mock.calls.length)).toEqual([0, 1, 1, 1, 0]);
});
