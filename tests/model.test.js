const assert = require('node:assert/strict')
const test = require('node:test')
const model = require('../Model.js')

const initial = { state: 'unavailable', policy: 'unknown', access: 'unknown', stale: true }
const enabled = { state: 'enabled', policy: '75-80', access: 'allowed', stale: false }

test('describes threshold and firmware policies', () => {
  assert.equal(model.limitDescription('enabled', '75-80'), 'Starts charging at 75% and stops at 80%')
  assert.equal(model.limitDescription('disabled', 'firmware'), 'Use firmware optimized charging')
})

test('first query failure remains unknown, not disabled or unsupported', () => {
  const result = model.parseLimitStatus('state\tunavailable\npolicy\tunknown\n', initial, 1)
  assert.deepEqual(result, initial)
  assert.equal(model.limitStatusDescription(result), 'Battery protection status unavailable. Retrying…')
})

test('failed refresh retains the last enabled state and marks it stale', () => {
  const result = model.parseLimitStatus('state\tunavailable\npolicy\tunknown\n', enabled, 1)
  assert.deepEqual(result, { ...enabled, access: 'unknown', stale: true })
  assert.equal(model.limitStatusDescription(result), 'Battery protection status unavailable. Last known state: on. Retrying…')
  assert.deepEqual(enabled, { state: 'enabled', policy: '75-80', access: 'allowed', stale: false })
  assert.deepEqual(model.parseLimitStatus('', result, 1), result)
})

test('a stale disabled state is explicitly labelled as last known', () => {
  const result = model.parseLimitStatus('', { state: 'disabled', policy: 'firmware', stale: false }, 1)
  assert.equal(model.limitStatusDescription(result), 'Battery protection status unavailable. Last known state: off. Retrying…')
})

for (const raw of ['', 'garbage', 'state\tenabled\n', 'state\tinvalid\npolicy\tunknown\n']) {
  test('incomplete or invalid output cannot replace a known state: ' + JSON.stringify(raw), () => {
    assert.deepEqual(model.parseLimitStatus(raw, enabled, 0), { ...enabled, access: 'unknown', stale: true })
  })
}

test('a non-zero exit rejects even apparently valid output', () => {
  assert.deepEqual(model.parseLimitStatus('state\tdisabled\npolicy\t75-80\n', enabled, 1), { ...enabled, access: 'unknown', stale: true })
})

test('successful refresh recovers and accepts a changed state and policy', () => {
  const stale = model.parseLimitStatus('', enabled, 1)
  const result = model.parseLimitStatus('state\tdisabled\npolicy\t50-80\naccess\tallowed\n', stale, 0)
  assert.deepEqual(result, { state: 'disabled', policy: '50-80', access: 'allowed', stale: false })
  assert.equal(model.limitStatusDescription(result), 'Start charging at 50% and stop at 80%')
})

test('confirmed unsupported is distinct from a failed query', () => {
  const result = model.parseLimitStatus('state\tunsupported\npolicy\tunknown\n', enabled, 0)
  assert.deepEqual(result, { state: 'unsupported', policy: 'unknown', access: 'unknown', stale: false })
  assert.deepEqual(model.parseLimitStatus('', result, 1), { ...result, stale: true })
})

for (const access of ['allowed', 'challenge', 'denied', 'unknown', '<img src="https://example.invalid/x">']) {
  test('editability does not change the displayed on/off state: ' + access, () => {
    for (const value of ['enabled', 'disabled']) {
      const info = model.parseLimitStatus('state\t' + value + '\npolicy\t50-90\naccess\t' + access + '\n', initial, 0)
      assert.equal(info.state, value)
      assert.equal(info.stale, false)
      assert.equal(model.limitEditable(info), access === 'allowed' || access === 'challenge')
      assert.doesNotMatch(model.limitAccessDescription(info), /<img/)
    }
  })
}

test('permission checks can recover without losing the protection state', () => {
  let info = enabled
  for (const access of ['denied', 'unknown', 'allowed']) {
    info = model.parseLimitStatus('state\tenabled\npolicy\t75-80\naccess\t' + access + '\n', info, 0)
    assert.equal(info.state, 'enabled')
    assert.equal(model.limitEditable(info), access === 'allowed')
  }
  assert.equal(model.limitAccessDescription(info), '')
})

test('missing access never silently enables changes', () => {
  const info = model.parseLimitStatus('state\tenabled\npolicy\t75-80\n', enabled, 0)
  assert.equal(info.state, 'enabled')
  assert.equal(info.access, 'unknown')
  assert.equal(model.limitEditable(info), false)
})

test('stale status blocks changes even after previously allowed permission', () => {
  assert.equal(model.limitEditable({ ...enabled, stale: true }), false)
})

test('unrecognised firmware state is not shown as disabled', () => {
  const info = model.parseLimitStatus('state\tunknown\npolicy\tunknown\naccess\tallowed\n', enabled, 0)
  assert.equal(info.state, 'unknown')
  assert.equal(model.limitStatusDescription(info), 'Protection status unknown')
  assert.equal(model.limitEditable(info), false)
})

test('mixed battery state and different policies do not claim one shared limit', () => {
  const info = model.parseLimitStatus('state\tmixed\npolicy\tmultiple\naccess\tallowed\n', initial, 0)
  assert.equal(model.limitStatusDescription(info), 'Protection is enabled for some batteries')
  assert.equal(model.limitEditable(info), true)
})

test('policy text cannot inject markup into the shared Toggle description', () => {
  const info = model.parseLimitStatus('state\tenabled\npolicy\t<img src="https://example.invalid/x">\naccess\tallowed\n', initial, 0)
  assert.equal(info.stale, true)
  assert.doesNotMatch(model.limitStatusDescription(info), /<img/)
})

test('write failures keep an unknown cause and do not claim that no batteries changed', () => {
  const message = model.limitActionError(6)
  assert.match(message, /UPower could not apply/)
  assert.match(message, /cause is unknown/)
  assert.doesNotMatch(message, /BIOS|password|No changes were made/)
  assert.equal(model.limitActionError(0), '')
})

test('permission and authentication failures have specific explanations', () => {
  assert.match(model.limitActionError(3), /System policy/)
  assert.match(model.limitActionError(4), /Authentication/)
  assert.match(model.limitActionError(5), /Permission/)
})

test('the BIOS password hint is a possible cause and does not claim that no batteries changed', () => {
  const message = model.limitActionError(8)
  assert.match(message, /BIOS administrator password is enabled/)
  assert.match(message, /may be blocking/)
  assert.doesNotMatch(message, /No changes were made|locked|must remove/)
})
