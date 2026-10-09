import type {
  PluginStateBatch,
  PluginStateCompareIntent,
  PluginStateObservation,
} from "openclaw/plugin-sdk/plugin-state-runtime";

export const REEF_STATE_KEEP = { operation: "delete", action: "keep" } as const;

export async function applyReefStateBatch<T>(
  batch: PluginStateBatch,
  rows: { store: number; key: string }[],
  prepare: (values: unknown[]) => { intents: PluginStateCompareIntent<unknown>[]; value: T },
  captured?: PluginStateObservation<unknown>[],
): Promise<T> {
  let observations = captured ?? (await batch.observe(rows));
  for (;;) {
    let prepared: ReturnType<typeof prepare> | undefined;
    let failure: unknown;
    try {
      prepared = prepare(observations.map(({ value }) => value));
    } catch (error) {
      failure = error;
    }
    // Validate refusals too: a repair committed during preparation must be observed.
    const result = await batch.compareAndApply(
      rows.map((row, index) => ({
        ...row,
        comparison: observations[index]!.comparison,
        intent: prepared?.intents[index] ?? REEF_STATE_KEEP,
      })),
    );
    if (result.status === "conflict") {
      observations = result.current;
      continue;
    }
    if (!prepared) {
      throw failure;
    }
    return prepared.value;
  }
}
