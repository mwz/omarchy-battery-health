const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test, after } = require('node:test')
const model = require('../Model.js')

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'battery-limit-test-'))
const helperSource = path.resolve(__dirname, '../bin/omarchy-battery-limit')
const helper = path.join(fixture, 'omarchy-battery-limit')
const device = '/org/freedesktop/UPower/devices/battery_BAT0'
const secondDevice = '/org/freedesktop/UPower/devices/battery_BAT1'
const calls = path.join(fixture, 'calls')
const authCalls = path.join(fixture, 'auth-calls')
const sysfs = path.join(fixture, 'sysfs')
const firmware = path.join(fixture, 'firmware-attributes')
after(() => fs.rmSync(fixture, { recursive: true, force: true }))

// Redirect the firmware glob to real fixture directories so enumeration cannot
// depend on this machine's vendor or BIOS password. All other code is unchanged.
fs.writeFileSync(helper, fs.readFileSync(helperSource, 'utf8')
  .replaceAll('/sys/class/firmware-attributes/', firmware + '/'), { mode: 0o755 })

// Every UPower, Polkit and sysfs operation is intercepted. Tests never write
// hardware or ask the user to authenticate.
fs.writeFileSync(path.join(fixture, 'upower'), `#!/bin/bash
[[ $1 == -e ]] || exit 2
[[ $BATTERY_TEST_FAIL_ENUM == 1 ]] && exit 1
printf '%s\n' "$BATTERY_TEST_DEVICES"
`, { mode: 0o755 })
fs.writeFileSync(path.join(fixture, 'busctl'), `#!/bin/bash
if [[ $1 == get-property ]]; then
  if [[ $5 == "$BATTERY_TEST_FAIL_PROPERTY" && ( -z $BATTERY_TEST_FAIL_DEVICE || $3 == "$BATTERY_TEST_FAIL_DEVICE" ) ]]; then
    exit 1
  fi
  if [[ $5 == "$BATTERY_TEST_INVALID_PROPERTY" ]]; then
    printf '%s\n' "$BATTERY_TEST_INVALID_VALUE"
    exit 0
  fi
  case "$5" in
    ChargeThresholdSupported) echo "b $BATTERY_TEST_SUPPORTED" ;;
    ChargeThresholdEnabled)
      if [[ $3 == */battery_BAT1 ]]; then echo "b $BATTERY_TEST_SECOND_ENABLED"
      else echo "b $BATTERY_TEST_ENABLED"; fi ;;
    ChargeThresholdSettingsSupported) echo "u $BATTERY_TEST_SETTINGS" ;;
    ChargeStartThreshold) echo "u 75" ;;
    ChargeEndThreshold) echo "u 80" ;;
    NativePath) printf 's "%s"\\n' "$BATTERY_TEST_NATIVE_PATH" ;;
    *) exit 2 ;;
  esac
elif [[ $1 == call ]]; then
  printf '%s\t%s\n' "$3" "$7" >>"$BATTERY_TEST_CALLS"
  if [[ $BATTERY_TEST_FAIL_WRITE == 1 || $3 == "$BATTERY_TEST_FAIL_WRITE" ]]; then
    printf '%s\\n' 'Call failed: failed on setting charging threshold: Failed to set charge control thresholds' >&2
    exit 1
  fi
else
  exit 2
fi
`, { mode: 0o755 })
fs.writeFileSync(path.join(fixture, 'pkcheck'), `#!/bin/bash
printf '%s\\n' "$*" >>"$BATTERY_TEST_AUTH_CALLS"
[[ $1 == --action-id && $2 == org.freedesktop.UPower.enable-charging-limit && $3 == --process ]] || exit 126
[[ $4 =~ ^[0-9]+,[0-9]+,[0-9]+$ ]] || exit 126
if [[ $5 == --allow-user-interaction ]]; then
  exit "$BATTERY_TEST_AUTH_INTERACTIVE"
fi
[[ $# == 4 ]] || exit 126
exit "$BATTERY_TEST_AUTH"
`, { mode: 0o755 })
fs.writeFileSync(path.join(fixture, 'cat'), `#!/bin/bash
if [[ $1 == /sys/class/power_supply/* ]]; then
  exec /usr/bin/cat "$BATTERY_TEST_SYSFS/\${1#/sys/class/power_supply/}"
fi
exec /usr/bin/cat "$@"
`, { mode: 0o755 })

