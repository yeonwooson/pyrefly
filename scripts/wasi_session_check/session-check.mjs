function expect(condition, message) {
    if (!condition) throw new Error(message);
}

export function checkSession(bridge) {
    const { files, Workspace } = bridge;
    const root = '/tsp-session-check';
    const main = `${root}/main.py`;
    const foo = `${root}/foo.py`;
    const created = `${root}/created.py`;
    const records = [];
    let checks = 0;
    const assert = (condition, message) => {
        checks++;
        expect(condition, message);
    };
    files.write(foo, 'value: int = 1\n');
    files.write(main, 'from foo import value\nvalue\n');
    const session = new Workspace(root);
    session.setFiles([main]);
    const snapshot = () => session.call('typeServer/getSnapshot');
    const params = (path, line, start, end, version) => ({
        arg: { uri: `file://${path}`, range: {
            start: { line, character: start }, end: { line, character: end },
        } },
        snapshot: version,
    });
    const query = (request) => session.call('typeServer/getComputedType', request);
    const classType = (request, name) => {
        const type = query(request);
        assert(type?.kind === 3 && type.declaration?.name === name,
            `Expected ${name} protocol class type, got ${JSON.stringify(type)}`);
        return type;
    };
    const error = (call, code) => {
        let result;
        try {
            call();
        } catch (exception) {
            result = JSON.parse(exception.message);
        }
        assert(result?.code === code && typeof result.message === 'string',
            `Expected protocol error ${code}, got ${JSON.stringify(result)}`);
        return result;
    };
    const v0 = snapshot();
    assert(v0 === 0, 'Initial analysis must not advance the input snapshot');
    const old = params(main, 1, 0, 5, v0);
    classType(old, 'int');
    classType(params(foo, 0, 0, 5, v0), 'int');
    assert(snapshot() === v0, 'Warm repeated queries must retain their snapshot');
    records.push({ step: 'initial', snapshot: v0, class: 'int' });

    files.write(foo, "value: str = 'editor'\n");
    const update = session.call('filesChanged', { modified: [foo] });
    assert(update?.jsonrpc === '2.0' && update.method === 'typeServer/snapshotChanged'
        && update.params.old === v0 && update.params.new === v0 + 1,
    `Wrong protocol snapshot notification: ${JSON.stringify(update)}`);
    const v1 = snapshot();
    const stale = error(() => query(old), -32802);
    classType(params(main, 1, 0, 5, v1), 'str');
    classType(params(foo, 0, 0, 5, v1), 'str');
    assert(snapshot() === v1, 'Queries must not advance the snapshot');
    records.push({ step: 'unsaved import', snapshot: v1, class: 'str', stale });

    assert(session.call('filesChanged', {}) === null, 'Empty event batches should produce no notification');
    assert(snapshot() === v1, 'Empty event batches must be snapshot-stable');
    files.write(foo, 'value: int = 1\n');
    session.call('filesChanged', { modified: [foo] });
    const v2 = snapshot();
    assert(v2 === v1 + 1, 'Restoring the saved baseline should advance input snapshot once');
    classType(params(main, 1, 0, 5, v2), 'int');
    records.push({ step: 'discard unsaved', snapshot: v2, class: 'int' });

    files.write(main, 'from created import value\nvalue\n');
    session.call('filesChanged', { modified: [main] });
    const beforeCreate = snapshot();
    const unknown = query(params(main, 1, 0, 5, beforeCreate));
    assert(unknown?.kind !== 3, 'A missing import must not return an int class');
    files.write(created, 'value: int = 3\n');
    session.call('filesChanged', { created: [created] });
    const afterCreate = snapshot();
    assert(afterCreate === beforeCreate + 1, 'Created file should advance the snapshot');
    classType(params(main, 1, 0, 5, afterCreate), 'int');
    error(() => query(params(main, 1, 0, 5, beforeCreate)), -32802);
    records.push({ step: 'new unsaved import', snapshot: afterCreate, class: 'int' });
    files.remove(created);
    session.call('filesChanged', { removed: [created] });
    const afterRemove = snapshot();
    assert(query(params(main, 1, 0, 5, afterRemove))?.kind !== 3,
        'Removed import must not retain its old class type');
    records.push({ step: 'removed import', snapshot: afterRemove });

    files.write(foo, "def build() -> str:\n    return 'value'\n");
    files.write(main, 'from foo import build\nbuild\nbuild()\n');
    session.call('filesChanged', { modified: [foo, main] });
    const functionSnapshot = snapshot();
    const type = query(params(main, 1, 0, 5, functionSnapshot));
    assert(type?.kind === 2 && type.declaration?.name === 'build',
        `Expected a real function declaration: ${JSON.stringify(type)}`);
    assert(type.declaration.node.uri === `file://${foo}`
        && type.declaration.node.range.start.line === 0
        && type.declaration.node.range.start.character === 4
        && type.declaration.node.range.end.character === 9,
    'The warm transaction converter must preserve the imported function source range');
    classType(params(main, 2, 0, 7, functionSnapshot), 'str');
    assert(snapshot() === functionSnapshot, 'Declaration conversion must be snapshot-stable');
    records.push({ step: 'function and call', snapshot: functionSnapshot, declaration: type.declaration });

    error(() => query(params(main, 99, 0, 0, functionSnapshot)), -32602);
    error(() => query(params(main, 1, 5, 0, functionSnapshot)), -32602);
    error(() => session.call('filesChanged', { modified: ['relative.py'] }), -32602);
    error(() => session.call('unsupportedMethod'), -32602);
    assert(snapshot() === functionSnapshot, 'Invalid inputs must not advance snapshot');
    classType(params(main, 2, 0, 7, functionSnapshot), 'str');
    session.call('dispose');
    error(() => snapshot(), -32602);
    return {
        status: 'PASS',
        checks,
        records,
        source: 'actual FilesystemSession + shared converter + PR5565 host filesystem',
        staleRequestCheckedThroughWasmAbi: true,
        protocolTypesAndErrorsUsed: true,
        fullPylanceIntegration: false,
        adapter: 'local validation ABI, not proposed production transport',
    };
}
