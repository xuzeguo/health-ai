export const ERROR_CODES = [
  'INVALID_PARAM',
  'CONVERSATION_NOT_FOUND',
  'CONVERSATION_BUSY',
  'CONFIG_ERROR',
  'RATE_LIMITED',
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_ERROR',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_DEFINITIONS = {
  INVALID_PARAM: { status: 400, message: '输入有误，请检查后重试' },
  CONVERSATION_NOT_FOUND: { status: 404, message: '会话不存在或已删除' },
  CONVERSATION_BUSY: { status: 409, message: '当前会话正在生成回答' },
  CONFIG_ERROR: { status: 500, message: '服务配置异常，请联系管理员' },
  RATE_LIMITED: { status: 429, message: '请求过于频繁，请稍后重试' },
  UPSTREAM_TIMEOUT: { status: 504, message: '生成超时，请重试' },
  UPSTREAM_ERROR: { status: 502, message: '模型服务异常，请稍后重试' },
  INTERNAL_ERROR: { status: 500, message: '服务异常，请重试' },
} as const satisfies Record<ErrorCode, { status: number; message: string }>;
