import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// A PM2 worker and a dashboard child are two owners of the same executor.
// Resolve the owner before every action; never stop an arbitrary heartbeat PID.
export function createExecutorController(root, deps = {}) {
    const run = deps.run || promisify(execFile);
    const readLive = deps.readLive || (() => {
        try { return JSON.parse(fs.readFileSync(path.join(root, 'data/executor_live_status.json'), 'utf8')); }
        catch { return {}; }
    });
    let cached, inflight, expires = 0;
    async function managed(force = false) {
        if (process.platform !== 'linux' && !deps.run) return null;
        if (!force && cached !== undefined && Date.now() < expires) return cached;
        if (inflight) return inflight;
        inflight = (async () => {
            let list;
            try { list = JSON.parse((await run('pm2', ['jlist'], { timeout: 6000, maxBuffer: 8 * 1024 * 1024, windowsHide: true })).stdout); }
            catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Unable to verify PM2 executor status'); }
            const result = list.find(p => {
                const env = p.pm2_env || {};
                return path.resolve(env.pm_cwd || '/') === path.resolve(root) &&
                    ['sportybet_executor.js', 'bet_executor.js'].some(file => path.resolve(env.pm_exec_path || '/') === path.join(path.resolve(root), file));
            }) || null;
            cached = result; expires = Date.now() + 1000;
            return result;
        })();
        try { return await inflight; } finally { inflight = null; }
    }
    const stopped = { running: false, platform: null, profileId: null, startTime: null, pid: null, owner: null };
    async function status(child = null, force = false) {
        const live = readLive();
        const pm = await managed(force);
        if (pm) {
            const running = pm.pm2_env.status === 'online' && Number(pm.pid) > 0;
            return { ...stopped, running, owner: 'pm2', managerId: pm.pm_id,
                platform: path.basename(pm.pm2_env.pm_exec_path) === 'sportybet_executor.js' ? 'sportybet' : '1xbet',
                pid: running ? pm.pid : null, profileId: live.profileId || null,
                startTime: running ? new Date(pm.pm2_env.pm_uptime).toISOString() : null };
        }
        if (child && child.pid && child.exitCode == null && !child.killed) {
            return { ...stopped, running: true, owner: 'dashboard', pid: child.pid, platform: live.platform || null, profileId: live.profileId || null };
        }
        return { ...stopped };
    }
    async function stop(child = null) {
        const current = await status(child, true);
        if (!current.running) return { success: true, alreadyStopped: true, status: current };
        if (current.owner === 'pm2') {
            await run('pm2', ['stop', String(current.managerId)], { timeout: 15000, windowsHide: true });
            cached = undefined;
        } else {
            if (process.platform === 'win32') await run('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 15000, windowsHide: true });
            else {
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error('Executor has not exited yet')), 12000);
                    child.once('exit', () => { clearTimeout(timer); resolve(); });
                    try { child.kill('SIGTERM'); } catch (e) { clearTimeout(timer); reject(e); }
                });
            }
        }
        const after = await status(null, true);
        if (after.running) throw new Error('Executor is still running');
        return { success: true, status: after };
    }
    async function startManaged(platform) {
        const current = await status(null, true);
        if (current.running) return { success: false, error: 'Executor is already running.', status: current };
        if (current.owner !== 'pm2' || current.platform !== platform) return null;
        await run('pm2', ['restart', String(current.managerId)], { timeout: 15000, windowsHide: true });
        cached = undefined;
        const after = await status(null, true);
        return { success: after.running, error: after.running ? undefined : 'Executor did not start.', status: after };
    }
    return { status, stop, startManaged, readLive };
}
