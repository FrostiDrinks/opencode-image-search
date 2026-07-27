import { dctSignature } from "./sig";

const BLOCK = 5;

export const PHASH_BITS = BLOCK * BLOCK - 1;
export const PHASH_THRESHOLD = Math.max(2, Math.floor(PHASH_BITS / 5));

export async function perceptualHash(
  data: Uint8Array,
): Promise<{ hash: bigint; width: number; height: number } | null> {
  const sigResult = await dctSignature(data);
  if (!sigResult) return null;

  const { sig, width, height } = sigResult;

  const coeffs: number[] = [];
  for (let y = 0; y < BLOCK; y++) {
    for (let x = 0; x < BLOCK; x++) {
      const fullIdx = y * 8 + x;
      if (fullIdx === 0) continue;
      coeffs.push(sig[fullIdx - 1]);
    }
  }

  const sorted = [...coeffs].sort((a, b) => a - b);
  const median =
    sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];

  let hash = 0n;
  for (let i = 0; i < coeffs.length; i++) {
    if (coeffs[i] > median) hash |= 1n << BigInt(i);
  }

  return { hash, width, height };
}

export function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let count = 0;
  while (xor > 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}