function run(args = ['status', '--shell'], overrides = {}, attributes = {}, authentication = {}) {
  fs.writeFileSync(calls, '')
  fs.writeFileSync(authCalls, '')
  fs.rmSync(sysfs, { recursive: true, force: true })
  fs.rmSync(firmware, { recursive: true, force: true })
  for (const [name, value] of Object.entries(attributes)) {
    const file = path.join(sysfs, 'BAT0', name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, String(value) + '\n')
  }
  for (const [entry, fields] of Object.entries(authentication)) {
    for (const [name, value] of Object.entries(fields)) {
      const file = path.join(firmware, entry, name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // A directory in place of a field simulates a failed sysfs read.
      if (value === null) fs.mkdirSync(file)
      else fs.writeFileSync(file, String(value) + '\n')
    }
  }
  const result = spawnSync(helper, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: fixture + ':/usr/bin:/bin',
      BATTERY_TEST_CALLS: calls,
      BATTERY_TEST_AUTH_CALLS: authCalls,
      BATTERY_TEST_SYSFS: sysfs,
      BATTERY_TEST_AUTH: '0',
      BATTERY_TEST_AUTH_INTERACTIVE: '0',
      BATTERY_TEST_NATIVE_PATH: 'BAT0',
      BATTERY_TEST_DEVICES: device,
      BATTERY_TEST_SUPPORTED: 'true',
      BATTERY_TEST_SETTINGS: '3',
      BATTERY_TEST_ENABLED: 'true',
      BATTERY_TEST_SECOND_ENABLED: 'true',
      BATTERY_TEST_FAIL_WRITE: '',
      BATTERY_TEST_FAIL_ENUM: '',
      BATTERY_TEST_FAIL_PROPERTY: '',
      BATTERY_TEST_FAIL_DEVICE: '',
      BATTERY_TEST_INVALID_PROPERTY: '',
      BATTERY_TEST_INVALID_VALUE: '',
      ...overrides
    }
  })
  assert.ifError(result.error)
  return { ...result, calls: fs.readFileSync(calls, 'utf8'), authCalls: fs.readFileSync(authCalls, 'utf8') }
}

function expectUnavailable(overrides) {
  const result = run(['status', '--shell'], overrides)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, 'state\tunavailable\npolicy\tunknown\naccess\tunknown\n')
  assert.match(result.stderr, /Battery protection status unavailable/)
  for (const action of ['enable', 'disable']) {
    const actionResult = run([action], overrides)
    assert.equal(actionResult.status, 1)
    assert.equal(actionResult.calls, '', 'must not mutate batteries after an incomplete query')
  }
}

test('reports enabled and disabled without treating false as an error', () => {
  assert.equal(run().stdout, 'state\tenabled\npolicy\t75-80\naccess\tallowed\n')
  const result = run(['status', '--shell'], { BATTERY_TEST_ENABLED: 'false' })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'state\tdisabled\npolicy\t75-80\naccess\tallowed\n')
})

test('confirmed unsupported and empty enumeration remain successful results', () => {
  for (const overrides of [{ BATTERY_TEST_SUPPORTED: 'false' }, { BATTERY_TEST_DEVICES: '' }, { BATTERY_TEST_DEVICES: '/org/freedesktop/UPower/devices/DisplayDevice' }]) {
    const result = run(['status', '--shell'], overrides)
    assert.equal(result.status, 0)
    assert.equal(result.stdout, 'state\tunsupported\npolicy\tunknown\naccess\tunknown\n')
    assert.equal(result.authCalls, '')
    assert.equal(run(['enable'], overrides).calls, '')
  }
})

test('failed enumeration is unavailable and blocks writes', () => {
  expectUnavailable({ BATTERY_TEST_FAIL_ENUM: '1' })
  const result = run(['status'], { BATTERY_TEST_FAIL_ENUM: '1' })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /status unavailable/)
})

for (const property of ['ChargeThresholdSupported', 'ChargeThresholdEnabled', 'ChargeThresholdSettingsSupported', 'ChargeStartThreshold', 'ChargeEndThreshold']) {
  test('failed ' + property + ' query is unavailable and blocks writes', () => {
    expectUnavailable({ BATTERY_TEST_FAIL_PROPERTY: property })
  })
}

for (const value of ['', 'b unknown', 'u 1']) {
  test('invalid boolean property is unavailable: ' + JSON.stringify(value), () => {
    expectUnavailable({ BATTERY_TEST_INVALID_PROPERTY: 'ChargeThresholdEnabled', BATTERY_TEST_INVALID_VALUE: value })
  })
}

