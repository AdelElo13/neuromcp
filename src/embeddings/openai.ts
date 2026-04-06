import type { EmbeddingProvider } from './types.js';

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  readonly maxTokens = 8191;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(
    model: string = 'text-embedding-3-small',
    apiKey?: string,
    baseUrl: string = 'https://api.openai.com/v1',
  ) {
    this.name = model;
    this.dimensions = model.includes('3-large') ? 3072 : 1536;
    this.apiKey = apiKey ?? process.env['OPENAI_API_KEY'] ?? '';
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async embed(text: string): Promise<Float32Array> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.name, input: text }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI embed failed: ${res.status} ${body}`);
    }

    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    const vec = data.data[0]?.embedding;
    if (!vec) throw new Error('OpenAI returned empty embeddings');

    const arr = new Float32Array(vec);
    let norm = 0;
    for (let i = 0; i < arr.length; i++) norm += arr[i]! * arr[i]!;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
    return arr;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.name, input: texts }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI embedBatch failed: ${res.status} ${body}`);
    }

    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data.map(d => {
      const arr = new Float32Array(d.embedding);
      let norm = 0;
      for (let i = 0; i < arr.length; i++) norm += arr[i]! * arr[i]!;
      norm = Math.sqrt(norm);
      if (norm > 0) for (let i = 0; i < arr.length; i++) arr[i] /= norm;
      return arr;
    });
  }
}
