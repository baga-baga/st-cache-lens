import test from 'node:test';
import assert from 'node:assert/strict';
import { auditCollectionEvidence, collectionBlockingCodes, collectionIssueMessage } from '../adapters/audit-evidence.js';

const knownEmpty = () => ({
    setup: { complete: true, truncated: false, character: { name: 'PRIVATE_CHARACTER' }, counts: { booksExpected: 0 }, warnings: [], coverageUnknown: [] },
    report: { coverage: { complete: true, collectionComplete: true, truncated: false }, books: [], inventory: { entries: [] }, preset: { prompts: [] }, requestGroups: [] },
});

test('unselected current character is retained as a bounded cause, not interpreted as deleted books', () => {
    const { setup, report } = knownEmpty();
    setup.complete = false; setup.character = null; setup.coverageUnknown = ['CURRENT_CHARACTER_UNSELECTED', 'THIRD_PARTY_IMPLEMENTATIONS_READ_ONLY'];
    report.preset.prompts = Array.from({ length: 87 }, () => ({ content: 'PRIVATE_PRESET' }));
    const evidence = auditCollectionEvidence(report, setup);
    assert.equal(evidence.currentCharacterSelected, false);
    assert.equal(evidence.totals.booksPrepared, 0); assert.equal(evidence.totals.entriesPrepared, 0);
    assert.equal(evidence.totals.presetsPrepared, 87);
    assert.deepEqual(collectionBlockingCodes(evidence), ['CURRENT_CHARACTER_UNSELECTED']);
    assert.match(collectionIssueMessage('CURRENT_CHARACTER_UNSELECTED'), /打开.*角色聊天/);
});

test('unavailable world module and unknown binding coverage stay distinct from unselected character', () => {
    const { setup, report } = knownEmpty();
    setup.complete = false;
    setup.warnings = [{ code: 'WORLD_MODULE_UNAVAILABLE', message: 'PRIVATE_IMPORT_ERROR' }];
    setup.coverageUnknown = ['GLOBAL_BINDINGS_UNKNOWN', 'CHAT_BOOK_BINDING_UNKNOWN'];
    const evidence = auditCollectionEvidence(report, setup);
    assert.equal(evidence.currentCharacterSelected, true);
    assert.deepEqual(collectionBlockingCodes(evidence), ['CHAT_BOOK_BINDING_UNKNOWN', 'GLOBAL_BINDINGS_UNKNOWN', 'WORLD_MODULE_UNAVAILABLE']);
    assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_/);
});

test('known empty book selection and settings-only audit do not require new story calls', () => {
    const { setup, report } = knownEmpty();
    setup.complete = false;
    setup.coverageUnknown = ['RUNTIME_VERSION_UNREPORTED', 'PRESET_ORDER_UNKNOWN', 'THIRD_PARTY_IMPLEMENTATIONS_READ_ONLY', 'GROUP_SCOPE_CURRENT_SPEAKER_ONLY'];
    setup.warnings = [{ code: 'PRESET_MODULE_UNAVAILABLE' }];
    report.requestGroups = [{ requests: Array.from({ length: 27 }, () => ({ bodyObserved: false, text: 'PRIVATE_OLD_RECORD' })) }];
    const evidence = auditCollectionEvidence(report, setup);
    assert.equal(evidence.totals.requestRecords, 27); assert.equal(evidence.totals.requestBodiesObserved, 0);
    assert.deepEqual(collectionBlockingCodes(evidence), []);
});

test('bound book read failure and expected/loaded mismatch stop full audit without exposing names', () => {
    const { setup, report } = knownEmpty();
    setup.complete = false; setup.counts.booksExpected = 2;
    setup.warnings = [{ code: 'BOOK_READ_FAILED', bookId: 'PRIVATE_ID', name: 'PRIVATE_BOOK', apiKey: 'PRIVATE_KEY' }];
    report.books = [{ loaded: true, name: 'PRIVATE_BOOK_1' }, { loaded: false, name: 'PRIVATE_BOOK_2' }];
    const evidence = auditCollectionEvidence(report, setup);
    assert.deepEqual(evidence.totals.booksExpected, 2); assert.equal(evidence.totals.booksPrepared, 2); assert.equal(evidence.totals.booksLoaded, 1);
    assert.deepEqual(collectionBlockingCodes(evidence), ['BOOK_READ_FAILED', 'WORLD_BOOKS_NOT_FULLY_READ']);
    assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_/);
    assert.match(collectionIssueMessage('BOOK_READ_FAILED'), /不代表世界书被删除/);
});

