// Worker process for BAAI bge-small-en-v1.5 (MIT, Xenova int8 ONNX export) on onnxruntime-web (MIT).
// WebAssembly linear memory never shrinks back to the OS inside a live process, so isolation lets the host
// reclaim ~250 MB when embeddings go idle.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_TOKENS = 128;

type Ort = {
  env: { wasm: { numThreads: number; wasmPaths: string } };
  InferenceSession: { create(model: Uint8Array): Promise<Session> };
  Tensor: new (type: "int64", data: BigInt64Array, dims: number[]) => unknown;
};
type Session = {
  inputNames: string[];
  outputNames: string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array; dims: number[] }>>;
};

interface Loaded {
  dir: string;
  ort: Ort;
  session: Session;
  vocab: Map<string, number>;
}

export type EmbedWorkerRequest = { id: number; op: "embed"; dir: string; texts: readonly string[] };
export type EmbedWorkerReply = { id: number; ok: true; value: Float32Array[] } | { id: number; ok: false; error: string };

let loaded: Loaded | null = null;

function wasmPrefix(dir: string): string {
  const url = pathToFileURL(dir).href;
  return url.endsWith("/") ? url : `${url}/`;
}

async function ensureLoaded(dir: string): Promise<Loaded> {
  if (loaded?.dir === dir) return loaded;
  const ort = (await import(pathToFileURL(join(dir, "ort.wasm.min.mjs")).href)) as Ort;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.wasmPaths = wasmPrefix(dir);
  const session = await ort.InferenceSession.create(readFileSync(join(dir, "model_quantized.onnx")));
  const tokenizer = JSON.parse(readFileSync(join(dir, "tokenizer.json"), "utf8")) as { model: { vocab: Record<string, number> } };
  loaded = { dir, ort, session, vocab: new Map(Object.entries(tokenizer.model.vocab)) };
  return loaded;
}

function words(text: string): string[] {
  const folded = text.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/\p{Cc}/gu, " ");
  return folded
    .replace(/([㐀-䶿一-鿿豈-﫿])/g, " $1 ")
    .split(/\s+/)
    .flatMap((word) => word.split(/([\p{P}\p{S}])/u))
    .filter(Boolean);
}

function encode(vocab: Map<string, number>, text: string): number[] {
  const unk = vocab.get("[UNK]")!;
  const ids: number[] = [];
  for (const word of words(text)) {
    if (word.length > 100) {
      ids.push(unk);
      continue;
    }
    const pieces: number[] = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length;
      let piece: number | undefined;
      while (start < end) {
        piece = vocab.get(`${start > 0 ? "##" : ""}${word.slice(start, end)}`);
        if (piece !== undefined) break;
        end -= 1;
      }
      if (piece === undefined) {
        pieces.length = 0;
        pieces.push(unk);
        break;
      }
      pieces.push(piece);
      start = end;
    }
    ids.push(...pieces);
    if (ids.length >= MAX_TOKENS - 2) break;
  }
  return [vocab.get("[CLS]")!, ...ids.slice(0, MAX_TOKENS - 2), vocab.get("[SEP]")!];
}

async function embed(dir: string, texts: readonly string[]): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const model = await ensureLoaded(dir);
  const encoded = texts.map((text) => encode(model.vocab, text));
  const width = Math.max(...encoded.map((ids) => ids.length));
  const size = texts.length * width;
  const ids = new BigInt64Array(size);
  const mask = new BigInt64Array(size);
  encoded.forEach((row, i) => row.forEach((id, j) => {
    ids[i * width + j] = BigInt(id);
    mask[i * width + j] = 1n;
  }));
  const feeds: Record<string, unknown> = {
    input_ids: new model.ort.Tensor("int64", ids, [texts.length, width]),
    attention_mask: new model.ort.Tensor("int64", mask, [texts.length, width]),
  };
  if (model.session.inputNames.includes("token_type_ids")) {
    feeds.token_type_ids = new model.ort.Tensor("int64", new BigInt64Array(size), [texts.length, width]);
  }
  const out = await model.session.run(feeds);
  const hidden = out[model.session.outputNames[0]!]!;
  const dims = hidden.dims[2]!;
  return texts.map((_, i) => {
    const offset = i * width * dims;
    const vector = Float32Array.from(hidden.data.subarray(offset, offset + dims));
    let norm = 0;
    for (const x of vector) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let k = 0; k < vector.length; k++) vector[k]! /= norm;
    return vector;
  });
}

let queue: Promise<void> = Promise.resolve();

process.on("message", (request: EmbedWorkerRequest) => {
  if (!request || request.op !== "embed") return;
  queue = queue.then(async () => {
    try {
      const value = await embed(request.dir, request.texts);
      process.send?.({ id: request.id, ok: true, value } satisfies EmbedWorkerReply);
    } catch (error: unknown) {
      process.send?.({
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      } satisfies EmbedWorkerReply);
    }
  });
});

process.on("disconnect", () => process.exit(0));
