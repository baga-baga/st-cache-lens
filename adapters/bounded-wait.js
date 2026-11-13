/** Bounded asynchronous read. Late settlements are ignored; never retries a task. */
export async function boundedWait(task, { timeoutMs = 15000, signal, message = '等待超时，未自动重试。' } = {}) {
    const controller = new AbortController();
    let timer, abort;
    const aborted = () => Object.assign(new Error('操作已停止；未继续发起请求。'), { code: 'LOCAL_OPERATION_ABORTED' });
    try {
        if (signal?.aborted) throw aborted();
        const cancelled = new Promise((_, reject) => {
            abort = () => { controller.abort(); reject(aborted()); };
            signal?.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error(message), { code: 'LOCAL_OPERATION_TIMEOUT' })); }, timeoutMs);
        });
        return await Promise.race([Promise.resolve().then(() => {
            if (controller.signal.aborted) throw aborted();
            return task(controller.signal);
        }), cancelled]);
    } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
    }
}
