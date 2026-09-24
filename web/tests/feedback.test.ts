import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CaptureResult } from 'posthog-js';
import {
  createFeedbackSender,
  feedbackAvailable,
  feedbackPayload,
  type FeedbackConfig,
  type FeedbackDraft
} from '../src/lib/telemetry/feedback.ts';
import { createLocalDiagnostics } from '../src/lib/telemetry/local-diagnostics.ts';

const config: FeedbackConfig = {
  enabled: true,
  key: 'phc_test',
  host: 'https://us.i.posthog.com',
  release: 'a'.repeat(40),
  environment: 'test',
  surveyId: '00000000-0000-4000-8000-000000000001',
  categoryId: '00000000-0000-4000-8000-000000000002',
  messageId: '00000000-0000-4000-8000-000000000003',
  emailId: '00000000-0000-4000-8000-000000000004'
};
const draft: FeedbackDraft = {
  category: 'feedback',
  message: 'Useful idea',
  email: '',
  includeDiagnostics: false
};

test('feedback requires complete configuration and valid explicit fields', () => {
  assert.equal(feedbackAvailable(config), true);
  for (const patch of [
    { enabled: false },
    { key: '' },
    { surveyId: '' },
    { emailId: config.messageId },
    { host: 'https://other.invalid' }
  ])
    assert.equal(feedbackAvailable({ ...config, ...patch }), false);
  for (const patch of [
    { message: '  ' },
    { message: 'x'.repeat(5001) },
    { email: 'invalid' },
    { category: 'other' }
  ])
    assert.throws(() => feedbackPayload(config, { ...draft, ...patch } as FeedbackDraft));
  assert.doesNotThrow(() => feedbackPayload(config, { ...draft, message: 'x'.repeat(5000) }));
});

test('response maps question IDs, omits blank email, and uses independent anonymous identities', () => {
  const first = feedbackPayload(config, draft);
  const second = feedbackPayload(config, {
    ...draft,
    category: 'bug',
    email: ' test@example.com '
  });
  assert.equal(first.event, 'survey sent');
  assert.equal(first.properties[`$survey_response_${config.categoryId}`], 'Give feedback');
  assert.equal(first.properties[`$survey_response_${config.messageId}`], draft.message);
  assert.equal(`$survey_response_${config.emailId}` in first.properties, false);
  assert.equal(second.properties[`$survey_response_${config.emailId}`], 'test@example.com');
  assert.equal(second.properties[`$survey_response_${config.categoryId}`], 'Report a bug');
  assert.equal(first.properties.$survey_completed, true);
  assert.equal(first.properties.$process_person_profile, false);
  assert.equal(first.properties.$is_identified, false);
  assert.equal(first.properties.environment, 'test');
  assert.notEqual(first.properties.distinct_id, second.properties.distinct_id);
  for (const key of ['$device_id', '$session_id', '$current_url', '$set'])
    assert.equal(key in first.properties, false);
});

test('only explicit sends transmit, overlapping sends are rejected, failures never retry', async () => {
  let calls = 0;
  let finish!: () => void;
  const sender = createFeedbackSender(
    async () => {
      calls++;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    () => {
      throw new Error('Unexpected diagnostics');
    }
  );
  assert.equal(calls, 0);
  const pending = sender(config, draft);
  assert.equal(await sender(config, draft), 'busy');
  assert.equal(calls, 1);
  finish();
  assert.equal(await pending, 'sent');
  const failing = createFeedbackSender(
    async () => {
      calls++;
      throw new Error('Network lost');
    },
    () => undefined
  );
  assert.equal(await failing(config, draft), 'uncertain');
  assert.equal(calls, 2);
  assert.equal(draft.message, 'Useful idea');
});

test('diagnostics attach only by choice and are consumed before a competing toast send', async () => {
  let toastCalls = 0;
  const diagnostics = createLocalDiagnostics({
    origin: 'https://tracker.example',
    storage: { getItem: () => null, setItem: () => {} },
    send: async () => {
      toastCalls++;
    }
  });
  diagnostics.configure({ available: true, key: config.key, release: config.release });
  const error = new TypeError('SECRET_MESSAGE');
  error.stack =
    'TypeError: SECRET_MESSAGE\n    at secretFunction (https://tracker.example/_app/immutable/chunks/test.js?SECRET_QUERY:2:3)';
  diagnostics.pageview('/history?SECRET_ACCOUNT');
  diagnostics.report(error);
  const payloads: CaptureResult[] = [];
  const sender = createFeedbackSender(
    async (payload) => {
      payloads.push(payload);
      await diagnostics.sendReport();
    },
    () => diagnostics.takeForFeedback()
  );
  await sender(config, { ...draft, category: 'bug' });
  // The first send deliberately invokes the toast; omitted checkbox did not consume it.
  assert.equal(payloads[0].properties.technical_diagnostics, undefined);
  assert.equal(toastCalls, 1);
  diagnostics.restorePrompts();
  diagnostics.report(error);
  await sender(config, { ...draft, category: 'bug', includeDiagnostics: true });
  assert.equal(toastCalls, 1);
  assert.equal(diagnostics.state.pending, false);
  assert.ok(payloads[1].properties.technical_diagnostics.$exception_list);
  assert.equal(JSON.stringify(payloads[1]).includes('SECRET'), false);
  await assert.rejects(
    sender(config, { ...draft, category: 'bug', includeDiagnostics: true }),
    /no longer available/
  );
  assert.equal(payloads.length, 2);
});
