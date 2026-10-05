import { fetchStyleGuide, saveStyleGuide } from '../api.js';
const clone = value => structuredClone(value);
export function createGuideState({ fetchGuide = fetchStyleGuide, saveGuide = saveStyleGuide, debounce = 800 } = {}) {
    const listeners = new Set();
    let config = null, meta = {}, path = null, status = 'loading', error = null;
    let version = 0, savedVersion = 0, timer = null, pending = null, generation = 0, busy = false;
    const notify = type => listeners.forEach(fn => fn(type));
    const cancel = () => { clearTimeout(timer); timer = null; };
    const state = {
        get config() { return config; }, get meta() { return meta; }, get projectPath() { return path; },
        get status() { return status; }, get error() { return error; }, get dirty() { return version !== savedVersion; }, get busy() { return busy; },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
        get(keys) { return keys.split('.').reduce((v, k) => v?.[k], config); },
        set(keys, value) { if (!config || busy)
            return; const parts = keys.split('.'); const last = parts.pop(); let target = config; for (const key of parts)
            target = target[key]; target[last] = value; state.touch(); },
        touch() { if (!config || busy)
            return; version++; status = 'dirty'; error = null; notify('edit'); cancel(); timer = setTimeout(() => state.flush().catch(() => { }), debounce); },
        async load(projectPath) {
            await state.flush();
            const seq = ++generation;
            busy = true;
            status = 'loading';
            notify('status');
            try {
                const data = await fetchGuide(projectPath);
                if (seq !== generation)
                    return;
                path = projectPath;
                config = clone(data.config);
                meta = data;
                version = savedVersion = 0;
                error = null;
                status = data.saved ? 'saved' : 'defaults';
                notify('load');
            }
            catch (e) {
                error = e;
                status = 'error';
                notify('status');
                throw e;
            }
            finally {
                if (seq === generation) {
                    busy = false;
                    notify('status');
                }
            }
        },
        async flush({ force = false, source = 'ui' } = {}) {
            cancel();
            if (pending) {
                await pending;
                if (state.dirty)
                    return state.flush({ source });
                return;
            }
            if (!config || (!state.dirty && !force))
                return;
            const seq = generation, projectPath = path, snapshot = clone(config), at = version;
            status = 'saving';
            error = null;
            notify('status');
            pending = (async () => {
                try {
                    const data = await saveGuide(projectPath, snapshot, { source });
                    if (seq !== generation)
                        return;
                    meta = data;
                    savedVersion = at;
                    // Never replace fields typed while a request was in flight.
                    if (version === at)
                        config = clone(data.config);
                    else {
                        config.revision = data.revision;
                        config.updatedAt = data.config.updatedAt;
                    }
                    status = state.dirty ? 'dirty' : 'saved';
                    notify('saved');
                }
                catch (e) {
                    if (seq === generation) {
                        status = 'error';
                        error = e;
                        notify('status');
                    }
                    throw e;
                }
                finally {
                    pending = null;
                }
            })();
            await pending;
            if (state.dirty && seq === generation)
                await state.flush({ source });
        },
        // Serialize server-side actions after autosave and freeze fields while they replace config.
        async action(fn) {
            await state.flush();
            busy = true;
            notify('status');
            try {
                const data = await fn(path);
                if (data?.config) {
                    config = clone(data.config);
                    meta = { ...meta, ...data };
                    version = savedVersion = 0;
                    status = 'saved';
                    notify('load');
                }
                else if (data) {
                    meta = { ...meta, ...data };
                    notify('saved');
                }
                return data;
            }
            catch (e) {
                error = e;
                status = 'error';
                notify('status');
                throw e;
            }
            finally {
                busy = false;
                notify('status');
            }
        },
        async apply(configToApply, source = 'ui') { await state.flush(); config = clone(configToApply); state.touch(); await state.flush({ source }); notify('load'); },
        destroy() { cancel(); generation++; listeners.clear(); },
    };
    return state;
}
