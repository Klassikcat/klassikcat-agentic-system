import assert from 'node:assert/strict';
import { plugin } from '../index.js';

const calls = [];
const fetchImpl = async (url, init) => {
  calls.push({ url, body: JSON.parse(init.body) });
  return { ok: true, status: 200, statusText: 'OK', text: async () => '' };
};

const hooks = await plugin(
  { directory: '/tmp/opencode-hooks-smoke' },
  { botToken: '123:test-token', chatID: '456', fetchImpl },
);

assert.equal(typeof hooks.event, 'function');

await hooks.event({ event: { type: 'session.updated', properties: { info: { id: 'ses_done', title: 'Done QA', agent: 'hephaestus' } } } });
await hooks.event({ event: { type: 'session.next.step.started', properties: { sessionID: 'ses_done' } } });
await hooks.event({ event: { type: 'session.idle', properties: { sessionID: 'ses_done' } } });

await hooks.event({ event: { type: 'session.updated', properties: { info: { id: 'ses_fail', title: 'Fail QA', agent: 'hephaestus' } } } });
await hooks.event({ event: { type: 'session.next.step.failed', properties: { sessionID: 'ses_fail', error: { name: 'SmokeFailure', data: { message: 'boom' } } } } });

await hooks.event({ event: { id: 'que_smoke', type: 'question.asked', properties: { id: 'que_smoke', questions: [{ question: 'Continue?', options: [{ label: 'Yes' }, { label: 'No' }] }] } } });

assert.equal(calls.length, 3);
assert.equal(calls[0].url, 'https://api.telegram.org/bot123:test-token/sendMessage');
assert.match(calls[0].body.text, /OpenCode work completed/);
assert.match(calls[1].body.text, /OpenCode work failed/);
assert.match(calls[1].body.text, /boom/);
assert.match(calls[2].body.text, /OpenCode question waiting/);
assert.match(calls[2].body.text, /Continue\?/);
assert.match(calls[2].body.text, /Yes, No/);

console.log('alarm hook smoke test passed');
