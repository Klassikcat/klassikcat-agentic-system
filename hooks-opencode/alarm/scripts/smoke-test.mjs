import assert from 'node:assert/strict';
import { plugin } from '../index.js';

const calls = [];
const fetchImpl = async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  return { ok: true, status: 200, statusText: 'OK', text: async () => '' };
};

const hooks = await plugin(
  { directory: '/tmp/opencode-hooks-smoke' },
  { enabled: true, botToken: '123:test-token', chatID: '456', fetchImpl },
);

assert.equal(typeof hooks.event, 'function');

// Completed via session.idle: atlas agent, no step events (simple chat)
await hooks.event({ event: { type: 'session.updated', properties: { sessionID: 'ses_idle', info: { id: 'ses_idle', title: 'Idle QA', agent: 'Atlas - Plan Executor' } } } });
await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_idle' } } });

// Duplicate idle right after (post-idle session.updated must NOT reset notified)
await hooks.event({ event: { type: 'session.updated', properties: { sessionID: 'ses_idle', info: { id: 'ses_idle', title: 'Idle QA', agent: 'Atlas - Plan Executor' } } } });
await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_idle' } } });

// Second turn: session.next.prompted resets notified, then idle sends again
await hooks.event({ event: { type: 'session.next.prompted', properties: { sessionID: 'ses_idle' } } });
await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_idle' } } });

// Completed via step.ended: prometheus agent, normal finish
await hooks.event({ event: { type: 'session.updated', properties: { sessionID: 'ses_step', info: { id: 'ses_step', title: 'Step QA', agent: 'Hephaestus' } } } });
await hooks.event({ event: { type: 'session.next.step.started', properties: { sessionID: 'ses_step', agent: 'Prometheus - Plan Builder' } } });
await hooks.event({ event: { type: 'session.next.step.ended', properties: { sessionID: 'ses_step', finish: 'completed' } } });

// Not completed: non-matching agent via session.idle
await hooks.event({ event: { type: 'session.updated', properties: { sessionID: 'ses_skip', info: { id: 'ses_skip', title: 'Skip QA', agent: 'Sisyphus - ultraworker' } } } });
await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_skip' } } });

// Failed: error event
await hooks.event({ event: { type: 'session.updated', properties: { sessionID: 'ses_fail', info: { id: 'ses_fail', title: 'Fail QA', agent: 'hephaestus' } } } });
await hooks.event({ event: { type: 'session.next.step.failed', properties: { sessionID: 'ses_fail', error: { name: 'SmokeFailure', data: { message: 'boom' } } } } });

// Question
await hooks.event({ event: { id: 'que_smoke', type: 'question.asked', properties: { id: 'que_smoke', questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] } } });

assert.equal(calls.length, 5);
assert.match(calls[0].body.text, /OpenCode work completed/);
assert.match(calls[0].body.text, /Atlas - Plan Executor/);
// calls[1] is the second turn (after prompted), NOT the duplicate idle
assert.match(calls[1].body.text, /OpenCode work completed/);
assert.match(calls[1].body.text, /Atlas - Plan Executor/);
assert.match(calls[2].body.text, /OpenCode work completed/);
assert.match(calls[2].body.text, /Prometheus - Plan Builder/);
assert.match(calls[3].body.text, /OpenCode work failed/);
assert.match(calls[3].body.text, /boom/);
assert.match(calls[4].body.text, /OpenCode question waiting/);
assert.match(calls[4].body.text, /Continue\?/);
assert.match(calls[4].body.text, /Yes, No/);

console.log('alarm hook smoke test passed');
