# Prompt image budget

A Host plugin for DeepSeek Harness that caps how many images a single model
request carries. Once a prompt would exceed the configured number of images, the
oldest surplus images are converted to text placeholders naming each image, its
dimensions, and its read-only saved path.

## What it does

Before each step reaches the model, the plugin counts the images that request
would carry — both the ones already committed to the session and the ones the
step is about to admit. When the count exceeds `maxImages`, it keeps the newest
`maxImages` occurrences and turns the rest into text:

- Committed images become one durable `image/offload` decision in the session
  log, so later requests, resume, fork, and compaction replay the same
  placeholders.
- Images in the message the current step is admitting are marked in that message
  directly, because no event holds them yet.

With the default budget of 8, a prompt carrying 12 images renders the oldest 4
as text and sends the newest 8 as images.

## Why placeholders instead of an extra model call

The placeholder is deterministic and costs no additional request, so trimming
never adds latency or spend. It carries the image identity and its pixel
dimensions, and when the attachment backend can resolve one, the read-only
normalized path, so the model can still open the image with its file tools. This
reuses the Harness's own image-offload mechanism, which means the decision is
durable and replays exactly for resume and fork.

## Configuration

The row takes one setting, `maxImages`, defaulting to `8`:

```yaml
- insert:
    - id: prompt-image-budget
      name: '@local/prompt-image-budget'
      config:
        maxImages: 8
```

Change the value and reload the profile.

This plugin intentionally declares no config schema, so it has no generated
settings form and the value is validated by the plugin rather than by the
loader. That is deliberate: a native schema would mean importing
`@deepseek-ai/schemastery`, and a profile-installed bundle cannot rely on that
resolve — this profile resolves `@deepseek-ai/*` from a different installation
generation than the one running. A stand-in schema that is not native is worse
than none, because the profile's config-schema projection then reports the row
as an error.

A value that is not a number at least 1 falls back to `8` rather than silently
disabling the cap. In particular `0` does not mean "no images": use `1` for the
smallest budget this plugin allows.

## Requirements

The durable half of the mechanism needs the `image/offload` event projection,
which the shipping `image-offload` plugin registers
(`@deepseek-ai/dsh-compaction-image-offload`, row `image-offload`). It is enabled
in the base composition.

Without that row the plugin still trims the images in the prompt the current
step is admitting, but it cannot touch images already committed to the session.
When those committed images alone exceed the budget, the request stays over
budget and the plugin logs one warning naming the over-run instead of pretending
to have trimmed.

## Turning it off

Disabling the plugin stops new trimming. Decisions already recorded in a session
log stay in effect for that session, because they are durable session events:
the placeholders keep replaying there. New sessions carry no decisions.

Note that disabling the separate `image-offload` plugin makes every session that
already recorded such a decision refuse further derivation — that is the
session layer's own guard, not this plugin's, and the fix is to re-enable that
row rather than to disable this one.

## Limitations

- The plugin counts image occurrences, not bytes or visual tokens. A provider's
  own byte or count budget is enforced separately by that adapter.
- Only user messages and tool results can be named by a durable omission, which
  is the rule the `image/offload` event enforces. Production adapters declare
  text-only output, so model messages carry no images in practice; if one ever
  returns an image, that occurrence counts against the budget and is left
  intact, and the plugin warns when the budget therefore cannot be met.
- Trimming keeps the newest images, so the context an agent has most recently
  worked from survives; older images remain reachable through their saved path
  when the backend exposes one.
