/** A conservative text safety bound, not an exact provider tokenizer count. */
export function getInputSafetyBound(body, { interfaceType } = {}) {
    const unsupported = reason => ({ supported: false, upperBoundTokens: null, kind: 'conservative-utf8-byte-bound', reason });
    if (!['anthropic', 'openai', 'openai-chat', 'openai-responses'].includes(interfaceType)) return unsupported('Unknown interface cannot be bounded');
    if (!body || typeof body !== 'object' || Array.isArray(body)) return unsupported('Request must be an object');
    const allowed = new Set(['model', 'system', 'messages', 'tools', 'tool_choice', 'functions', 'function_call', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'temperature', 'top_p', 'top_k', 'stop', 'stop_sequences', 'stream', 'stream_options', 'cache_control', 'prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options', 'thinking', 'output_config', 'output_format', 'response_format', 'reasoning', 'reasoning_effort', 'service_tier', 'input', 'instructions', 'previous_response_id', 'conversation', 'context_management', 'truncation', 'parallel_tool_calls', 'modalities', 'audio', 'prediction', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'logprobs', 'top_logprobs', 'seed', 'n', 'store', 'include', 'user', 'metadata', 'safety_identifier']);
    if (Object.keys(body).some(key => !allowed.has(key))) return unsupported('Unrecognized request fields require a verified input adapter');
    if (body.previous_response_id || body.conversation) return unsupported('Server-side conversation history is not visible');
    if (body.context_management) return unsupported('Context management may change input outside this visible text snapshot');
    if (body.audio || (body.modalities && (!Array.isArray(body.modalities) || body.modalities.some(value => value !== 'text')))) return unsupported('Audio/multimodal input is not covered');
    const textContent = content => typeof content === 'string' || (Array.isArray(content) && content.every(block => block && typeof block === 'object'
        && ['text', 'input_text', 'output_text'].includes(block.type) && typeof block.text === 'string'
        && Object.keys(block).every(key => ['type', 'text', 'cache_control'].includes(key))));
    const message = item => {
        if (!item || typeof item !== 'object' || !['system', 'developer', 'user', 'assistant', 'tool', 'function'].includes(item.role)) return false;
        if (Object.keys(item).some(key => !['type', 'role', 'content', 'name', 'tool_call_id', 'tool_calls', 'function_call', 'cache_control'].includes(key))) return false;
        if (item.type && item.type !== 'message') return false;
        if (item.content !== null && item.content !== undefined && !textContent(item.content)) return false;
        if (item.content == null && !item.tool_calls && !item.function_call) return false;
        if (item.tool_calls && (!Array.isArray(item.tool_calls) || item.tool_calls.some(call => call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string'))) return false;
        if (item.function_call && (typeof item.function_call.name !== 'string' || typeof item.function_call.arguments !== 'string')) return false;
        return true;
    };
    if (body.system !== undefined && !textContent(body.system)) return unsupported('Unknown system content blocks');
    if (body.instructions !== undefined && typeof body.instructions !== 'string') return unsupported('Unknown instruction content');
    if (body.messages !== undefined && (!Array.isArray(body.messages) || !body.messages.every(message))) return unsupported('Non-text or unrecognized message content');
    if (body.input !== undefined && !(typeof body.input === 'string' || (Array.isArray(body.input) && body.input.every(message)))) return unsupported('Non-text or unrecognized Responses input');
    if (!Array.isArray(body.messages) && body.input === undefined) return unsupported('No recognized text context');
    if (body.tools && (!Array.isArray(body.tools) || body.tools.some(tool => tool?.type && tool.type !== 'function'))) return unsupported('Server tools may add unseen input');
    return { supported: true, upperBoundTokens: new TextEncoder().encode(JSON.stringify(body)).length + 4096, kind: 'conservative-utf8-byte-bound', exact: false,
        note: 'UTF-8 serialized request bytes plus 4096 protocol allowance; intentionally conservative for visible text, not a provider token count.' };
}