test('invalid numeric property is unavailable', () => {
  expectUnavailable({ BATTERY_TEST_INVALID_PROPERTY: 'ChargeEndThreshold', BATTERY_TEST_INVALID_VALUE: 'u invalid' })
})

test('failure on a second battery prevents writes to the first', () => {
  expectUnavailable({ BATTERY_TEST_DEVICES: device + '\n' + secondDevice, BATTERY_TEST_FAIL_DEVICE: secondDevice, BATTERY_TEST_FAIL_PROPERTY: 'ChargeThresholdEnabled' })
})

test('verified status still permits enable and disable for all supported batteries', () => {
  for (const [action, desired] of [['enable', 'true'], ['disable', 'false']]) {
    const result = run([action], { BATTERY_TEST_DEVICES: device + '\n' + secondDevice })
    assert.equal(result.status, 0)
    assert.equal(result.calls, device + '\t' + desired + '\n' + secondDevice + '\t' + desired + '\n')
  }
})

test('widget state recovers from a helper failure on the next successful query', () => {
  let state
  for (const [overrides, expected] of [
    [{}, { state: 'enabled', policy: '75-80', access: 'allowed', stale: false }],
    [{ BATTERY_TEST_FAIL_ENUM: '1' }, { state: 'enabled', policy: '75-80', access: 'unknown', stale: true }],
    [{ BATTERY_TEST_ENABLED: 'false' }, { state: 'disabled', policy: '75-80', access: 'allowed', stale: false }]
  ]) {
    const result = run(['status', '--shell'], overrides)
    state = model.parseLimitStatus(result.stdout, state, result.status)
    assert.deepEqual(state, expected)
  }
})

for (const [code, access] of [['0', 'allowed'], ['1', 'denied'], ['2', 'challenge'], ['127', 'unknown'], ['124', 'unknown']]) {
  test('permission result ' + code + ' preserves a readable protection state', () => {
    for (const enabled of ['true', 'false']) {
      const result = run(undefined, { BATTERY_TEST_AUTH: code, BATTERY_TEST_ENABLED: enabled })
      assert.equal(result.status, 0)
      const state = model.parseLimitStatus(result.stdout, undefined, result.status)
      assert.equal(state.state, enabled === 'true' ? 'enabled' : 'disabled')
      assert.equal(state.access, access)
      assert.equal(state.stale, false)
      assert.equal(model.limitEditable(state), code === '0' || code === '2')
      assert.equal(result.calls, '', 'status must not probe access by writing')
      assert.doesNotMatch(result.authCalls, /--allow-user-interaction/)
      assert.match(result.authCalls, /--process \d+,\d+,\d+/)
    }
  })
}

for (const [code, expected] of [['1', 3], ['127', 5], ['124', 5]]) {
  test('permission failure ' + code + ' blocks both enable and disable', () => {
    for (const action of ['enable', 'disable']) {
      const result = run([action], { BATTERY_TEST_AUTH: code })
      assert.equal(result.status, expected)
      assert.equal(result.calls, '')
      assert.doesNotMatch(result.authCalls, /--allow-user-interaction/)
    }
  })
}

test('authentication is requested only for an explicit change', () => {
  const result = run(['enable'], { BATTERY_TEST_AUTH: '2' })
  assert.equal(result.status, 0)
  assert.match(result.authCalls, /--allow-user-interaction/)
  assert.equal(result.calls, device + '\ttrue\n')
})

for (const code of ['1', '2', '3', '127']) {
  test('failed or cancelled authentication prevents writes: ' + code, () => {
    const result = run(['disable'], { BATTERY_TEST_AUTH: '2', BATTERY_TEST_AUTH_INTERACTIVE: code })
    assert.equal(result.status, 4)
    assert.equal(result.calls, '')
    assert.match(result.stderr, /Authentication was not completed/)
  })
}

test('the action rechecks permissions after an allowed status read', () => {
  assert.equal(model.limitEditable(model.parseLimitStatus(run().stdout, undefined, 0)), true)
  const result = run(['enable'], { BATTERY_TEST_AUTH: '1' })
  assert.equal(result.status, 3)
  assert.equal(result.calls, '')
})

test('a write failure keeps diagnostics and can be retried', () => {
  const failed = run(['enable'], { BATTERY_TEST_FAIL_WRITE: '1' })
  assert.equal(failed.status, 6)
  assert.match(failed.stderr, /Failed to set charge control thresholds/)
  assert.match(model.limitActionError(failed.status), /cause is unknown/)
  assert.equal(run(['enable']).status, 0)
})

const adminPassword = { role: 'bios-admin', mechanism: 'password', is_enabled: '1' }

