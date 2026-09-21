const { createHmac } = require('crypto');
const express = require('express');
const request = require('supertest');

const mockGenerationJobManager = {
  getJob: jest.fn(),
  emitChunk: jest.fn(),
};

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  GenerationJobManager: mockGenerationJobManager,
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    warn: jest.fn(),
  },
}));

const router = require('./meyou');

const app = express();
app.use(express.json());
app.use('/meyou', router);

function token(streamId, generationCreatedAt, secret = 'callback-secret') {
  return createHmac('sha256', secret)
    .update(`${streamId}:${generationCreatedAt}`)
    .digest('base64url');
}

describe('Meyou programmer callback route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.MEYOU_PROGRAMMER_CALLBACK_SECRET = 'callback-secret';
    delete process.env.MEYOU_BRIDGE_SECRET;
  });

  test('rejects invalid bearer tokens without emitting', async () => {
    mockGenerationJobManager.getJob.mockResolvedValue({ createdAt: 123 });

    await request(app)
      .post('/meyou/programmer/callback/stream-1/123')
      .set('Authorization', 'Bearer wrong')
      .send({ type: 'activity', event: { label: 'Running tests' } })
      .expect(401);

    expect(mockGenerationJobManager.emitChunk).not.toHaveBeenCalled();
  });

  test('rejects callbacks for replaced generations', async () => {
    mockGenerationJobManager.getJob.mockResolvedValue({ createdAt: 456 });

    await request(app)
      .post('/meyou/programmer/callback/stream-1/123')
      .set('Authorization', `Bearer ${token('stream-1', 123)}`)
      .send({ type: 'activity', event: { label: 'Running tests' } })
      .expect(409);

    expect(mockGenerationJobManager.emitChunk).not.toHaveBeenCalled();
  });

  test('emits activity chunks fenced to the generation epoch', async () => {
    mockGenerationJobManager.getJob.mockResolvedValue({ createdAt: 123 });
    mockGenerationJobManager.emitChunk.mockResolvedValue();

    await request(app)
      .post('/meyou/programmer/callback/stream-1/123')
      .set('Authorization', `Bearer ${token('stream-1', 123)}`)
      .send({
        type: 'activity',
        event: { step: 3, state: 'working', phase: 'verify', can_continue: false, can_approve: false, label: 'Running tests', detail: 'npm test' },
      })
      .expect(200);

    expect(mockGenerationJobManager.emitChunk).toHaveBeenCalledWith(
      'stream-1',
      expect.objectContaining({
        event: 'on_run_step',
        data: expect.objectContaining({
          id: 'meyou-programmer-3',
          status: 'in_progress',
          stepDetails: expect.objectContaining({
            tool_calls: [
              expect.objectContaining({
                meyou: expect.objectContaining({
                  programmer: true,
                  phase: 'verify',
                  state: 'working',
                  can_continue: false,
                  can_approve: false,
                }),
              }),
            ],
          }),
        }),
      }),
      { durable: true, expectedCreatedAt: 123 },
    );
  });
});
