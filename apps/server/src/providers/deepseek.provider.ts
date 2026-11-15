import OpenAI, { type ClientOptions } from 'openai';
import { AppError } from '../common/errors.js';
import type { ChatInput, ModelEvent, ModelProvider } from './model-provider.js';

type DeepSeekRequest = OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
  thinking: { type: 'disabled' };
};

interface ProviderOptions {
  // SDK transport injection allows deterministic, socket-free protocol tests.
  fetch?: ClientOptions['fetch'];
  timeoutMs?: number;
}

export class DeepSeekProvider implements ModelProvider {
  readonly name = 'deepseek';
  private readonly client: OpenAI;

  constructor(config: { apiKey: string; baseURL: string }, options: ProviderOptions = {}) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      organization: null,
      project: null,
      maxRetries: 0,
      timeout: options.timeoutMs ?? 60_000,
      fetch: options.fetch,
      logLevel: 'off',
    });
  }

  async *chatStream(input: ChatInput): AsyncIterable<ModelEvent> {
    let fullContent = '';
    let stopped = false;
    let completed = false;
    let abortStream: (() => void) | undefined;

    try {
      if (input.signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
      const body: DeepSeekRequest = {
        model: input.model,
        messages: input.messages,
        stream: true,
        thinking: { type: 'disabled' },
        max_tokens: 4096,
      };
      const stream = await this.client.chat.completions.create(body, { signal: input.signal });
      abortStream = () => stream.controller.abort();

      for await (const chunk of stream) {
        if (input.signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
        const choice = chunk.choices?.[0];
        if (!choice) continue; // A usage-only chunk contains no choices.
        if (stopped) throw new AppError('UPSTREAM_ERROR');

        const delta = choice.delta as typeof choice.delta & { reasoning_content?: unknown };
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
          yield { type: 'reasoning', delta: delta.reasoning_content };
        }
        if (typeof delta.content === 'string' && delta.content) {
          fullContent += delta.content;
          yield { type: 'content', delta: delta.content };
        }
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          if (choice.finish_reason !== 'stop') throw new AppError('UPSTREAM_ERROR');
          stopped = true;
        }
      }

      // The SDK can treat an aborted transport as EOF. Check the caller signal
      // again so cancelled or truncated streams never become a successful done.
      if (input.signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
      if (!stopped || !fullContent) throw new AppError('UPSTREAM_ERROR');
      completed = true;
      yield { type: 'done', fullContent };
    } catch (error) {
      if (input.signal?.aborted || error instanceof OpenAI.APIUserAbortError) {
        throw new DOMException('Request cancelled', 'AbortError');
      }
      if (error instanceof AppError) throw error;
      if (error instanceof OpenAI.APIConnectionTimeoutError) throw new AppError('UPSTREAM_TIMEOUT');
      if (error instanceof OpenAI.APIError) {
        if (error.status === 401 || error.status === 403) throw new AppError('CONFIG_ERROR');
        if (error.status === 429) throw new AppError('RATE_LIMITED');
        if (error.status === 408 || error.status === 504) throw new AppError('UPSTREAM_TIMEOUT');
      }
      // Never attach raw errors, headers or upstream payloads to a public error.
      throw new AppError('UPSTREAM_ERROR');
    } finally {
      // Consumer early return, failure and cancellation must stop the upstream.
      if (!completed) abortStream?.();
    }
  }
}
