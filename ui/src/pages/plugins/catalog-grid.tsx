import type { JSX } from "@solidjs/web";
import {
  defaultRangeExtractor,
  elementScroll,
  observeElementOffset,
  observeElementRect,
  Virtualizer,
  type VirtualItem,
} from "@tanstack/virtual-core";
import { createMemo, createSignal, For, onSettled, type Accessor } from "solid-js";
import type { PluginDiscoveryEntry } from "../../lib/plugins/index.ts";
import { createLayoutMeasurement } from "../../lib/reactive/layout-measurement.ts";

/** Keep one keyed card list while row tracks limit layout to the visible catalog. */
export function PluginCatalogGrid(props: {
  items: readonly PluginDiscoveryEntry[];
  children: (
    plugin: Accessor<PluginDiscoveryEntry>,
    contentRef: (element: HTMLDivElement) => void,
  ) => JSX.Element;
}) {
  let grid!: HTMLDivElement;
  let scroller: HTMLElement | null = null;
  let columns = 4;
  let gap = 12;
  const mounted = new Map<string, HTMLDivElement>();
  const [focused, setFocused] = createSignal<string>();
  const [view, setView] = createSignal<{
    rows: VirtualItem[];
    height: number;
    columns: number;
    gap: number;
    available: boolean;
  }>({ rows: [], height: 0, columns, gap, available: true });
  const windowed = createMemo(() => props.items.length > 60 && view().available);
  const indexes = createMemo(
    () => new Map<VirtualItem["key"], number>(props.items.map((item, index) => [item.id, index])),
  );
  const publish = () => {
    const rows = virtualizer.getVirtualItems();
    const height = virtualizer.getTotalSize();
    setView((previous) =>
      previous.height === height &&
      previous.columns === columns &&
      previous.gap === gap &&
      previous.available === Boolean(scroller) &&
      previous.rows.length === rows.length &&
      previous.rows.every((row, index) => {
        const next = rows[index]!;
        return row.index === next.index && row.start === next.start && row.size === next.size;
      })
        ? previous
        : { rows, height, columns, gap, available: Boolean(scroller) },
    );
  };
  const virtualizer = new Virtualizer<HTMLElement, HTMLDivElement>({
    count: 0,
    enabled: false,
    getScrollElement: () => scroller,
    estimateSize: () => 124,
    observeElementRect,
    observeElementOffset,
    scrollToFn: elementScroll,
    overscan: 2,
    onChange: publish,
  });
  onSettled(() => {
    const { _didMount: mountVirtualizer } = virtualizer;
    return mountVirtualizer();
  });
  const measure = createLayoutMeasurement(
    () => ({ items: props.items, indexes: indexes(), focused: focused(), windowed: windowed() }),
    (next) => {
      if (!next) {
        return undefined;
      }
      const viewport = grid.closest<HTMLElement>(".content");
      const style = getComputedStyle(grid);
      const nextColumns = style.gridTemplateColumns.split(" ").length;
      const nextGap = Number.parseFloat(style.rowGap) || 0;
      const margin = viewport
        ? grid.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top +
          viewport.scrollTop
        : 0;
      const heights = new Map<number, number>();
      // Intrinsic content can shrink even while its card stretches to the row height.
      const firstContent = mounted.values().next().value;
      const cardStyle = firstContent ? getComputedStyle(firstContent.parentElement!) : null;
      const inset = cardStyle
        ? [
            cardStyle.paddingTop,
            cardStyle.paddingBottom,
            cardStyle.borderTopWidth,
            cardStyle.borderBottomWidth,
          ].reduce((sum, value) => sum + Number.parseFloat(value), 0)
        : 0;
      for (const [id, element] of mounted) {
        const index = next.indexes.get(id);
        if (index !== undefined) {
          const row = Math.floor(index / nextColumns);
          heights.set(
            row,
            Math.max(heights.get(row) ?? 0, element.getBoundingClientRect().height + inset),
          );
        }
      }
      const count = Math.ceil(next.items.length / nextColumns);
      const focusedIndex = next.indexes.get(next.focused ?? "");
      // Endpoints admit native Tab from either direction; neighboring tracks
      // let focus keep advancing without taking keyboard ownership.
      const pinned = new Set([0, count - 1]);
      if (focusedIndex !== undefined) {
        const row = Math.floor(focusedIndex / nextColumns);
        for (const index of [row - 1, row, row + 1]) {
          if (index >= 0 && index < count) {
            pinned.add(index);
          }
        }
      }
      return () => {
        scroller = viewport;
        for (const key of virtualizer.itemSizeCache.keys()) {
          if (!next.indexes.has(key)) {
            virtualizer.itemSizeCache.delete(key);
          }
        }
        if (columns !== nextColumns) {
          virtualizer.measure();
        }
        columns = nextColumns;
        gap = nextGap;
        virtualizer.setOptions({
          ...virtualizer.options,
          count,
          getItemKey: (index) => next.items[index * nextColumns]!.id,
          enabled: next.windowed && Boolean(viewport),
          gap,
          scrollMargin: margin,
          rangeExtractor: (range) =>
            [...new Set([...defaultRangeExtractor(range), ...pinned])].toSorted((a, b) => a - b),
        });
        const { _willUpdate: updateVirtualizer } = virtualizer;
        updateVirtualizer();
        for (const [index, height] of heights) {
          if (height > 0) {
            virtualizer.resizeItem(index, height);
          }
        }
        publish();
      };
    },
    {
      targets: () => [grid, ...(scroller ? [scroller] : []), ...mounted.values()],
      fonts: true,
      changeTiming: "sync",
    },
  );
  const rows = createMemo(() => new Map(view().rows.map((row) => [row.index, row])));
  const visible = createMemo(() => {
    if (!windowed()) {
      return props.items;
    }
    // The first layout has not run yet. Do not mount the entire catalog just
    // to discover the viewport; normal grids settle to their measured tracks.
    if (view().rows.length === 0) {
      return [...props.items.slice(0, 16), ...props.items.slice(-4)];
    }
    return view().rows.flatMap((row) =>
      props.items.slice(row.index * view().columns, (row.index + 1) * view().columns),
    );
  });
  function Card(card: { plugin: Accessor<PluginDiscoveryEntry> }) {
    let content!: HTMLDivElement;
    onSettled(() => {
      const id = card.plugin().id;
      mounted.set(id, content);
      measure();
      return () => {
        mounted.delete(id);
        measure();
      };
    });
    const index = () => indexes().get(card.plugin().id)!;
    const position = (): JSX.CSSProperties | undefined => {
      if (!windowed()) {
        return undefined;
      }
      const row = Math.floor(index() / view().columns);
      const column = index() % view().columns;
      const track = rows().get(row);
      return {
        position: "absolute",
        top: `${(track?.start ?? row * (124 + view().gap)) - virtualizer.options.scrollMargin}px`,
        "inset-inline-start": `calc(${column} * (100% + ${view().gap}px) / ${view().columns})`,
        width: `calc((100% - ${(view().columns - 1) * view().gap}px) / ${view().columns})`,
        height: `${track?.size ?? 124}px`,
      };
    };
    return (
      <div
        class="plugin-catalog-window-item"
        role="listitem"
        aria-posinset={index() + 1}
        aria-setsize={props.items.length}
        style={position()}
        onFocusIn={() => setFocused(card.plugin().id)}
      >
        {props.children(card.plugin, (node) => (content = node))}
      </div>
    );
  }
  return (
    <div
      ref={(element) => (grid = element)}
      class="plugin-catalog-grid plugin-catalog-grid--results"
      role="list"
      style={
        windowed()
          ? {
              position: "relative",
              height: `${view().height || Math.ceil(props.items.length / 4) * 136}px`,
            }
          : undefined
      }
    >
      <For each={visible()} keyed={(plugin) => plugin.id}>
        {(plugin) => <Card plugin={plugin} />}
      </For>
    </div>
  );
}
