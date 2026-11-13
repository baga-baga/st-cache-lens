import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCurrentSetup, getSetupInputs, BATCH_SCAN_COMPATIBILITY } from '../adapters/batch-scan.js';

function fixture() {
    const calls = [];
    const context = {
        mainApi: 'openai', characterId: 0, chatId: 'current-chat', groupId: null,
        characters: [
            { name: 'Current', avatar: 'current.card.png', description: 'protected original facts', data: { extensions: { world: 'primary' } } },
            { name: 'Other', avatar: 'other.png', data: { extensions: { world: 'unrelated-card-book' } } },
        ],
        chatMetadata: { world_info: 'chat-book' },
        powerUserSettings: { persona_description: 'current persona', persona_description_lorebook: 'persona-book' },
        extensionPrompts: { '1_memory': { value: 'unchanged historical summary', position: 1, depth: 2, role: 0, scan: false }, unknown_plugin: { value: 'status_current_variables: 5', depth: 1 } },
        extensionSettings: { memory: { promptInterval: 10, source: 'main', prompt: 'Summarize {{words}} words' }, otherPlugin: { apiKey: 'SECRET_PLUGIN_KEY' } },
        chatCompletionSettings: { chat_completion_source: 'claude', claude_model: 'claude-opus-5-5', prompts: [{ identifier: 'fixed', role: 'system', content: '<rules>Keep facts</rules>', injection_position: 0 }], openai_max_context: 200000, openai_max_tokens: 8192, proxy_password: 'SECRET_API_KEY', custom_url: 'https://SECRET_ENDPOINT.invalid', custom_include_headers: 'SECRET_HEADERS' },
        getPresetManager: () => ({ getSelectedPreset: () => 'preset-id', getSelectedPresetName: () => 'Current preset' }),
        getWorldInfoNames: () => { throw new Error('must not enumerate every book'); },
        generate: () => { throw new Error('must not generate'); },
        getWorldInfoPrompt: () => { throw new Error('must not activate lore'); },
    };
    const world = { selectedWorldInfo: ['global', 'primary'], metadataKey: 'world_info', worldInfoSettings: { world_info_depth: 3, world_info_budget: 25, world_info_budget_cap: 60000, world_info_recursive: true, world_info: { charLore: [{ name: 'current.card', extraBooks: ['extra', 'global'] }, { name: 'other', extraBooks: ['unrelated-extra'] }] } } };
    const preset = { order: [{ identifier: 'fixed', enabled: true }], strategy: 'global', characterId: 100001, dummyId: 100001 };
    const data = name => ({ customBookOption: { preserve: true }, entries: { 4: { uid: 4, content: `Facts for ${name}\n\u200b`, constant: false, vectorized: true, key: ['keyword'], order: 100, position: 1, scanDepth: null, probability: 75, group: 'one', preventRecursion: true } } });
    const args = { context, snapshot: { activeEntries: [{ world: 'global', uid: 4, content: 'prior actual source' }], activationEventSeen: true, budgetTokens: 60000, loadedEntries: [{ content: 'DO_NOT_DUPLICATE_LOADED' }] }, readWorldBindings: () => world, readPresetOrder: () => preset, readCurrentContext: () => context, loadWorldInfo: async name => { calls.push(name); return data(name); }, runtimeVersion: '1.19.0' };
    return { context, world, preset, calls, args, data };
}

test('collects only current global/card-extra/chat/persona books, deduplicated with all binding origins', async () => {
    const f = fixture();
    const setup = await collectCurrentSetup(f.args);
    assert.equal(setup.complete, true);
    assert.deepEqual(f.calls, ['global', 'primary', 'extra', 'chat-book', 'persona-book']);
    assert.deepEqual(setup.books.find(book => book.name === 'primary').boundBy, ['global', 'character-primary']);
    assert.deepEqual(setup.books.find(book => book.name === 'global').boundBy, ['global', 'character-extra']);
    assert.equal(setup.counts.entries, 5);
    assert.equal(setup.binding.characterAvatar, 'current.card.png');
    assert.equal(setup.binding.model, 'claude-opus-5-5');
    assert.equal(setup.worldSettings.world_info_budget_cap, 60000);
    assert.equal(JSON.stringify(setup).includes('unrelated-extra'), false);
    assert.equal(JSON.stringify(setup).includes('unrelated-card-book'), false);
    assert.equal(setup.snapshot.loadedEntries, undefined);
});

