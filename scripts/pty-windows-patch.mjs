// node-pty 1.1.0: enumerate the console before closing its native handle.
// Applied at install/build time, including cross-platform packaging; never at app runtime.
export function patchWindowsPty(agent, helper) {
  const replace = (source, before, after) => {
    if (source.includes(after)) return source
    if (source.split(before).length !== 2)
      throw new Error('node-pty Windows cleanup target changed; review upstream before updating')
    return source.replace(before, after)
  }
  agent = replace(
    agent,
    '        // Tell the agent to kill the pty, this releases handles to the process',
    `        // GGTerm: cleanup is idempotent while console enumeration is pending.
        if (this._ggtermKillRequested) return;
        this._ggtermKillRequested = true;
        // Tell the agent to kill the pty, this releases handles to the process`
  )
  agent = replace(
    agent,
    `                });
                this._ptyNative.kill(this._pty, this._useConptyDll);
                this._conoutSocketWorker.dispose();`,
    `                    // Enumeration has finished: the helper no longer needs the console.
                    try {
                        _this._ptyNative.kill(_this._pty, _this._useConptyDll);
                    } finally {
                        _this._conoutSocketWorker.dispose();
                    }
                }).catch(function (error) {
                    console.error('node-pty console cleanup failed:', error);
                });`
  )
  agent = replace(
    agent,
    `            var agent = child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()]);
            agent.on('message', function (message) {
                clearTimeout(timeout);
                resolve(message.consoleProcessList);
            });
            var timeout = setTimeout(function () {
                // Something went wrong, just send back the shell PID
                agent.kill();
                resolve([_this._innerPid]);
            }, 5000);`,
    `            var agent;
            var settled = false;
            var timeout;
            var finish = function (pids) {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                resolve(pids);
            };
            try {
                agent = child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()], { windowsHide: true });
                agent.once('message', function (message) {
                    var pids = message && message.consoleProcessList;
                    finish(Array.isArray(pids) && pids.every(function (pid) {
                        return Number.isInteger(pid) && pid > 0;
                    }) ? pids : [_this._innerPid]);
                });
                agent.once('error', function (error) {
                    console.error('node-pty console enumeration failed:', error);
                    finish([_this._innerPid]);
                });
                agent.once('exit', function () { finish([_this._innerPid]); });
                timeout = setTimeout(function () {
                    finish([_this._innerPid]);
                    agent.kill();
                }, 5000);
            } catch (error) {
                console.error('node-pty console enumeration failed:', error);
                finish([_this._innerPid]);
            }`
  )
  helper = replace(
    helper,
    `var consoleProcessList = getConsoleProcessList(shellPid);
process.send({ consoleProcessList: consoleProcessList });
process.exit(0);`,
    `var consoleProcessList;
try {
    consoleProcessList = getConsoleProcessList(shellPid);
} catch (error) {
    // Natural shell exit can still race enumeration. Only suppress a verified gone PID.
    if (!/AttachConsole failed/.test(String(error))) throw error;
    try {
        process.kill(shellPid, 0);
    } catch (probeError) {
        if (probeError.code === 'ESRCH') consoleProcessList = [];
        else throw error;
    }
    if (!consoleProcessList) throw error;
}
process.send({ consoleProcessList: consoleProcessList }, function () { process.exit(0); });`
  )
  return { agent, helper }
}
