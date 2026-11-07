// Shared by template content keys and the generation protocol.
export function validStudioPresetId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 165 && (
    /^[a-zA-Z0-9_-]+$/.test(value)
    || /^module-source:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    || /^module-source:default-[a-zA-Z0-9_-]+$/.test(value));
}
