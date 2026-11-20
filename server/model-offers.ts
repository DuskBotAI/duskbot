/** The instance ids that offer `model`, for a refusal a bot can correct itself from. */
export function instancesOffering(instances: ReadonlyArray<{ instanceId: string; models: { default?: string; options: ReadonlyArray<{ id: string }> } }>, model: string): string {
  const ids = instances.filter((instance) => instance.models.default === model || instance.models.options.some((option) => option.id === model)).map((instance) => `"${instance.instanceId}"`);
  return ids.length ? `; "${model}" is offered by instance ${ids.join(", ")}` : `; no instance offers "${model}"`;
}
