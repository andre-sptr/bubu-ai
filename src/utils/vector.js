function isVectorLike(value) {
  return Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView));
}

function cosineSimilarity(a, b) {
  if (!isVectorLike(a) || !isVectorLike(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = Number(a[i]);
    const bv = Number(b[i]);
    if (!Number.isFinite(av) || !Number.isFinite(bv)) return 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

function encodeEmbeddingBlob(vector) {
  if (!isVectorLike(vector) || vector.length === 0) return null;
  const f32 = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    const num = Number(vector[i]);
    if (!Number.isFinite(num)) return null;
    f32[i] = num;
  }
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

function decodeEmbeddingBlob(blob) {
  if (!blob) return null;
  const bytes = Buffer.isBuffer(blob)
    ? blob
    : (ArrayBuffer.isView(blob)
        ? Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength)
        : (blob instanceof ArrayBuffer ? Buffer.from(blob) : null));
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) return null;
  const count = bytes.byteLength / 4;
  if (bytes.byteOffset % 4 === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, count);
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Float32Array(copy.buffer);
}

module.exports = { cosineSimilarity, encodeEmbeddingBlob, decodeEmbeddingBlob };