test('unknown untrusted codes become one fixed issue and source objects are not mutated', () => {
    const { setup, report } = knownEmpty();
    setup.complete = false;
    setup.warnings = [{ code: 'SK_SECRET_UPPERCASE', message: 'PRIVATE_STORY', name: 'PRIVATE_BOOK' }, { message: 'PRIVATE_RAW_ERROR' }];
    report.coverage.coverageUnknown = ['https://private.example/key', 'BOOK_READ_FAILED'];
    const original = structuredClone({ report, setup });
    const evidence = auditCollectionEvidence(report, setup);
    assert.deepEqual(evidence.codes, ['BOOK_READ_FAILED', 'UNKNOWN_COLLECTION_ISSUE']);
    assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_|SK_SECRET|private.example/);
    assert.deepEqual({ report, setup }, original);
    assert.equal(collectionIssueMessage('PRIVATE_ERROR'), collectionIssueMessage('UNKNOWN_COLLECTION_ISSUE'));
});

test('missing legacy evidence stays unknown and does not invent a collection failure cause', () => {
    const evidence = auditCollectionEvidence({ coverage: { collectionComplete: false } });
    assert.equal(evidence.collectionComplete, false); assert.equal(evidence.currentCharacterSelected, null);
    assert.deepEqual(evidence.codes, []); assert.ok(Object.values(evidence.totals).every(value => value === null));
    assert.deepEqual(collectionBlockingCodes(evidence), []);
    assert.equal(auditCollectionEvidence().collectionComplete, null);
});

test('truncated scans, missing preset reader and unsupported main API are fixed blocking causes', () => {
    const { setup, report } = knownEmpty();
    setup.truncated = true;
    setup.coverageUnknown = ['UNSUPPORTED_MAIN_API', 'PRESET_PROMPTS_UNKNOWN'];
    setup.warnings = [{ code: 'PRESET_MODULE_UNAVAILABLE' }];
    assert.deepEqual(collectionBlockingCodes(auditCollectionEvidence(report, setup)), ['COLLECTION_TRUNCATED', 'PRESET_PROMPTS_UNKNOWN', 'UNSUPPORTED_MAIN_API']);
});

test('issue collection is bounded and invalid counts never pass through', () => {
    const { setup, report } = knownEmpty();
    setup.warnings = Array.from({ length: 1000 }, (_, i) => ({ code: `PRIVATE_ERROR_${i}` }));
    setup.counts.booksExpected = 'PRIVATE_COUNT'; report.counts = { booksExpected: -1, entries: Infinity };
    delete report.inventory;
    const evidence = auditCollectionEvidence(report, setup);
    assert.equal(evidence.issuesTruncated, true); assert.equal(evidence.codes.length, 2);
    assert.equal(evidence.totals.booksExpected, null); assert.equal(evidence.totals.entriesPrepared, null);
    assert.ok(collectionBlockingCodes(evidence).includes('COLLECTION_ISSUES_TRUNCATED'));
    assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_/);
});

test('request body availability is counted exactly without exposing request contents', () => {
    const { setup, report } = knownEmpty();
    report.requestGroups = [{ requests: [{ bodyObserved: true, body: 'PRIVATE_BODY' }, { bodyObserved: false }] }, { requests: [{ bodyObserved: true }, {}] }];
    const evidence = auditCollectionEvidence(report, setup);
    assert.equal(evidence.totals.requestRecords, 4); assert.equal(evidence.totals.requestBodiesObserved, 2);
    assert.deepEqual(collectionBlockingCodes(evidence), []);
    assert.doesNotMatch(JSON.stringify(evidence), /PRIVATE_BODY/);
});
