const MAX_CLIENT_METADATA_STRING_LENGTH = 2048;
const MAX_CLIENT_METADATA_ARRAY_LENGTH = 16;
const MAX_CLIENT_METADATA_OBJECT_KEYS = 32;
const MAX_CLIENT_METADATA_DEPTH = 4;
const MAX_CLIENT_METADATA_BYTES = 16 * 1024;
const MAX_CLIENT_METADATA_NODES = 512;
const MAX_CLIENT_METADATA_KEY_LENGTH = 128;

const metadataTextEncoder = new TextEncoder();

type MetadataSizeBudget = {
  bytes: number;
  nodes: number;
};

function serializedByteLength(value: string): number {
  return metadataTextEncoder.encode(JSON.stringify(value)).byteLength;
}

function scalarSerializedByteLength(value: unknown): number {
  if (typeof value === 'string') return serializedByteLength(value);
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? 0
      : metadataTextEncoder.encode(serialized).byteLength;
  }
  return 0;
}

function totalSizeError(): string {
  return `metadata exceeds the total size limit of ${MAX_CLIENT_METADATA_BYTES} bytes`;
}

function nodeCountError(): string {
  return `metadata has more than ${MAX_CLIENT_METADATA_NODES} nodes`;
}

function addBytes(budget: MetadataSizeBudget, bytes: number): boolean {
  budget.bytes += bytes;
  return budget.bytes <= MAX_CLIENT_METADATA_BYTES;
}

function metadataSizeError(
  value: unknown,
  path = 'metadata',
  depth = 0,
  budget: MetadataSizeBudget = { bytes: 0, nodes: 0 },
): string | null {
  budget.nodes += 1;
  if (budget.nodes > MAX_CLIENT_METADATA_NODES) return nodeCountError();

  if (
    typeof value === 'string' &&
    value.length > MAX_CLIENT_METADATA_STRING_LENGTH
  ) {
    return `${path} is too long`;
  }
  if (!Array.isArray(value) && (value === null || typeof value !== 'object')) {
    return addBytes(budget, scalarSerializedByteLength(value))
      ? null
      : totalSizeError();
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CLIENT_METADATA_ARRAY_LENGTH)
      return `${path} has too many items`;
    if (depth >= MAX_CLIENT_METADATA_DEPTH)
      return `${path} is too deeply nested`;
    if (!addBytes(budget, 1)) return totalSizeError();
    for (const [index, item] of value.entries()) {
      if (index > 0 && !addBytes(budget, 1)) return totalSizeError();
      const error = metadataSizeError(
        item,
        `${path}[${index}]`,
        depth + 1,
        budget,
      );
      if (error) return error;
    }
    return addBytes(budget, 1) ? null : totalSizeError();
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value);
    if (entries.length > MAX_CLIENT_METADATA_OBJECT_KEYS)
      return `${path} has too many fields`;
    if (depth >= MAX_CLIENT_METADATA_DEPTH)
      return `${path} is too deeply nested`;
    if (!addBytes(budget, 1)) return totalSizeError();
    for (const [index, [key, item]] of entries.entries()) {
      if (key.length > MAX_CLIENT_METADATA_KEY_LENGTH)
        return `${path} has a key that is too long`;
      if (index > 0 && !addBytes(budget, 1)) return totalSizeError();
      if (!addBytes(budget, serializedByteLength(key) + 1))
        return totalSizeError();
      const error = metadataSizeError(
        item,
        `${path}.${key}`,
        depth + 1,
        budget,
      );
      if (error) return error;
    }
    if (!addBytes(budget, 1)) return totalSizeError();
  }
  return null;
}

export function validateClientRegistrationMetadata(
  clientMetadata: Record<string, unknown>,
): { code: 'invalid_client_metadata'; description: string } | undefined {
  const error = metadataSizeError(clientMetadata);
  return error
    ? { code: 'invalid_client_metadata', description: error }
    : undefined;
}
