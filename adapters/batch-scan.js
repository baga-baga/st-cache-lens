/** Read-only current-card configuration collection. Does not generate or activate lore. */
import { stableStringify } from '../core/optimizer.js';

export const BATCH_SCAN_COMPATIBILITY = Object.freeze({
    version: '1.19.0', commit: '06bde939fb1e9c4c8d8641d810f0a916b5bce127',
    source: 'https://github.com/SillyTavern/SillyTavern/tree/06bde939fb1e9c4c8d8641d810f0a916b5bce127',
    verifiedSource: true,
});
const WORLD_FIELDS = ['world_info_depth', 'world_info_min_activations', 'world_info_min_activations_depth_max', 'world_info_budget', 'world_info_include_names', 'world_info_recursive', 'world_info_overflow_alert', 'world_info_case_sensitive', 'world_info_match_whole_words', 'world_info_character_strategy', 'world_info_budget_cap', 'world_info_use_group_scoring', 'world_info_max_recursion_steps'];
const PRESET_FIELDS = ['chat_completion_source', 'openai_max_context', 'openai_max_tokens', 'temperature', 'top_p', 'top_k', 'min_p', 'freq_pen', 'pres_pen', 'seed', 'names_behavior', 'squash_system_messages', 'claude_use_sysprompt', 'use_sysprompt', 'continue_prefill', 'continue_postfix', 'continue_nudge_prompt', 'new_chat_prompt', 'new_group_chat_prompt', 'group_nudge_prompt', 'send_if_empty', 'impersonation_prompt', 'world_info_format', 'enhance_definitions', 'wrap_in_quotes', 'reasoning_effort', 'reasoning', 'reasoning_format', 'show_thoughts', 'stream_openai', 'function_calling', 'enable_web_search'];
const MEMORY_FIELDS = ['source', 'memoryFrozen', 'SkipWIAN', 'prompt', 'promptWords', 'promptInterval', 'promptForceWords', 'template', 'depth', 'role', 'position', 'prompt_builder', 'overrideResponseLength', 'maxMessagesPerRequest', 'scan'];
const PERSONA_FIELDS = ['persona_description', 'persona_description_position', 'persona_description_role', 'persona_description_depth', 'persona_description_lorebook'];
const safeClone = value => value === undefined ? undefined : structuredClone(value);
const pick = (object, fields) => Object.fromEntries(fields.filter(key => object?.[key] !== undefined).map(key => [key, safeClone(object[key])]));
const emptyObject = value => !value || typeof value !== 'object' || Array.isArray(value);
const safeName = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const call = (fn, fallback = null) => { try { return typeof fn === 'function' ? fn() : fallback; } catch { return fallback; } };

/**
 * Resolve live public module exports lazily, only when the user requests a scan.
 * Inject importModule/getContext in tests or compatible forks; no private plugin state is read.
 */