for (const entry of ['dell-wmi-sysman/authentication/Admin', 'thinklmi/authentication/supervisor', 'other-driver/authentication/setup']) {
  test('a failed write can report an administrator password without relying on entry names: ' + entry, () => {
    const result = run(['disable'], { BATTERY_TEST_FAIL_WRITE: '1' }, {}, { [entry]: adminPassword })
    assert.equal(result.status, 8)
    assert.equal(result.calls, device + '\tfalse\n', 'password presence must not block the write attempt')
    assert.match(result.stderr, /Failed to set charge control thresholds/)
    assert.match(result.stderr, /BIOS administrator password is enabled and may be blocking/)
    assert.match(model.limitActionError(result.status), /may be blocking/)
  })
}

test('password detection continues past disabled and unreadable entries', () => {
  const authentication = {
    'driver-a/authentication/first': { ...adminPassword, is_enabled: '0' },
    'driver-a/authentication/second': { ...adminPassword, is_enabled: null },
    'driver-b/authentication/third': adminPassword
  }
  assert.equal(run(['enable'], { BATTERY_TEST_FAIL_WRITE: '1' }, {}, authentication).status, 8)
})

for (const fields of [
  { ...adminPassword, role: 'power-on' },
  { ...adminPassword, role: 'system-mgmt' },
  { ...adminPassword, mechanism: 'certificate' },
  { ...adminPassword, is_enabled: '0' },
  { ...adminPassword, is_enabled: 'unknown' },
  { ...adminPassword, is_enabled: '<img src=x>' },
  { ...adminPassword, is_enabled: null },
  { role: 'bios-admin', mechanism: 'password' },
  { role: 'bios-admin', is_enabled: '1' },
  { mechanism: 'password', is_enabled: '1' }
]) {
  test('inconclusive or unrelated authentication retains the generic error: ' + JSON.stringify(fields), () => {
    const result = run(['enable'], { BATTERY_TEST_FAIL_WRITE: '1' }, {}, { 'vendor/authentication/setup': fields })
    assert.equal(result.status, 6)
    assert.doesNotMatch(result.stderr, /BIOS|password/)
  })
}

test('an enabled BIOS password does not change status, permissions, or a successful action', () => {
  const authentication = { 'vendor/authentication/setup': adminPassword }
  const status = run(undefined, {}, {}, authentication)
  assert.equal(model.limitEditable(model.parseLimitStatus(status.stdout, undefined, 0)), true)
  assert.doesNotMatch(status.stdout + status.stderr, /BIOS|password/)
  const result = run(['enable'], {}, {}, authentication)
  assert.equal(result.status, 0)
  assert.equal(result.calls, device + '\ttrue\n')
  assert.doesNotMatch(result.stdout + result.stderr, /BIOS|password/)
  const denied = run(['disable'], { BATTERY_TEST_AUTH: '1' }, {}, authentication)
  assert.equal(denied.status, 3)
  assert.equal(denied.calls, '')
  assert.doesNotMatch(denied.stderr, /BIOS|password/)
})

test('a partial multi-battery failure is reported as a write failure', () => {
  const result = run(['disable'], {
    BATTERY_TEST_DEVICES: device + '\n' + secondDevice,
    BATTERY_TEST_FAIL_WRITE: secondDevice
  })
  assert.equal(result.status, 6)
  assert.equal(result.calls, device + '\tfalse\n' + secondDevice + '\tfalse\n')
  assert.doesNotMatch(model.limitActionError(result.status), /No changes were made/)
})

test('different battery states are shown as mixed rather than all off', () => {
  const result = run(undefined, { BATTERY_TEST_DEVICES: device + '\n' + secondDevice, BATTERY_TEST_SECOND_ENABLED: 'false' })
  const state = model.parseLimitStatus(result.stdout, undefined, 0)
  assert.equal(state.state, 'mixed')
  assert.equal(model.limitEditable(state), true)
})

const custom = { type: 'Battery', charge_types: 'Fast Standard [Custom]', charge_control_start_threshold: 50, charge_control_end_threshold: 90 }

test('active firmware policy overrides a false UPower flag without a BIOS-password assumption', () => {
  const result = run(undefined, { BATTERY_TEST_ENABLED: 'false', BATTERY_TEST_AUTH: '1' }, custom)
  assert.equal(result.stdout, 'state\tenabled\npolicy\t50-90\naccess\tdenied\n')
  assert.equal(result.calls, '')
})

