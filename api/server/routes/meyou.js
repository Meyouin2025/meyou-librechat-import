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
  const phase = String(event.phase || '').slice(0, 40);
  const canContinue = event.can_continue === true;
  const canApprove = event.can_approve === true;
  let status = 'in_progress';
  if (event.state === 'error') {
    status = 'failed';
  } else if (event.state === 'complete') {
    status = 'completed';
  }
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
            meyou: {
              programmer: true,
              phase,
              state: String(event.state || 'working'),
              can_continue: canContinue,
              can_approve: canApprove,
            },
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

router.post('/programmer/control', async (req, res) => {
  const action = String(req.body?.action || '')
    .trim()
    .toLowerCase();
  if (!['continue', 'approve'].includes(action)) {
    return res.status(400).json({ error: 'action must be continue or approve' });
  }

  const secret = (process.env.MEYOU_BRIDGE_SECRET || '').trim();
  if (!secret) {
    return res.status(503).json({ error: 'Meyou bridge is not configured' });
  }

  const userId = String(req.user?.id || req.user?._id || '').trim();
  try {
    const response = await fetch(
      'https://meyou-mc-backend.meyoustudio0.workers.dev/api/programmer/control',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
          ...(userId ? { 'X-User-ID': userId } : {}),
        },
        body: JSON.stringify({ action }),
      },
    );
    const payload = await response.json().catch(() => ({}));
    return res.status(response.status).json(payload);
  } catch (error) {
    logger.warn('[MeyouProgrammerControl] Failed to resume Programmer', error);
    return res.status(502).json({ error: 'Unable to reach Meyou Programmer' });
  }
});

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
