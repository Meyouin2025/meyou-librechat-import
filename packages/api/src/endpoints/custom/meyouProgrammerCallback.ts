import { createHmac } from 'crypto';

const MEYOU_WORKER_HOST_PATTERN = /(^|\.)meyou-mc-backend\.meyoustudio0\.workers\.dev$/i;

function getCallbackSecret(): string {
  return (
    process.env.MEYOU_PROGRAMMER_CALLBACK_SECRET ||
    process.env.MEYOU_BRIDGE_SECRET ||
    ''
  ).trim();
}

function getCallbackBaseURL(req: {
  protocol?: string;
  get?: (name: string) => string | undefined;
}): string {
  const configured = (
    process.env.MEYOU_PROGRAMMER_CALLBACK_BASE_URL ||
    process.env.DOMAIN_SERVER ||
    ''
  ).trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  const host = req.get?.('host');
  if (!host) {
    return '';
  }
  return `${req.protocol || 'http'}://${host}`;
}

function isMeyouWorkerBaseURL(baseURL: unknown): boolean {
  if (typeof baseURL !== 'string' || !baseURL) {
    return false;
  }
  try {
    return MEYOU_WORKER_HOST_PATTERN.test(new URL(baseURL).hostname);
  } catch {
    return false;
  }
}

function signCallback(streamId: string, generationCreatedAt: number, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${streamId}:${generationCreatedAt}`)
    .digest('base64url');
}

export function getMeyouProgrammerCallbackHeaders({
  req,
  baseURL,
}: {
  req?: {
    protocol?: string;
    get?: (name: string) => string | undefined;
    _resumableStreamId?: string;
    _resumableGenerationCreatedAt?: number;
  };
  baseURL?: unknown;
}): Record<string, string> | undefined {
  if (!req || !isMeyouWorkerBaseURL(baseURL)) {
    return undefined;
  }

  const streamId = req._resumableStreamId;
  const generationCreatedAt = req._resumableGenerationCreatedAt;
  if (
    typeof streamId !== 'string' ||
    streamId.length === 0 ||
    !Number.isSafeInteger(generationCreatedAt) ||
    generationCreatedAt < 0
  ) {
    return undefined;
  }

  const secret = getCallbackSecret();
  const base = getCallbackBaseURL(req);
  if (!secret || !base) {
    return undefined;
  }

  return {
    'X-Meyou-Programmer-Callback-Url': `${base}/api/meyou/programmer/callback/${encodeURIComponent(
      streamId,
    )}/${generationCreatedAt}`,
    'X-Meyou-Programmer-Callback-Token': signCallback(streamId, generationCreatedAt, secret),
  };
}
