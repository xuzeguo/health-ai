import { z } from 'zod';

export const Extraction = z.object({
  date: z.iso.date(),
  weightKg: z.number().positive(),
  bodyFatRate: z.number().min(0).max(100).nullable(),
}).strict();

export function validateTool(name: string, argumentsJson: string) {
  if (name !== 'get_latest_measurement') throw new Error('TOOL_NOT_FOUND');
  return z.object({}).strict().parse(JSON.parse(argumentsJson));
}

interface ToolChunk { index: number; id?: string; function?: { name?: string; arguments?: string } }
export class ToolAccumulator {
  private calls = new Map<number, { id: string; name: string; arguments: string }>();
  private ended = false;
  private bytes = 0;
  constructor(private readonly maxBytes = 16 * 1024) {}
  push(chunk: ToolChunk) {
    if (this.ended || !Number.isInteger(chunk.index) || chunk.index < 0 || chunk.index > 2) throw new Error('TOOL_PROTOCOL');
    const call = this.calls.get(chunk.index) ?? { id: '', name: '', arguments: '' };
    if (chunk.id) {
      if (call.id && call.id !== chunk.id) throw new Error('TOOL_ID_CHANGED');
      call.id = chunk.id;
    }
    if (chunk.function?.name) {
      if (call.name && call.name !== chunk.function.name) throw new Error('TOOL_NAME_CHANGED');
      call.name = chunk.function.name;
    }
    const part = chunk.function?.arguments ?? '';
    this.bytes += Buffer.byteLength(part);
    if (this.bytes > this.maxBytes) throw new Error('TOOL_ARGUMENT_LIMIT');
    call.arguments += part;
    this.calls.set(chunk.index, call);
  }
  finish(reason: string | null) {
    if (this.ended || reason !== 'tool_calls') throw new Error('TOOL_FINISH_INVALID');
    this.ended = true;
  }
  complete() {
    if (!this.ended || !this.calls.size) throw new Error('TOOL_INCOMPLETE');
    const result = [...this.calls].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (new Set(result.map(x => x.id)).size !== result.length) throw new Error('TOOL_ID_DUPLICATE');
    for (const call of result) {
      if (!call.id) throw new Error('TOOL_ID_MISSING');
      validateTool(call.name, call.arguments);
    }
    return result;
  }
}

export function safeFailure(error: unknown) {
  const status = typeof error === 'object' && error !== null && 'status' in error
    && typeof error.status === 'number' ? error.status : null;
  const cancelled = error instanceof Error && ['AbortError', 'APIUserAbortError'].includes(error.name);
  return { category: cancelled ? 'cancelled' : status ? 'http_error' : 'experiment_failed', status };
}
