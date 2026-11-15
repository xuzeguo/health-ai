import type { ModelEvent } from '@health-ai/shared';

export type { ModelEvent } from '@health-ai/shared';

export interface ChatInput {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  signal?: AbortSignal;
}

export interface ModelProvider {
  readonly name: string;
  chatStream(input: ChatInput): AsyncIterable<ModelEvent>;
}