test('an absolute UPower NativePath maps to the same battery controls', () => {
  const result = run(undefined, { BATTERY_TEST_NATIVE_PATH: '/sys/devices/platform/test/power_supply/BAT0' }, custom)
  assert.match(result.stdout, /policy\t50-90/)
})

for (const native of ['../BAT0', '/tmp/BAT0', '/sys/devices/power_supply/..', '<img src=x>', 'BAT0/../../etc/passwd']) {
  test('an invalid native path cannot select arbitrary files: ' + native, () => {
    const result = run(undefined, { BATTERY_TEST_NATIVE_PATH: native }, custom)
    assert.match(result.stdout, /policy\t75-80/)
  })
}

for (const mode of ['Fast', 'Standard']) {
  test('inactive stored thresholds do not imply protection in ' + mode + ' mode', () => {
    const result = run(undefined, {}, { ...custom, charge_types: '[' + mode + '] Custom' })
    assert.equal(result.stdout, 'state\tdisabled\npolicy\t75-80\naccess\tallowed\n')
  })
}

for (const mode of ['Long_Life', 'Trickle']) {
  test('reports firmware protection without inventing thresholds: ' + mode, () => {
    const result = run(undefined, {}, { type: 'Battery', charge_types: 'Standard [' + mode + ']' })
    assert.match(result.stdout, /state\tenabled\npolicy\tfirmware/)
  })
}

test('the older charge_type interface is supported', () => {
  const result = run(undefined, {}, { type: 'Battery', charge_type: 'Long Life' })
  assert.match(result.stdout, /state\tenabled\npolicy\tfirmware/)
})

for (const mode of ['Adaptive', 'Bypass', 'FutureMode', 'Standard Custom']) {
  test('unfamiliar or ambiguous mode remains unknown: ' + mode, () => {
    const attrs = { ...custom, charge_types: mode === 'Standard Custom' ? mode : '[' + mode + ']' }
    const result = run(undefined, {}, attrs)
    assert.match(result.stdout, /state\tunknown\npolicy\tunknown/)
    assert.equal(model.limitEditable(model.parseLimitStatus(result.stdout, undefined, 0)), false)
    const action = run(['enable'], {}, attrs)
    assert.equal(action.status, 7)
    assert.equal(action.calls, '')
  })
}

for (const [start, end, state] of [[0, 100, 'disabled'], [50, 100, 'enabled'], [0, 80, 'enabled']]) {
  test('threshold-only driver reports ' + start + '-' + end + ' as ' + state, () => {
    const result = run(undefined, {}, { type: 'Battery', charge_control_start_threshold: start, charge_control_end_threshold: end })
    assert.match(result.stdout, new RegExp('state\\t' + state))
  })
}

test('a driver with only an end threshold reports its actual limit', () => {
  const result = run(undefined, { BATTERY_TEST_SETTINGS: '2' }, { type: 'Battery', charge_control_end_threshold: 80 })
  assert.match(result.stdout, /state\tenabled\npolicy\t80/)
})

test('a driver with only a start threshold preserves the readable state', () => {
  const result = run(undefined, { BATTERY_TEST_SETTINGS: '1' }, { type: 'Battery', charge_control_start_threshold: 50 })
  assert.match(result.stdout, /state\tenabled\npolicy\tunknown/)
})

test('an unreadable expected threshold cannot imply that protection is off', () => {
  for (const attributes of [
    { type: 'Battery', charge_control_end_threshold: 100 },
    { type: 'Battery', charge_control_start_threshold: 0 },
    { type: 'Battery', charge_types: '[Custom]', charge_control_end_threshold: 100 }
  ]) {
    assert.match(run(undefined, {}, attributes).stdout, /state\tunknown\npolicy\tunknown/)
    const action = run(['disable'], {}, attributes)
    assert.equal(action.status, 7)
    assert.equal(action.calls, '')
  }
})

for (const attrs of [
  { ...custom, charge_control_start_threshold: 95 },
  { ...custom, charge_control_end_threshold: 101 },
  { ...custom, charge_control_start_threshold: '$(touch /tmp/unsafe)' },
  { type: 'Battery', charge_types: '[Custom]' }
]) {
  test('invalid or missing firmware thresholds remain unknown: ' + JSON.stringify(attrs), () => {
    assert.match(run(undefined, {}, attrs).stdout, /state\tunknown/)
  })
}

test('absent optional kernel interfaces retain the UPower policy', () => {
  assert.equal(run(undefined, {}, { type: 'Battery' }).stdout, 'state\tenabled\npolicy\t75-80\naccess\tallowed\n')
})
