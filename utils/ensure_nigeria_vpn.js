const fs = require('fs');
const { spawn } = require('child_process');

const NIGERIA_VPN_GID = 1051;
const STATUS_FILE = '/home/ubuntu/.local/share/protonvpn-nigeria-status.json';
const SERVICE_FILE = '/etc/systemd/system/protonvpn-nigeria-failover.service';

function ensureNigeriaVpn() {
  if (process.platform !== 'linux') return false;
  if (!fs.existsSync(SERVICE_FILE)) return false;

  const currentGid = typeof process.getegid === 'function' ? process.getegid() : null;

  if (currentGid !== NIGERIA_VPN_GID && !process.env.NG_VPN_REEXEC) {
    try {
      const child = spawn(
        'sudo',
        [
          '-E',
          '-n',
          '-u',
          process.env.USER || 'ubuntu',
          '-g',
          'vpn-nigeria',
          'env',
          'NG_VPN_REEXEC=1',
          process.execPath,
          ...process.execArgv,
          ...process.argv.slice(1)
        ],
        { stdio: 'inherit' }
      );

      const forwardSignal = (sig) => {
        try {
          child.kill(sig);
        } catch (e) {}
      };

      process.on('SIGINT', () => forwardSignal('SIGINT'));
      process.on('SIGTERM', () => forwardSignal('SIGTERM'));
      process.on('SIGHUP', () => forwardSignal('SIGHUP'));

      child.on('exit', (code) => {
        process.exit(code ?? 0);
      });

      return true;
    } catch (err) {
      console.warn('[Nigeria VPN] Warning: Could not switch to vpn-nigeria group:', err.message);
    }
  }

  if (!process.env._NG_VPN_LOGGED) {
    process.env._NG_VPN_LOGGED = '1';
    try {
      if (fs.existsSync(STATUS_FILE)) {
        const st = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
        console.log(
          `???? [Nigeria VPN] Bound to ${st.interface || 'ngvpn0'} (GID ${NIGERIA_VPN_GID}) -> Server: ${st.server} (${st.city}) | Exit IP: ${st.exit_ip}`
        );
      } else {
        console.log(`???? [Nigeria VPN] Bound to vpn-nigeria group (GID ${NIGERIA_VPN_GID})`);
      }
    } catch (e) {}
  }

  return false;
}

module.exports = { ensureNigeriaVpn, NIGERIA_VPN_GID, STATUS_FILE };
