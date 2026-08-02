const MAX_CLIENT_METADATA_STRING_LENGTH = 2048;
const MAX_CLIENT_METADATA_ARRAY_LENGTH = 16;
const MAX_CLIENT_METADATA_OBJECT_KEYS = 32;
const MAX_CLIENT_METADATA_DEPTH = 4;

function metadataSizeError(value: unknown, path = 'metadata', depth = 0): string | null {
  if (typeof value === 'string' && value.length > MAX_CLIENT_METADATA_STRING_LENGTH) {
    return `${path} is too long`;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CLIENT_METADATA_ARRAY_LENGTH) return `${path} has too many items`;
    if (depth >= MAX_CLIENT_METADATA_DEPTH) return `${path} is too deeply nested`;
    for (const [index, item] of value.entries()) {
      const error = metadataSizeError(item, `${path}[${index}]`, depth + 1);
      if (error) return error;
    }
    return null;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    if (entries.length > MAX_CLIENT_METADATA_OBJECT_KEYS) return `${path} has too many fields`;
    if (depth >= MAX_CLIENT_METADATA_DEPTH) return `${path} is too deeply nested`;
    for (const [key, item] of entries) {
      const error = metadataSizeError(item, `${path}.${key}`, depth + 1);
      if (error) return error;
    }
  }
  return null;
}

export function validateClientRegistrationMetadata(
  clientMetadata: Record<string, unknown>,
): { code: 'invalid_client_metadata'; description: string } | undefined {
  const error = metadataSizeError(clientMetadata);
  return error ? { code: 'invalid_client_metadata', description: error } : undefined;
}
