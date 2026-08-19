# Portal Desktop Release Channels

## Purpose

Portal Manager supports a controlled test release without causing production
workstations to update. A release has one semantic application version and one
deployment channel. Channel names are not appended to the semantic version.

## Channel layout

| Channel | Manifest | Audience |
| --- | --- | --- |
| Production | `<releaseRoot>\portal-release.json` | All production installations |
| Test | `<releaseRoot>\test\portal-release.json` | Explicitly allowlisted computers |

Production keeps manifest schema version 1 for backward compatibility. Test uses
schema version 2 and adds `channel: "test"` and `allowedMachines`.

## Manager workflow

1. Build Portal Desktop and set the semantic version in the portable `VERSION` file.
2. Open **Releases**, select **Test**, and enter one or more Windows computer names.
   Use **Save computers** to persist the normalized list in the Manager
   configuration (`releaseTestMachines`); the list is restored automatically the
   next time the Test channel is opened. Publishing a Test release also saves the
   current list automatically.
3. Select the update scope and publish. Manager creates the complete recovery ZIP,
   optional executable-only payload, updater, removal script, test downloader, and
   targeted manifest under the test folder.
4. Install or update a listed test computer with `Download-Portal-Test.bat` and
   validate the release.
5. Select **Promote to production**. Manager verifies every tested artifact against
   its recorded size and SHA-256, copies those files to the production folder, and
   publishes the production manifest. Promotion never rebuilds the package.

Publishing Production directly remains supported when a controlled test is not
required.

## Desktop enrollment and enforcement

The updater stores channel enrollment at:

```text
%LOCALAPPDATA%\StormWaterPortal\data\settings\update-channel.json
```

The user-owned `data` directory is preserved by full updates. If the channel file is
missing, unreadable, or absent on an older installation, Portal uses Production.
Portal selects the channel folder before reading the manifest. Test manifests are
accepted only when the current `COMPUTERNAME` matches an allowlisted name,
case-insensitively. The About dialog displays the active update channel.

## Safety rules

- Test and Production artifacts never share a manifest path.
- A Test release requires at least one valid computer name.
- A schema-1 manifest cannot contain targeting fields.
- A schema-2 Test manifest must declare its channel and allowlist.
- Promotion requires the Test version to be newer than Production.
- Promotion reuses tested bytes and checksums instead of rebuilding.
- Full updates never overwrite or delete `%LOCALAPPDATA%\StormWaterPortal\data`.
- The first channel-aware client must be delivered as a regular Production release
  before test enrollment is used broadly.
