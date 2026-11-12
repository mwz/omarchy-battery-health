# Battery Health for Omarchy

The built-in Omarchy power widget, extended with a battery-health toggle that
uses the charging policy exposed by your laptop through UPower.

![The power panel showing battery health and power profile controls](assets/screenshot.png)

_Wallpaper by [Simon Høiberg](https://x.com/SimonHoiberg), featuring Switzerland, our home._

## What it does

- Shows battery level, capacity, charge cycles, charge rate, and remaining time.
- Switches between the power profiles available on the system.
- Enables or disables the laptop's firmware-provided charge limit.
- Hides the battery-health control when the hardware does not support it.
- Shows the battery percentage in the bar when you right-click the battery icon.

UPower reports the charging policy supported by the laptop. This may be a fixed
limit, a start/end range, or a firmware-optimized charging mode.

Charging status follows the battery state reported by UPower. Slow charging
remains charging, and a paused charge shows "Not charging" without guessing
its cause. A partial charge reported as full by the firmware also shows
"Not charging". The battery-health control shows the configured policy separately.

## Panel close-up

![Battery health enabled with a 75-80% firmware charging policy](assets/panel.png)

## Installing it

```bash
omarchy plugin add https://github.com/patcastle/omarchy-battery-health --enable
```

The plugin declares itself as a clone of `omarchy.power`, so Omarchy replaces
the built-in power widget in place and keeps its bar position and settings. You
do not need to disable or move the original widget manually.

Click the battery icon and use **Preserve battery health**. The plugin hides
the control when UPower confirms that the hardware does not support charge limits.

If a status query fails, the plugin shows “Battery protection status unavailable”
and disables the toggle. It labels any previous state as the last known state.
The plugin retries every five seconds while the panel is open and restores the
control after a successful query.

The protection state and permission to change it are separate. A system policy
can prevent changes while protection remains on. The plugin keeps the current
state visible, disables the toggle, and explains the restriction. It also
disables changes when the permission check fails, then retries the check.

The plugin checks permission through Polkit without asking for authentication
when you open the panel. If authentication is required, clicking the toggle
requests it through the desktop authentication agent. Cancelling leaves the
charging policy unchanged.

Where the kernel exposes a recognised charging mode or charge thresholds, the
plugin reads them to show the current policy. This can correct a stale UPower
enabled flag after a failed write. Other systems use UPower as the fallback.
An unfamiliar charging mode shows an unknown state and disables changes.

Permission to request a change does not guarantee that the firmware accepts it.
If a change fails, the plugin explains the failure and refreshes the state.
When changes are available, you can use the toggle again. The next click
follows the refreshed state, including after a partial change on a system with
several batteries. Detailed errors remain in the shell log and the helper's
terminal output.

The plugin does not test access by writing values or infer a charging lock
from the presence of a BIOS password. Some firmware failures have no specific
reason in the UPower response. After a failed write, it checks the shared Linux
firmware-attributes interface for an enabled BIOS administrator password.
If it finds one, the error explains that the password may be blocking the change.
This hint does not disable the toggle. Missing or unreadable password status
keeps the generic error message.

## Compatibility

Requires an Omarchy version with shell plugin support, plus `upower` and
`busctl`, Polkit's `pkcheck`, and Coreutils' `timeout`. These are part of a
normal Omarchy installation.

Actual support depends on the laptop firmware, kernel driver, and UPower. The
plugin uses UPower's D-Bus API and does not use `sudo` or `pkexec`.

If another tool already manages your charge threshold, use one or the other so
they do not fight over the setting.

## Removing it

```bash
omarchy plugin disable patcastle.power
omarchy plugin remove patcastle.power
```

Disabling or removing it restores the built-in `omarchy.power` widget.

## Development

```bash
omarchy plugin validate .
./test.sh
```

For VS Code Auto Attach or a JavaScript Debug Terminal, run the tests in one
process to avoid Node's inspector startup error:

```bash
./test.sh --test-isolation=none
```

This option requires Node 23.6 or later and keeps debugging available.
Without this option, each test file runs in a separate process.

To debug in VS Code, open this repository as the workspace folder.
Set a breakpoint in `Model.js` or a JavaScript test, then select **Debug all tests**
in Run and Debug and press **F5**.
To run one test file, open that file and select **Debug current test file**.
These configurations debug JavaScript tests and model functions.
The popup runs separately in Quickshell, and the charge helper runs in Bash.

This is a clone of Omarchy's power widget while the corresponding upstream
change is under review in [basecamp/omarchy#8579](https://github.com/basecamp/omarchy/pull/8579).

## License

MIT
