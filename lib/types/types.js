/**
 * Type-only module for `@deepseek-ai/dsh-llm-acp`.
 * @module @deepseek-ai/dsh-llm-acp/types
 */
/**
 * Map an ACP {@link StopReason} to a harness {@link FinishReason}.
 *
 * ACP `end_turn` maps to `stop` (clean completion with no further tool work).
 * `max_tokens` maps to the harness length cap. `refusal` is surfaced as a
 * refusal finish. `cancelled` becomes `aborted`. `max_turn_requests` and any
 * unknown future variant map to `error`, so an unclean stop is never reported
 * as success.
 * @param reason - the terminal reason from the child's `session/prompt` response.
 * @param failure - the failure payload for error/aborted finishes.
 * @returns the harness finish reason.
 */
export function acpFinishReason(reason, failure) {
    switch (reason) {
        case 'end_turn':
            return { kind: 'stop' };
        case 'max_tokens':
            return { kind: 'max-tokens' };
        case 'refusal':
            return { kind: 'error', failure: { ...failure, code: 'REFUSAL' } };
        case 'cancelled':
            return { kind: 'aborted', failure };
        case 'max_turn_requests':
            return { kind: 'error', failure: { ...failure, code: 'MAX_TURN_REQUESTS' } };
        default:
            return { kind: 'error', failure: { ...failure, code: 'UNKNOWN_STOP_REASON' } };
    }
}
//# sourceMappingURL=types.js.map