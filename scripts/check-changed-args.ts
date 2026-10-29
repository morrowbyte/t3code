export function batchCheckArguments(
  prefix: ReadonlyArray<string>,
  files: ReadonlyArray<string>,
  maxFiles = Number.POSITIVE_INFINITY,
) {
  // Windows limits the complete command line to 32,767 UTF-16 units. Leave
  // room for Node and the CLI path, including conservative quote escaping.
  const limit = 24_000;
  const argumentSize = (value: string) => value.length * 2 + 3;
  const prefixSize = prefix.reduce((size, value) => size + argumentSize(value), 0);
  const batches: Array<Array<string>> = [];
  let batch = [...prefix];
  let size = prefixSize;
  for (const file of files) {
    const fileSize = argumentSize(file);
    if (prefixSize + fileSize > limit) {
      throw new Error(`Check argument exceeds the command-line budget: ${file}`);
    }
    if (size + fileSize > limit || batch.length - prefix.length >= maxFiles) {
      batches.push(batch);
      batch = [...prefix];
      size = prefixSize;
    }
    batch.push(file);
    size += fileSize;
  }
  if (batch.length > prefix.length || batches.length === 0) batches.push(batch);
  return batches;
}
