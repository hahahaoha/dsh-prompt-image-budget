/**
 * Prompt image budget: keep every model request at or below a fixed number of
 * images, converting the oldest surplus images into text placeholders.
 *
 * The mechanism is the Harness's own durable image omission. Before a step
 * enters the model, this plugin counts the images that request would carry and,
 * when that count exceeds the budget, omits the oldest surplus:
 *
 * - images already committed to the session become one durable `image/offload`
 *   decision, so every later request, resume, fork, and compaction replays the
 *   same placeholders from the log;
 * - images inside the messages this step is about to admit are marked in those
 *   messages, because no event holding them exists yet.
 *
 * Either way the route renders an omitted occurrence as deterministic text
 * (image identity, dimensions, and the read-only normalized path tools can
 * open), so the model keeps a usable handle instead of the bytes.
 *
 * @module @local/prompt-image-budget
 */

export const name = 'prompt-image-budget'
export const inject = ['sessions']

/** The durable event the Harness reads image omissions from. */
const OFFLOAD_EVENT = 'image/offload'

/**
 * Budget used when the row sets none or sets an unusable value.
 *
 * This plugin deliberately exports no `Config` schema. A schema has to be a
 * native Schemastery graph for the profile's config-schema projection, and a
 * profile-installed bundle cannot rely on importing that library: this profile
 * resolves `@deepseek-ai/*` from a different installation generation than the
 * one running, and a hand-built stand-in for a native schema is worse than none
 * (the projection reports the row as an error). Without a schema the row is
 * simply unconfigurable through a form, so the budget comes from the patch and
 * this module validates it on the way in.
 */
const DEFAULT_MAX_IMAGES = 8

/**
 * Event types the `image/offload` projection accepts as omission targets.
 *
 * The projection rejects any other node, so counting or targeting a sequence
 * outside this set would make the append throw and fail the step. Production
 * adapters declare text-only output, so model messages carry no images.
 */
const OMITTABLE_EVENT_TYPES = new Set(['user/message', 'tool/result'])

/**
 * One retained image occurrence, in the order a request would send it.
 * @typedef {object} RetainedImage
 * @property {number} seq - Surface event seq holding this occurrence, or -1 for an admitted message.
 * @property {number} messageIndex - Index into the pending batch, or -1 for a committed message.
 * @property {number} imageIndex - Depth-first image index within its message.
 * @property {boolean} targetable - Whether a durable omission may name this occurrence.
 */

/**
 * Read the configured budget.
 *
 * The row supplies `maxImages` from the patch, so an unusable value is read
 * defensively instead of aborting activation: the plugin keeps enforcing the
 * default rather than silently offering no ceiling at all.
 *
 * @param {unknown} value - resolved configuration value.
 * @returns {number} a positive integer budget.
 */
function budgetOf(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_IMAGES
  return Math.floor(parsed)
}

/**
 * Collect the retained (not already omitted) image occurrences of one message.
 * @param {readonly any[]} content - content blocks of the message.
 * @param {(imageIndex: number) => RetainedImage} locate - builds the record for one occurrence.
 * @returns {RetainedImage[]} retained occurrences in order.
 */
function messageImages(content, locate) {
  /** @type {RetainedImage[]} */
  const found = []
  let imageIndex = 0
  for (const block of content) {
    if (block.type !== 'image') continue
    // Omitted occurrences still advance the index: `image/offload` numbers
    // every image of a message, including ones an earlier decision omitted.
    if (block.offloaded !== true) found.push(locate(imageIndex))
    imageIndex += 1
  }
  return found
}

/**
 * Collect every image occurrence the proposed step would send, oldest first.
 *
 * Committed messages come first because the surface is the request prefix; the
 * messages claimed for this step follow. Reading the surface (rather than the
 * raw log) is what makes an earlier decision visible: a message a projection
 * rewrote contributes its placeholders, not its bytes.
 *
 * @param {{ surface: { nodes: readonly number[] }, eventAt: (seq: number) => any, deriveEventMessage: (event: any) => any }} session - session being advanced.
 * @param {readonly any[]} pending - messages this step is about to admit.
 * @returns {RetainedImage[]} retained occurrences in request order.
 */
export function retainedImages(session, pending) {
  /** @type {RetainedImage[]} */
  const retained = []
  for (const seq of session.surface.nodes) {
    // `eventAt` is the synchronous log read the session layer marks deprecated
    // for new callers, but building an `image/offload` target requires the
    // event's own seq, and the plugin that owns that event
    // (`dsh-compaction-image-offload`) reads history this same way for this
    // same purpose. Moving to a seq-carrying derived view when the session layer
    // gains one is the forward-compatible path.
    const event = session.eventAt(seq)
    if (event === undefined) continue
    const message = session.deriveEventMessage(event)
    if (message === null) continue
    // An occurrence the projection cannot target is still counted, so the
    // charge against the budget stays honest, but it is reported as
    // untargetable and never selected for a durable omission.
    const targetable = OMITTABLE_EVENT_TYPES.has(event.type)
    retained.push(
      ...messageImages(message.content, (imageIndex) => ({
        seq,
        messageIndex: -1,
        imageIndex,
        targetable,
      })),
    )
  }
  for (const [messageIndex, message] of pending.entries()) {
    retained.push(
      ...messageImages(message.content, (imageIndex) => ({
        seq: -1,
        messageIndex,
        imageIndex,
        targetable: true,
      })),
    )
  }
  return retained
}

