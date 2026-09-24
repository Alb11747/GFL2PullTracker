import type { CaptureResult } from 'posthog-js';
import { telemetryEnvironment } from './deployment.ts';

export type FeedbackConfig = {
  enabled: boolean;
  key: string;
  host: string;
  release: string;
  environment: string;
  surveyId: string;
  categoryId: string;
  messageId: string;
  emailId: string;
};
export type FeedbackDraft = {
  category: 'feedback' | 'bug';
  message: string;
  email: string;
  includeDiagnostics: boolean;
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function feedbackAvailable(config: FeedbackConfig) {
  const ids = [config.surveyId, config.categoryId, config.messageId, config.emailId];
  return (
    config.enabled &&
    !!config.key &&
    config.host === 'https://us.i.posthog.com' &&
    ids.every((id) => uuid.test(id)) &&
    new Set(ids).size === ids.length
  );
}

/** Only voluntarily submitted fields enter this payload, never the analytics sanitizer. */
export function feedbackPayload(config: FeedbackConfig, draft: FeedbackDraft): CaptureResult {
  if (!feedbackAvailable(config)) throw new Error('Feedback is unavailable right now.');
  if (!['feedback', 'bug'].includes(draft.category)) throw new Error('Choose a feedback category.');
  const message = draft.message.trim();
  const email = draft.email.trim();
  if (!message || draft.message.length > 5000)
    throw new Error('Enter a message of 1 to 5,000 characters.');
  if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    throw new Error('Enter a valid email address, or leave it blank.');
  const id = crypto.randomUUID();
  return {
    uuid: id,
    event: 'survey sent',
    properties: {
      token: config.key,
      distinct_id: id,
      $is_identified: false,
      $process_person_profile: false,
      $geoip_disable: true,
      $survey_id: config.surveyId,
      $survey_name: 'Tracker feedback',
      $survey_submission_id: id,
      $survey_completed: true,
      $survey_questions: [
        { id: config.categoryId, question: 'Category' },
        { id: config.messageId, question: 'Message' },
        { id: config.emailId, question: 'Email (optional)' }
      ],
      [`$survey_response_${config.categoryId}`]:
        draft.category === 'bug' ? 'Report a bug' : 'Give feedback',
      [`$survey_response_${config.messageId}`]: message,
      ...(email ? { [`$survey_response_${config.emailId}`]: email } : {}),
      service: 'browser',
      environment: telemetryEnvironment(config.environment),
      release: /^[a-f0-9]{40}$/.test(config.release) ? config.release : 'unknown',
      $pathname: '/about',
      report_mode: 'user_submitted'
    }
  };
}

export function createFeedbackSender(
  send: (payload: CaptureResult) => Promise<void>,
  takeDiagnostics: () => CaptureResult | undefined
) {
  let sending = false;
  return async (
    config: FeedbackConfig,
    draft: FeedbackDraft
  ): Promise<'sent' | 'uncertain' | 'busy'> => {
    if (sending) return 'busy';
    const payload = feedbackPayload(config, draft);
    if (draft.category === 'bug' && draft.includeDiagnostics) {
      // Consume synchronously, before the network await, to exclude a competing toast submission.
      const diagnostic = takeDiagnostics();
      if (!diagnostic)
        throw new Error('These diagnostics are no longer available. Review and send again.');
      const p = diagnostic.properties;
      payload.properties.technical_diagnostics = {
        $exception_list: p.$exception_list,
        operation: p.operation,
        $pathname: p.$pathname,
        recent_activity: p.recent_activity
      };
    }
    sending = true;
    try {
      await send(payload);
      return 'sent';
    } catch {
      return 'uncertain';
    } finally {
      sending = false;
    }
  };
}