export async function getSetupInputs({ context, snapshot = null, importModule = path => import(path), getContext = () => globalThis.SillyTavern?.getContext?.(), runtimeVersion = null } = {}) {
    const initial = context || getContext();
    if (!initial) throw new Error('SillyTavern context unavailable');
    const results = await Promise.allSettled([importModule('/scripts/world-info.js'), importModule('/scripts/openai.js')]);
    const worldModule = results[0].status === 'fulfilled' ? results[0].value : null;
    const openaiModule = results[1].status === 'fulfilled' ? results[1].value : null;
    return {
        context: initial,
        snapshot,
        runtimeVersion,
        readCurrentContext: () => getContext() || initial,
        loadWorldInfo: initial.loadWorldInfo || worldModule?.loadWorldInfo,
        readWorldBindings: worldModule ? () => ({
            selectedWorldInfo: Array.isArray(worldModule.selected_world_info) ? safeClone(worldModule.selected_world_info) : undefined,
            worldInfoSettings: typeof worldModule.getWorldInfoSettings === 'function' ? worldModule.getWorldInfoSettings() : undefined,
            metadataKey: worldModule.METADATA_KEY,
        }) : null,
        readPresetOrder: openaiModule ? () => {
            const manager = openaiModule.promptManager;
            if (!manager || typeof manager.getPromptOrderForCharacter !== 'function') return null;
            const strategy = manager.configuration?.promptOrder?.strategy;
            const character = manager.activeCharacter;
            if (!character || !['global', 'character'].includes(strategy)) return null;
            return { order: safeClone(manager.getPromptOrderForCharacter(character)), strategy, characterId: character.id, dummyId: manager.configuration?.promptOrder?.dummyId };
        } : null,
        getModel: current => {
            const getModel = current?.getChatCompletionModel || openaiModule?.getChatCompletionModel;
            return typeof getModel === 'function' ? getModel(current.chatCompletionSettings) : null;
        },
        bridgeWarnings: results.flatMap((result, i) => result.status === 'rejected' ? [{ code: i === 0 ? 'WORLD_MODULE_UNAVAILABLE' : 'PRESET_MODULE_UNAVAILABLE', severity: 'warning' }] : []),
    };
}

