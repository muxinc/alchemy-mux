# alchemy-mux

Mux resources and runtime bindings for [Alchemy](https://alchemy.run) v2.
See `example/alchemy.run.ts` for a stack that uses all of them. That stack
is deployed and destroyed by `bun run verify`.

This package is not published, and Mux does not support it separately. It
is intended to become an official Alchemy provider. It is pinned to
`alchemy@2.0.0-beta.87`, because Alchemy's API can change between betas.

## Resources

| Resource | Updates in place | Changing it creates a new one |
| --- | --- | --- |
| `Mux.Asset` | `passthrough`, `meta`, `thumbnail_time`, `master_access`, `static_renditions`, `playback_policies` (adds and removes playback IDs), `directives` (new ones run on the existing asset), text and audio tracks (`text` and `audio` inputs, and the first input's `generated_subtitles`) | the video input, a watermark (overlay) input, `video_quality`, `test` and other ingest settings (re-encodes) |
| `Mux.LiveStream` | latency, reconnect window and slate, max duration, passthrough, title, `enabled`, live and embedded captions, `mp4_support` / `master_access` / `video_quality` / `meta` of recordings | playback policies, `audio_only`, `test`, other recording settings (new stream key) |
| `Mux.SimulcastTarget` | nothing | everything (Mux has no update endpoint) |
| `Mux.TranscriptionVocabulary` | name, phrases, passthrough | nothing |
| `Mux.Robots.Directive` | nothing | everything (Mux locks Directives at creation) |
| `Mux.Webhook` | address, `enabled` | nothing. Also `Mux.Webhook.lookup({ address })` |
| `Mux.Annotation` | nothing (drift repair puts back an edited note) | everything. Add `RemovalPolicy.retain()` to keep old markers |
| `Mux.SigningKey` | nothing | nothing to configure |
| `Mux.PlaybackRestriction` | referrer and user-agent rules | nothing |

`Asset` and `LiveStream` expose `public_playback_id`, `signed_playback_id`
and `drm_playback_id`, because Alchemy Outputs cannot be indexed.

By default, `Asset` waits during deploy until Mux has ingested the video.
If ingest fails, or a track errors, it deletes the errored asset and fails
the deploy. Tracks added to an existing asset are waited on too; if one
errors, the deploy fails and the asset's tracks are put back as they were. Set
`wait_for_ready: false` to skip the wait.

Secrets Mux returns only once (`stream_key`, `srt_passphrase`, `private_key`,
`signing_secret`) are kept as `Redacted` values in Alchemy state. Treat the
state store as sensitive.

## Bindings

Use these inside a Function or Worker. Secrets reach the host as secrets.

- `Mux.PlaybackSigner(signingKey)` signs playback, thumbnail, GIF,
  storyboard and DRM license tokens.
- `Mux.WebhookVerifier(webhook)` checks the `mux-signature` header against
  the raw body, with a 5-minute tolerance.

Provide `Mux.PlaybackSignerLive` and `Mux.WebhookVerifierLive`. The
underlying `signPlaybackToken` and `verifyWebhookSignature` are exported for
use without a binding.

## Credentials

Set `MUX_TOKEN_ID` and `MUX_TOKEN_SECRET`, or run `alchemy profile edit`.
The token needs Video, System, Robots and Data write for the resources you
use.

## Failed deploys and drift

Updates compare the props with what Mux reports, not with the props of the
last deploy. So when a deploy fails partway through an update, the next
deploy finishes the change, or undoes it if you reverted the props. A setting
removed from the props returns to Mux's default.

A plain `alchemy deploy` trusts its state. `alchemy deploy --detect-drift`
reads every resource from Mux, recreates the ones deleted in the dashboard,
and puts back settings changed there: titles, metadata, latency, captions,
playback IDs, master access, renditions, declared tracks, webhook addresses
and annotation notes. Directive runs are events and are never repeated, and
tracks added outside Alchemy are left alone.

When a stream is finishing an interrupted update, Alchemy hides even its `id`
from dependents, so the next deploy also recreates its simulcast targets
with the same settings.

## Verify

`bun run verify` is the release gate. Every gate must pass before a change
counts as done. It runs these checks in order and stops at the first failure:

1. **Credentials.** The token is valid, has video, system, robots and data
   write, and belongs to a non-production environment.
2. **Generated types.** `src/generated/mux-api.ts` matches what
   `bun run generate` produces from the vendored `spec/mux-api-spec.json`.
3. **Typecheck,** including the tests and the example. Then the package
   builds, and Node loads it through its `exports` map.
4. **API client.** Against a local fake server: 429s retry and honor
   `Retry-After`, POSTs never retry after a 5xx, retries stop at the cap, 404
   maps to `NotFound`, lists page, and auth is sent.
5. **Lifecycle, per scenario, against real Mux.** In every phase:
   - The plan Alchemy prints matches the expected create, update, replace or
     noop for each resource.
   - Phase checks read Mux directly through a separate raw client
     (`test/lib.ts`).
   - Every resource's persisted attributes agree with what Mux reports.
   - Redeploying the same props plans nothing but noops.

   Scenarios also cover:
   - conflicts and bad inputs that must fail with clear errors
   - a deploy that fails partway through an update, then a deploy that
     reverts the props and must put Mux back
   - out-of-band deletes and edits repaired by `--detect-drift`
   - removed settings returning to Mux's defaults
   - `RemovalPolicy.retain()`
   - bindings: tokens accepted by `stream.mux.com` and `image.mux.com`
     (403 without them), and webhook signatures cross-checked against the
     official `@mux/ts` SDK

   Destroy always runs, and every object the scenario created must then be
   gone, or still present if it was retained. After a phase that must fail,
   state holds the last good props while Mux may be half-changed, so the
   persisted-attributes check is skipped and the next phase must repair it.
6. **Sweep.** Every Mux object type is listed, and nothing tagged with this
   run's ID may remain.
7. **Coverage,** on full runs. Every prop a resource updates in place
   (`AssetUpdatable` and `LiveStreamUpdatable` in the source, and the props
   of webhooks, vocabularies and playback restrictions) must be changed by
   some phase that plans an in-place update.

CI runs every gate on each pull request and each push to `main`, one run at
a time, with the `MUX_TOKEN_ID` and `MUX_TOKEN_SECRET` repository secrets.
Those must belong to a development environment.

Run chosen scenarios with `bun run verify asset bindings`. A full run takes
several minutes, creates only test assets and idle streams, and deletes
everything it made.

Every check has been shown to fail: a known bug was put back into the code,
the check caught it, and the code was restored. When you add a check, do the
same.

### Mux API behavior worth knowing

- After a signing key is deleted, `GET /system/v1/signing-keys/{id}` can keep
  returning 200 for minutes if the key was read beforehand. The list endpoint
  is accurate, so `SigningKey` reads from the list.
- Live stream PATCH and PUT responses omit `playback_ids`, so the provider
  reads the stream again after updating it.
- Playback IDs come back in no stable order, so the provider sorts them.
- Live stream `meta` and recording `meta` ignore `{}`. A key is cleared by
  sending it as an empty string. Live stream `meta` keeps only `title`.
- Live stream `reconnect_window` is omitted when it is 0. It defaults to 60
  for standard latency and 0 for reduced and low, and changing latency
  does not change it.
- Test live streams are fixed at `max_continuous_duration: 300`; other
  streams default to 43200.
- Annotations dated far in the past (for example, 2023) get a 500 instead of
  a 400.
- Track names must be unique per asset, so a changed track is removed before
  its replacement is added. Mux does not report a track's source URL, so the
  provider finds tracks by type, language and name.
- A track with a bad URL errors while the asset stays `ready`.
- Live streams reject `video_quality: "basic"`, test streams reject simulcast
  targets, and low latency cannot be combined with live or embedded
  captions. Creating such a stream is rejected, but a PATCH to low latency
  with embedded captions on is accepted.
