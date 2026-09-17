const { createHmac, timingSafeEqual } = require('crypto');
const { Router } = require('express');
const { GenerationJobManager } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');

const router = Router();

function getCallbackSecret() {
  return (
    process.env.MEYOU_PROGRAMMER_CALLBACK_SECRET ||
    process.env.MEYOU_BRIDGE_SECRET ||
    ''
  ).trim();
}

function expectedToken(streamId, generationCreatedAt, secret) {
  return createHmac('sha256', secret)
    .update(`${streamId}:${generationCreatedAt}`)
    .digest('base64url');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function bearerToken(req) {
  const authorization = String(req.get('authorization') || '');
  return authorization.startsWith('Bearer ') ? authorization.slice('Bearer '.length).trim() : '';
}

function activityEvent(payload) {
  const event = payload?.event && typeof payload.event === 'object' ? payload.event : {};
  const step = Number.isSafeInteger(event.step) && event.step >= 0 ? event.step : Date.now();
  const label = String(event.label || 'Meyou Programmer is working').slice(0, 160);
  const detail = String(event.detail || '').slice(0, 300);
  const status =
    event.state === 'error' ? 'failed' : event.state === 'complete' ? 'completed' : 'in_progress';
  const id = `meyou-programmer-${step}`;

  return {
    event: 'on_run_step',
    data: {
      id,
      type: 'tool_calls',
      status,
      index: step,
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [
          {
            id: `${id}-tool`,
            type: 'function',
            name: label,
            args: detail,
          },
        ],
      },
    },
  };
}

function completionEvent(payload) {
  const label = payload?.activity?.current?.label || 'Meyou Programmer finished';
  const detail = payload?.activity?.current?.detail || 'Final response is being delivered';
  const step = Number.isSafeInteger(payload?.activity?.current?.step)
    ? payload.activity.current.step
    : Date.now();
  return activityEvent({
    event: {
      step,
      state: 'complete',
      label,
      detail,
    },
  });
}

router.post('/programmer/callback/:streamId/:generationCreatedAt', async (req, res) => {
  const { streamId } = req.params;
  const generationCreatedAt = Number(req.params.generationCreatedAt);
  const secret = getCallbackSecret();
  if (
    !secret ||
    !streamId ||
    !Number.isSafeInteger(generationCreatedAt) ||
    generationCreatedAt < 0
  ) {
    return res.status(404).json({ error: 'Not found' });
  }

  const supplied = bearerToken(req);
  const expected = expectedToken(streamId, generationCreatedAt, secret);
  if (!supplied || !safeEqual(supplied, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const job = await GenerationJobManager.getJob(streamId);
  if (!job || job.createdAt !== generationCreatedAt) {
    return res.status(409).json({ error: 'Generation is no longer active' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const event = body.type === 'complete' ? completionEvent(body) : activityEvent(body);

  try {
    await GenerationJobManager.emitChunk(streamId, event, {
      durable: true,
      expectedCreatedAt: generationCreatedAt,
    });
    return res.json({ ok: true });
  } catch (error) {
    logger.warn('[MeyouProgrammerCallback] Failed to emit callback event', error);
    return res.status(409).json({ error: 'Generation callback was fenced out' });
  }
});

module.exports = router;
