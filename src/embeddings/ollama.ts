import type { EmbeddingProvider } from './types.js';

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  dimensions: number;
  readonly maxTokens: number;
  private readonly host: string;
  private readonly timeoutMs: number;
  private dimensionsDetected = false;

  constructor(
    host: string = 'http://localhost:11434',
    model: string = 'nomic-embed-text',
    options: { timeoutMs?: number } = {},
  ) {
    this.host = host.replace(/\/$/, '');
    this.name = model;
    // Default — will be overwritten on first embed or isAvailable probe
    this.dimensions = 768;
    this.maxTokens = 8192;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.host}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return false;
      const data = await res.json() as { models?: Array<{ name: string }> };
      const hasModel = data.models?.some(m => m.name.startsWith(this.name)) ?? false;
      if (!hasModel) return false;

      // Probe dimensions with a test embed
      if (!this.dimensionsDetected) {
        const probe = await this.embed('dimension probe');
        this.dimensions = probe.length;
        this.dimensionsDetected = true;
      }
      return true;
    } catch {
      return false;
    }
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await fetch(`${this.host}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.name, input: text }),
      // A hung Ollama must not block store/search indefinitely.
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama embed failed: ${res.status} ${body}`);
    }

    const data = await res.json() as { embeddings: number[][] };
    const vec = data.embeddings[0];
    if (!vec) throw new Error('Ollama returned empty embeddings');

    // Update dimensions on first call if different
    const arr = new Float32Array(vec);

    // L2 normalize
    let norm = 0;
    for (let i = 0; i < arr.length; i++) norm += arr[i]! * arr[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;

    return arr;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    // Ollama /api/embed supports batch input. Batches embed more tokens, so
    // give them double the single-embed budget.
    const res = await fetch(`${this.host}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.name, input: texts }),
      signal: AbortSignal.timeout(this.timeoutMs * 2),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama embedBatch failed: ${res.status} ${body}`);
    }

    const data = await res.json() as { embeddings: number[][] };
    return data.embeddings.map(vec => {
      const arr = new Float32Array(vec);
      let norm = 0;
      for (let i = 0; i < arr.length; i++) norm += arr[i]! * arr[i]!;
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
      return arr;
    });
  }
}