/**
 * Group committed surplus occurrences into `image/offload` targets.
 *
 * The event requires strictly increasing indexes per target and one target per
 * seq; the occurrences arrive in request order, so per-seq indexes only grow
 * and both hold by construction.
 *
 * @param {readonly RetainedImage[]} surplus - oldest occurrences to omit.
 * @returns {{ seq: number, imageIndexes: number[] }[]} decision targets.
 */
export function targetsFor(surplus) {
  /** @type {Map<number, number[]>} */
  const bySeq = new Map()
  for (const { seq, imageIndex, targetable } of surplus) {
    if (seq < 0 || targetable === false) continue
    const indexes = bySeq.get(seq)
    if (indexes === undefined) bySeq.set(seq, [imageIndex])
    else indexes.push(imageIndex)
  }
  return [...bySeq].map(([seq, imageIndexes]) => ({ seq, imageIndexes }))
}

/**
 * Group pending surplus occurrences by their message index.
 * @param {readonly RetainedImage[]} surplus - oldest occurrences to omit.
 * @returns {Map<number, Set<number>>} omitted image indexes per pending message.
 */
function pendingOmissions(surplus) {
  /** @type {Map<number, Set<number>>} */
  const byMessage = new Map()
  for (const { messageIndex, imageIndex } of surplus) {
    if (messageIndex < 0) continue
    const indexes = byMessage.get(messageIndex)
    if (indexes === undefined) byMessage.set(messageIndex, new Set([imageIndex]))
    else indexes.add(imageIndex)
  }
  return byMessage
}

/**
 * Mark pending occurrences as omitted in the messages about to be admitted.
 * @param {readonly any[]} messages - messages claimed for this step.
 * @param {ReadonlyMap<number, ReadonlySet<number>>} omitByMessage - omitted image indexes per message.
 * @returns {any[]} the original array when nothing changes, else rewritten copies.
 */
function omitPendingImages(messages, omitByMessage) {
  if (omitByMessage.size === 0) return messages
  return messages.map((message, index) => {
    const selected = omitByMessage.get(index)
    if (selected === undefined || selected.size === 0) return message
    let imageIndex = 0
    const content = message.content.map((block) => {
      if (block.type !== 'image') return block
      const taken = selected.has(imageIndex)
      imageIndex += 1
      return taken ? { ...block, offloaded: true } : block
    })
    return { ...message, content }
  })
}

/**
 * Mount the pre-step listener that enforces the image budget.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {{ maxImages?: number }} [config] - row configuration.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const maxImages = budgetOf(config?.maxImages)
  // Whether the durable half is available is re-read every step: the owning
  // plugin can be unloaded or reloaded between steps, and a cached `true` would
  // then append an event no projection can interpret, failing the whole step.
  let warned = false

  /** Whether the store currently interprets the omission event. */
  const canOmitDurably = () => ctx.sessions.messageProjections.some((item) => item.type === OFFLOAD_EVENT)

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    const durableOmissions = canOmitDurably()
    const retained = retainedImages(agent.session, decision.messages)
    const need = retained.length - maxImages
    if (need <= 0) return decision

    // Choose from the occurrences this mechanism can actually omit, then take
    // the oldest `need` of them. Filtering BEFORE slicing matters: slicing the
    // full list first can select only untrimmable occurrences and leave the
    // request over budget while reporting success.
    const omittable = retained.filter(
      (item) => (durableOmissions || item.messageIndex >= 0) && (item.messageIndex >= 0 || item.targetable !== false),
    )
    let surplus = omittable.slice(0, need)

    if (surplus.length < need && !warned) {
      warned = true
      ctx.logger?.warn?.(
        `prompt-image-budget: ${retained.length} images are retained but only ${surplus.length} of them can be omitted, `
          + `so this request still carries ${retained.length - surplus.length} images against a budget of ${maxImages}. `
          + (durableOmissions ? 'Images on nodes the image/offload event refuses to target account for the remainder.'
            : 'Enable the image-offload plugin so committed history can be trimmed.'),
      )
    }

    const targets = targetsFor(surplus)
    if (targets.length > 0) {
      try {
        // A durable surface repair, not a provider retry: it spends no retry
        // budget and logs no retry event.
        agent.session.append(OFFLOAD_EVENT, { targets })
      } catch (error) {
        // The projection vanished between the check and this append. Never let
        // the budget plugin fail the step: fall back to the half that needs no
        // projection, keeping every pending occurrence this pass had selected.
        const pendingOnly = surplus.filter((item) => item.messageIndex >= 0)
        // The selected committed occurrences cannot be omitted now, so the
        // budget may be short. Widen the pending selection to cover what they
        // would have accounted for, without exceeding the pending supply.
        const shortfall = need - pendingOnly.length
        if (shortfall > 0) {
          const extra = omittable
            .filter((item) => item.messageIndex >= 0 && !pendingOnly.includes(item))
            .slice(0, shortfall)
          surplus = [...pendingOnly, ...extra]
        } else {
          surplus = pendingOnly
        }
        if (!warned) {
          warned = true
          ctx.logger?.warn?.(
            `prompt-image-budget: could not record an image omission (${String(error)}); `
              + `committed images were left in place, so this request still carries `
              + `${retained.length - surplus.length} images against a budget of ${maxImages}.`,
          )
        }
        return { ...decision, messages: omitPendingImages(decision.messages, pendingOmissions(surplus)) }
      }
    }
    return { ...decision, messages: omitPendingImages(decision.messages, pendingOmissions(surplus)) }
  })
}
