# Installation acceptance test

Ask a person unfamiliar with Proofer to follow the
[installation guide](../install-guide.md), while an observer records where they
need help. Use a disposable profile on Windows and macOS, then repeat the
relevant browser steps on Chrome, Brave and Edge. A Linux source-install run
can exercise the same extension flow, with its own Ollama installation.

Choose the installation route being released:

- **Source or release ZIP:** build or unpack the reviewed extension, enable
  Developer mode, and load `dist/proofer` or the extracted extension directory.
  Include these developer actions when evaluating this route.
- **Store package:** use the actual reviewed store link, when available, and
  its Add action. This route should need no terminal or source checkout.

The hosted Windows/macOS workflow checks setup mechanics and its verdict;
this observed run also checks installer dialogs, wording and recoverability.
Save observations in an external review directory or
`test/results/acceptance-YYYY-MM-DD.md` (ignored). Use synthetic text and avoid
recording account names, private drafts or unrelated browser tabs.

## Before starting

- Open a scratch writing page in another tab with an unsent synthetic draft.
- Record OS and browser versions, power source, and whether Ollama is already
  installed. A clean-install run starts without Ollama.
- Start timing at the chosen installation step. Record each click, waits over
  five seconds, and points where the tester cannot identify the next action.

## The run

| Step | Action | Expected observation |
|---|---|---|
| 1 | Install from the selected route | Setup opens automatically. |
| 2 | If Ollama is missing, use **Get Ollama** and follow its installer | The tester can install and start Ollama, then return to setup. Record confusing dialogs and disk-space requirements. |
| 3 | Return to setup | Discovery and engine download continue without another configuration step. |
| 4 | During download, try **Pause**, close setup, reopen it from the toolbar, then **Resume** | Progress and recovery are clear. Record download size and elapsed time. |
| 5 | Wait for the speed check | Record its final screen and duration. A correct **Too slow** result leaves Proofer off and is not an installer failure. Investigate operational failures. |
| 6 | On a **Ready** result, press **Turn on** and pin the extension | The activation and pinning instructions are understandable. |
| 7 | Return to the pre-existing scratch page | The tester notices the refresh instruction and saves the draft before refreshing. |
| 8 | Type `We recieved the invoice yesterday. Then we` | The first sentence changes to “received” and flashes green; Escape takes the correction back within its undo window. |
| 9 | Open the toolbar menu | It reports the current status and lists the correction in Recent changes. |
| 10 | Quit Ollama and type another synthetic sentence; then restart Ollama | The pinned badge and toolbar explain the problem, and the extension recovers. |
| 11 | Use **Save test report** in setup | The saved report contains no typed text, websites or file paths. |

For a computer that does not reach **Ready**, record the verdict and confirm
that direct editing stays off; do not bypass qualification to complete later
steps. On a laptop, repeat the speed check on battery and label the report.
For store installation in Edge, also record any other-store permission prompt.

## Review the result

Update the installation guide where the observed UI differs from its wording.
Regenerate store screenshots after relevant UI changes. Fix unexpected stalls
or failures and repeat the affected route before releasing it. Record the
package version, installation route and validation result alongside the
observations so later releases can be compared.
