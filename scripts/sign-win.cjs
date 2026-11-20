// electron-builder's Windows signing hook (package.json build.win.signtoolOptions.sign): signs each file with the
// Certum cloud certificate when the release workflow has signed in (scripts/certum-login.ps1 sets
// CERTUM_THUMBPRINT and SIGNTOOL). Without them (a local build, or no certificate yet) nothing is signed.
const { execFileSync } = require('node:child_process');

module.exports = async function sign(configuration) {
  const thumb = process.env.CERTUM_THUMBPRINT, signtool = process.env.SIGNTOOL;
  if (!thumb || !signtool) return;
  const file = configuration.path;
  // The time-stamp server is sometimes busy: a few tries.
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync(signtool, ['sign', '/sha1', thumb, '/tr', 'http://time.certum.pl', '/td', 'SHA256', '/fd', 'SHA256', '/d', 'DJAW', file], { stdio: 'inherit' });
      return;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise(r => setTimeout(r, 4000 * attempt));
    }
  }
};
