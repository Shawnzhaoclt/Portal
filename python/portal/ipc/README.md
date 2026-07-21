# Portal Python Worker

`portal_worker.py` is the bounded process entry point used by the Tauri host.

Supported jobs:

- `health`: confirms that the packaged runtime starts.
- `request`: dispatches a validated local command to Portal Python logic.

Portal starts one worker with `--serve` during desktop sign-in and keeps it for the
application session. Requests and responses use newline-delimited JSON over standard
input and output. The worker handles one command at a time, does not listen on a port,
and exits when Portal closes its input stream. The one-shot `--job` interface remains
available for build and diagnostic checks.

The portable build packages it as
`runtime\portal-python\portal-python.exe` with its private dependencies in the same
runtime directory. Client computers do not need Python or Conda and do not receive
loose Portal Python source files. The unpacked layout avoids the startup delay caused
by extracting a PyInstaller one-file executable on every launch.