test('preserves raw entry facts, full native settings and preset order without macro expansion or secret settings', async () => {
    const f = fixture();
    f.context.chatCompletionSettings.prompts[0].content = 'Ignore limits {{getvar::real}} <rules>原始事实</rules>';
    const setup = await collectCurrentSetup(f.args);
    assert.equal(setup.books[0].entries[0].content, 'Facts for global\n\u200b');
    assert.equal(setup.books[0].entries[0].probability, 75);
    assert.equal(setup.books[0].options.customBookOption.preserve, true);
    assert.deepEqual(setup.books[0].entryKeys, ['4']);
    assert.equal(setup.preset.prompts[0].content, f.context.chatCompletionSettings.prompts[0].content);
    assert.deepEqual(setup.preset.order, [{ identifier: 'fixed', enabled: true }]);
    assert.equal(setup.preset.rawMacrosUnexpanded, true);
    assert.equal(JSON.stringify(setup).includes('SECRET'), false);
    assert.equal(setup.extensionSources.find(source => source.key === 'unknown_plugin').adapter, null);
    assert.ok(setup.coverageUnknown.includes('THIRD_PARTY_IMPLEMENTATIONS_READ_ONLY'));
    setup.books[0].entries[0].content = 'local clone edit';
    assert.equal(f.context.chatCompletionSettings.prompts[0].content.includes('原始事实'), true);
});

test('local SHA-256 revision is stable with object key order, changes on any full content change, never claims provider hit', async () => {
    const f = fixture();
    const a = await collectCurrentSetup(f.args), b = await collectCurrentSetup(f.args);
    assert.equal(a.revision.fingerprint, b.revision.fingerprint);
    assert.match(a.revision.fingerprint, /^[a-f0-9]{64}$/);
    assert.match(a.revision.scope, /not-provider-cache-evidence/);
    const c = await collectCurrentSetup({ ...f.args, loadWorldInfo: async name => ({ entries: { 4: { ...f.data(name).entries[4], content: `Changed fact ${name}` } } }) });
    assert.notEqual(a.revision.fingerprint, c.revision.fingerprint);
    assert.equal(a.revision.requiresRecaptureBeforeApply, true);
});

test('book limit aborts before reading any book and visibly blocks partial optimization', async () => {
    const f = fixture();
    const setup = await collectCurrentSetup({ ...f.args, maxBooks: 2 });
    assert.equal(f.calls.length, 0);
    assert.equal(setup.truncated, true);
    assert.equal(setup.complete, false);
    assert.equal(setup.optimizationBlocked, true);
    assert.ok(setup.coverageUnknown.includes('BOOK_COUNT_LIMIT'));
    assert.equal(setup.counts.booksExpected, 5);
});

test('entry and byte limits mark incomplete and never silently accept partial book', async () => {
    const f = fixture();
    const entries = await collectCurrentSetup({ ...f.args, maxEntries: 1 });
    assert.equal(entries.counts.booksLoaded, 1);
    assert.equal(entries.counts.entries, 1);
    assert.equal(entries.complete, false);
    assert.equal(entries.truncated, true);
    assert.ok(entries.coverageUnknown.includes('ENTRY_COUNT_LIMIT'));
    const large = await collectCurrentSetup({ ...f.args, maxBytes: 12000, loadWorldInfo: async () => ({ entries: { 1: { uid: 1, content: 'x'.repeat(20000) } } }) });
    assert.equal(large.counts.booksLoaded, 0);
    assert.equal(large.complete, false);
    assert.ok(large.coverageUnknown.includes('BOOK_BYTE_LIMIT'));
    assert.equal(JSON.stringify(large).includes('x'.repeat(1000)), false);
});

test('missing bound book or public settings does not masquerade as empty complete collection', async () => {
    const f = fixture();
    const missing = await collectCurrentSetup({ ...f.args, loadWorldInfo: async () => null });
    assert.equal(missing.complete, false);
    assert.ok(missing.coverageUnknown.includes('BOOK_MISSING_OR_INVALID'));
    const settings = await collectCurrentSetup({ ...f.args, readWorldBindings: null, readPresetOrder: null });
    assert.equal(settings.complete, false);
    assert.ok(settings.coverageUnknown.includes('GLOBAL_BINDINGS_UNKNOWN'));
    assert.ok(settings.coverageUnknown.includes('PRESET_ORDER_UNKNOWN'));
});

test('mid-scan chat switch or bound settings edit blocks optimization of stale card', async () => {
    const f = fixture();
    const setup = await collectCurrentSetup({ ...f.args, loadWorldInfo: async name => { f.context.chatId = 'another-chat'; f.world.selectedWorldInfo = ['new-global']; return f.data(name); } });
    assert.equal(setup.binding.chatId, 'current-chat');
    assert.equal(setup.complete, false);
    assert.ok(setup.coverageUnknown.includes('CONCURRENT_CONFIGURATION_CHANGE'));
});

