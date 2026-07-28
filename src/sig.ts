import { Image } from "cross-image";

const RESIZE = 32;
const BLOCK = 8;

export async function dctSignature(
  data: Uint8Array,
): Promise<{ sig: Float64Array; width: number; height: number } | null> {
  try {
    const img = await Image.decode(data);
    const origWidth = img.width;
    const origHeight = img.height;
    img.resize({ width: RESIZE, height: RESIZE });
    const pixels = img.data;

    const grey = new Float64Array(RESIZE * RESIZE);
    for (let y = 0; y < RESIZE; y++) {
      for (let x = 0; x < RESIZE; x++) {
        const idx = (y * RESIZE + x) * 4;
        grey[y * RESIZE + x] =
          0.299 * pixels[idx] + 0.587 * pixels[idx + 1] + 0.114 * pixels[idx + 2];
      }
    }

    const dct = dct2D(grey, RESIZE);

    const sig = new Float64Array(BLOCK * BLOCK - 1);
    let n = 0;
    for (let y = 0; y < BLOCK; y++) {
      for (let x = 0; x < BLOCK; x++) {
        if (x === 0 && y === 0) continue;
        sig[n++] = dct[y * RESIZE + x];
      }
    }

    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < sig.length; i++) {
      sum += sig[i];
      sumSq += sig[i] * sig[i];
    }
    const mean = sum / sig.length;
    const variance = sumSq / sig.length - mean * mean;
    const std = Math.sqrt(Math.max(variance, 1e-10));

    for (let i = 0; i < sig.length; i++) {
      sig[i] = (sig[i] - mean) / std;
    }

    return { sig, width: origWidth, height: origHeight };
  } catch {
    return null;
  }
}

function dct1D(data: Float64Array, offset: number, stride: number, N: number): Float64Array {
  const result = new Float64Array(N);
  const scale0 = Math.sqrt(1 / N);
  const scaleN = Math.sqrt(2 / N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    for (let n = 0; n < N; n++) {
      sum += data[offset + n * stride] * Math.cos((Math.PI / N) * (n + 0.5) * k);
    }
    result[k] = sum * (k === 0 ? scale0 : scaleN);
  }
  return result;
}

function dct2D(matrix: Float64Array, N: number): Float64Array {
  const rows = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    const rowDct = dct1D(matrix, y * N, 1, N);
    for (let x = 0; x < N; x++) {
      rows[y * N + x] = rowDct[x];
    }
  }

  const result = new Float64Array(N * N);
  for (let x = 0; x < N; x++) {
    const colDct = dct1D(rows, x, N, N);
    for (let y = 0; y < N; y++) {
      result[y * N + x] = colDct[y];
    }
  }

  return result;
}

export function cosineDistance(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 1;
  return 1 - dot / denom;
}