function selectCurrentSettings(context, worldInput, presetInput, getModel) {
    const characterId = context.characterId ?? null;
    const character = characterId === null ? null : context.characters?.[characterId];
    const avatar = typeof character?.avatar === 'string' ? character.avatar : null;
    // Exact official getCharaFilename behavior in utils.js:1342, no name-based guess.
    const characterFilename = avatar?.replace(/\.[^/.]+$/, '') ?? null;
    const worldSettings = worldInput?.worldInfoSettings;
    const charLore = worldSettings?.world_info?.charLore;
    const characterExtra = Array.isArray(charLore) && characterFilename !== null ? charLore.find(item => item?.name === characterFilename) : undefined;
    const settings = context.chatCompletionSettings || {};
    const source = settings.chat_completion_source || 'unknown';
    const model = call(() => getModel?.(context), null) || settings.model || settings[`${source}_model`] || 'unknown';
    const chatId = call(context.getCurrentChatId, context.chatId) ?? context.chatId ?? null;
    const presetManager = call(() => context.getPresetManager?.('openai'));
    const presetName = call(() => presetManager?.getSelectedPresetName?.());
    const presetId = call(() => presetManager?.getSelectedPreset?.());
    const sources = Object.entries(context.extensionPrompts || {}).map(([key, value]) => ({
        id: `extension:${key}`, key, content: typeof value?.value === 'string' ? value.value : '', text: typeof value?.value === 'string' ? value.value : '',
        ...pick(value, ['position', 'depth', 'role', 'scan']), access: 'read-only',
        adapter: key === '1_memory' ? 'builtin-memory' : null,
        identityConfidence: key === '1_memory' ? 'verified-builtin' : 'extension-key-only',
    }));
    return {
        binding: { chatId: chatId === null ? null : String(chatId), characterId: characterId === null ? null : String(characterId), characterAvatar: avatar, groupId: context.groupId === undefined || context.groupId === null ? null : String(context.groupId), provider: source, model: String(model), purpose: 'main' },
        character: character ? { name: character.name ?? '', avatar, ...pick(character, ['description', 'personality', 'scenario', 'first_mes', 'mes_example']), system_prompt: character.data?.system_prompt ?? '', post_history_instructions: character.data?.post_history_instructions ?? '', depthPrompt: safeClone(character.data?.extensions?.depth_prompt ?? null) } : null,
        persona: pick(context.powerUserSettings, PERSONA_FIELDS),
        primaryBook: character?.data?.extensions?.world ?? null,
        extraBooks: safeClone(characterExtra?.extraBooks ?? []),
        globalBooks: safeClone(worldInput?.selectedWorldInfo),
        chatBook: worldInput?.metadataKey ? context.chatMetadata?.[worldInput.metadataKey] ?? null : undefined,
        personaBook: context.powerUserSettings?.persona_description_lorebook ?? null,
        worldSettings: { ...pick(worldSettings, WORLD_FIELDS), currentCharacterLore: characterExtra ? safeClone(characterExtra) : null },
        preset: { id: presetId, name: presetName, prompts: safeClone(settings.prompts), order: safeClone(presetInput?.order), orderStrategy: presetInput?.strategy ?? null, orderCharacterId: presetInput?.characterId ?? null, settings: pick(settings, PRESET_FIELDS), rawMacrosUnexpanded: true },
        extensionSources: sources,
        extensionSettings: { builtinMemory: pick(context.extensionSettings?.memory, MEMORY_FIELDS) },
        coverage: {
            globalBindings: Array.isArray(worldInput?.selectedWorldInfo), worldSettings: !emptyObject(worldSettings),
            metadataKey: typeof worldInput?.metadataKey === 'string' && worldInput.metadataKey.length > 0,
            extraBindings: Array.isArray(charLore) || worldSettings?.world_info && !Object.hasOwn(worldSettings.world_info, 'charLore'),
            persona: !emptyObject(context.powerUserSettings), characterSelected: !!character,
            presetPrompts: Array.isArray(settings.prompts), presetOrder: Array.isArray(presetInput?.order),
        },
    };
}
function snapshotProjection(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    return { ...pick(snapshot, ['activeEntries', 'activationEventSeen', 'activationEvidence', 'budgetTokens', 'scan', 'generation', 'inFlight']), note: 'Prior passive observation only; this scan does not activate entries or assemble a request.' };
}
async function fingerprint(value, cryptoImpl) {
    if (!cryptoImpl?.subtle) return null;
    const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(stableStringify(value)));
    return Array.from(new Uint8Array(digest), v => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Read only books bound to the CURRENT card/chat/persona/global selection.
 * Limits are collection bounds, never expanded prompt budgets. Any truncation blocks optimization.
 * This is an optimistic local snapshot: callers must recapture and compare its revision before applying.
 */
export async function collectCurrentSetup({ context, snapshot = null, loadWorldInfo = context?.loadWorldInfo, readWorldBindings, readPresetOrder, readCurrentContext = () => context, getModel, runtimeVersion = null, bridgeWarnings = [], maxBooks = 64, maxEntries = 20000, maxBytes = 24 * 1024 * 1024, cryptoImpl = globalThis.crypto, signal } = {}) {
    if (!context || typeof context !== 'object') throw new TypeError('A current SillyTavern context is required');
    for (const [name, value] of Object.entries({ maxBooks, maxEntries, maxBytes })) if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`Invalid ${name}`);
    const warnings = safeClone(bridgeWarnings), coverageUnknown = [];
    const mark = (code, { blocking = false, truncated = false, ...detail } = {}) => {
        if (!coverageUnknown.includes(code)) coverageUnknown.push(code);
        warnings.push({ code, severity: blocking ? 'warning' : 'notice', ...detail });
        if (blocking) output.optimizationBlocked = true;
        if (truncated) output.truncated = true;
    };
    const readInputs = async current => {
        const worldInput = typeof readWorldBindings === 'function' ? await readWorldBindings() : null;
        const presetInput = typeof readPresetOrder === 'function' ? await readPresetOrder() : null;
        return selectCurrentSettings(current, worldInput, presetInput, getModel);
    };
    const initial = await readInputs(context);
    const output = {
        schemaVersion: 1, compatibility: { ...BATCH_SCAN_COMPATIBILITY, runtimeVersion, runtimeVersionVerified: runtimeVersion === BATCH_SCAN_COMPATIBILITY.version },
        binding: initial.binding, character: initial.character, persona: initial.persona,
        books: [], worldSettings: initial.worldSettings, preset: initial.preset,
        extensionSources: initial.extensionSources, extensionSettings: initial.extensionSettings, snapshot: snapshotProjection(snapshot),
        counts: { booksExpected: 0, books: 0, booksLoaded: 0, entries: 0, bytes: 0 },
        complete: false, truncated: false, optimizationBlocked: false, coverageUnknown, warnings,
        revision: { algorithm: 'SHA-256', fingerprint: null, scope: 'local-configuration-content-only; not-provider-cache-evidence', requiresRecaptureBeforeApply: true },
    };
    if (context.mainApi && context.mainApi !== 'openai') mark('UNSUPPORTED_MAIN_API', { blocking: true });
    if (runtimeVersion && runtimeVersion !== BATCH_SCAN_COMPATIBILITY.version) mark('RUNTIME_VERSION_NOT_VERIFIED', { blocking: true });
    else if (!runtimeVersion) mark('RUNTIME_VERSION_UNREPORTED');
    for (const [flag, code] of Object.entries({ globalBindings: 'GLOBAL_BINDINGS_UNKNOWN', worldSettings: 'GLOBAL_WORLD_SETTINGS_UNKNOWN', metadataKey: 'CHAT_BOOK_BINDING_UNKNOWN', extraBindings: 'CHARACTER_EXTRA_BINDINGS_UNKNOWN', persona: 'PERSONA_BINDING_UNKNOWN', characterSelected: 'CURRENT_CHARACTER_UNSELECTED', presetPrompts: 'PRESET_PROMPTS_UNKNOWN', presetOrder: 'PRESET_ORDER_UNKNOWN' })) if (!initial.coverage[flag]) mark(code, { blocking: true });
    if (initial.binding.groupId !== null) mark('GROUP_SCOPE_CURRENT_SPEAKER_ONLY');
    if (initial.extensionSources.some(source => source.adapter === null)) mark('THIRD_PARTY_IMPLEMENTATIONS_READ_ONLY');
    const names = new Map();
    const bind = (name, source) => {
        if (name === null || name === undefined || name === '') return;
        if (!safeName(name)) { mark('INVALID_BOOK_BINDING', { blocking: true, bindingSource: source }); return; }
        if (!names.has(name)) names.set(name, []);
        if (!names.get(name).includes(source)) names.get(name).push(source);
    };
    for (const name of initial.globalBooks || []) bind(name, 'global');
    bind(initial.primaryBook, 'character-primary');
    if (!Array.isArray(initial.extraBooks)) mark('INVALID_CHARACTER_EXTRA_BINDINGS', { blocking: true });
    else for (const name of initial.extraBooks) bind(name, 'character-extra');
    bind(initial.chatBook, 'chat'); bind(initial.personaBook, 'persona');
    output.counts.booksExpected = names.size;
    if (names.size > maxBooks) mark('BOOK_COUNT_LIMIT', { blocking: true, truncated: true, limit: maxBooks, observed: names.size });
    output.books = [...names.entries()].slice(0, maxBooks).map(([name, boundBy], i) => ({ id: `book-${i + 1}`, name, boundBy, loaded: false, entries: [], entryKeys: [], options: {} }));
    output.counts.books = output.books.length;
    if (bytes(output) > maxBytes) {
        output.character = null; output.persona = {}; output.preset = { id: initial.preset.id, name: initial.preset.name, prompts: [], order: [], settings: {}, omittedByLimit: true }; output.extensionSources = []; output.extensionSettings = {}; output.snapshot = null;
        mark('SETTINGS_BYTE_LIMIT', { blocking: true, truncated: true, limit: maxBytes });
    }
    if (typeof loadWorldInfo !== 'function' && names.size) mark('WORLD_BOOK_READER_UNAVAILABLE', { blocking: true });
    if (!output.truncated && typeof loadWorldInfo === 'function') {
        for (const book of output.books) {
            if (signal?.aborted) { mark('SCAN_ABORTED', { blocking: true }); break; }
            let data;
            try { data = await loadWorldInfo(book.name); } catch { book.errorCode = 'BOOK_READ_FAILED'; mark('BOOK_READ_FAILED', { blocking: true, bookId: book.id }); continue; }
            if (emptyObject(data) || !data.entries || typeof data.entries !== 'object') { book.errorCode = 'BOOK_MISSING_OR_INVALID'; mark('BOOK_MISSING_OR_INVALID', { blocking: true, bookId: book.id }); continue; }
            const keys = Object.keys(data.entries);
            if (keys.length + output.counts.entries > maxEntries) { book.errorCode = 'ENTRY_COUNT_LIMIT'; mark('ENTRY_COUNT_LIMIT', { blocking: true, truncated: true, limit: maxEntries, observed: keys.length + output.counts.entries }); break; }
            if (keys.some(key => emptyObject(data.entries[key]))) { book.errorCode = 'ENTRY_INVALID'; mark('ENTRY_INVALID', { blocking: true, bookId: book.id }); continue; }
            const candidate = { ...book, loaded: true, entries: keys.map(key => ({ ...safeClone(data.entries[key]), world: book.name })), entryKeys: keys, options: Object.fromEntries(Object.entries(data).filter(([key]) => key !== 'entries').map(([key, value]) => [key, safeClone(value)])) };
            const candidateBytes = bytes(candidate);
            if (bytes(output) + candidateBytes > maxBytes) { book.errorCode = 'BOOK_BYTE_LIMIT'; mark('BOOK_BYTE_LIMIT', { blocking: true, truncated: true, bookId: book.id, limit: maxBytes }); break; }
            Object.assign(book, candidate);
            output.counts.booksLoaded++;
            output.counts.entries += keys.length;
        }
    }
    if (signal?.aborted && !coverageUnknown.includes('SCAN_ABORTED')) mark('SCAN_ABORTED', { blocking: true });
    let final;
    try { final = await readInputs(readCurrentContext() || context); } catch { mark('SETTINGS_RECHECK_FAILED', { blocking: true }); }
    if (final && stableStringify(final) !== stableStringify(initial)) mark('CONCURRENT_CONFIGURATION_CHANGE', { blocking: true });
    const revisionPayload = { binding: output.binding, character: output.character, persona: output.persona, books: output.books, worldSettings: output.worldSettings, preset: output.preset, extensionSources: output.extensionSources, extensionSettings: output.extensionSettings };
    try { output.revision.fingerprint = await fingerprint(revisionPayload, cryptoImpl); } catch { /* Explicitly unknown below. */ }
    if (!output.revision.fingerprint) mark('REVISION_FINGERPRINT_UNAVAILABLE', { blocking: true });
    output.complete = !output.optimizationBlocked && !output.truncated && output.counts.booksLoaded === output.counts.booksExpected;
    const updateBytes = () => { let measured = bytes(output); while (output.counts.bytes !== measured) { output.counts.bytes = measured; measured = bytes(output); } return measured; };
    if (updateBytes() > maxBytes) {
        mark('SNAPSHOT_BYTE_LIMIT', { blocking: true, truncated: true, limit: maxBytes });
        output.complete = false;
        // Include report overhead in the bound; evict entire books, never truncate factual entry text.
        for (const book of [...output.books].reverse()) {
            if (!book.loaded || updateBytes() <= maxBytes) continue;
            output.counts.entries -= book.entries.length;
            output.counts.booksLoaded--;
            book.loaded = false; book.entries = []; book.entryKeys = []; book.options = {}; book.errorCode = 'SNAPSHOT_BYTE_LIMIT';
        }
        output.revision.fingerprint = null;
        if (updateBytes() > maxBytes) throw Object.assign(new RangeError('Scan metadata exceeds maxBytes; no partial configuration may be optimized'), { code: 'SCAN_METADATA_BYTE_LIMIT' });
    }
    updateBytes();
    return output;
}