test('group scope is only the current speaker and absent speaker blocks one-card application', async () => {
    const f = fixture(); f.context.groupId = 'group-one';
    const current = await collectCurrentSetup(f.args);
    assert.ok(current.coverageUnknown.includes('GROUP_SCOPE_CURRENT_SPEAKER_ONLY'));
    assert.equal(current.complete, true);
    f.context.characterId = undefined;
    const noSpeaker = await collectCurrentSetup(f.args);
    assert.equal(noSpeaker.complete, false);
    assert.ok(noSpeaker.coverageUnknown.includes('CURRENT_CHARACTER_UNSELECTED'));
    assert.equal(f.calls.includes('unrelated-card-book'), false);
});

test('missing crypto or incompatible reported runtime blocks automated use, with readonly diagnostics retained', async () => {
    const f = fixture();
    const noHash = await collectCurrentSetup({ ...f.args, cryptoImpl: null });
    assert.equal(noHash.revision.fingerprint, null);
    assert.equal(noHash.complete, false);
    const other = await collectCurrentSetup({ ...f.args, runtimeVersion: '1.18.0' });
    assert.equal(other.complete, false);
    assert.equal(other.compatibility.runtimeVersionVerified, false);
});

test('abort signal stops remaining reads and explicitly marks incomplete', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    const setup = await collectCurrentSetup({ ...f.args, signal: controller.signal });
    assert.equal(f.calls.length, 0);
    assert.equal(setup.complete, false);
    assert.ok(setup.coverageUnknown.includes('SCAN_ABORTED'));
});

test('lazy public-module bridge uses actual active prompt order identity without initializing or generating', async () => {
    const f = fixture(), imports = [];
    const manager = { configuration: { promptOrder: { strategy: 'global', dummyId: 100001 } }, activeCharacter: { id: 100001 }, getPromptOrderForCharacter: character => { assert.equal(character.id, 100001); return f.preset.order; } };
    const inputs = await getSetupInputs({ context: f.context, getContext: () => f.context, runtimeVersion: '1.19.0', importModule: async path => {
        imports.push(path);
        if (path === '/scripts/world-info.js') return { selected_world_info: f.world.selectedWorldInfo, getWorldInfoSettings: () => f.world.worldInfoSettings, METADATA_KEY: 'world_info', loadWorldInfo: f.args.loadWorldInfo };
        if (path === '/scripts/openai.js') return { promptManager: manager, getChatCompletionModel: () => 'exact-model-id' };
        throw new Error('unexpected import');
    } });
    const setup = await collectCurrentSetup(inputs);
    assert.deepEqual(imports, ['/scripts/world-info.js', '/scripts/openai.js']);
    assert.equal(setup.binding.model, 'exact-model-id');
    assert.equal(setup.preset.orderCharacterId, 100001);
    assert.equal(setup.complete, true);
    assert.equal(BATCH_SCAN_COMPATIBILITY.version, '1.19.0');
});

test('lazy module failure reports unknown binding coverage instead of scanning every available book', async () => {
    const f = fixture();
    f.context.loadWorldInfo = f.args.loadWorldInfo;
    const inputs = await getSetupInputs({ context: f.context, getContext: () => f.context, importModule: async () => { throw new Error('unavailable'); } });
    const setup = await collectCurrentSetup(inputs);
    assert.equal(setup.complete, false);
    assert.ok(setup.warnings.some(w => w.code === 'WORLD_MODULE_UNAVAILABLE'));
    assert.equal(f.calls.includes('unrelated-card-book'), false);
});


test('reported byte count is exact and unsupported generation API cannot authorize batch optimization', async () => {
    const f = fixture();
    const setup = await collectCurrentSetup(f.args);
    assert.equal(setup.counts.bytes, new TextEncoder().encode(JSON.stringify(setup)).byteLength);
    f.context.mainApi = 'textgenerationwebui';
    const unsupported = await collectCurrentSetup(f.args);
    assert.equal(unsupported.complete, false);
    assert.ok(unsupported.coverageUnknown.includes('UNSUPPORTED_MAIN_API'));
});

test('an impossibly small byte bound aborts instead of returning an oversized optimizable snapshot', async () => {
    const f = fixture();
    await assert.rejects(collectCurrentSetup({ ...f.args, maxBytes: 10 }), { code: 'SCAN_METADATA_BYTE_LIMIT' });
});
